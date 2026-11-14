#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the image to test}
expected_version=${2:-}
container="gift-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
# The test uses disposable container storage and synthetic settings, never household data.
docker run --detach --name "$container" \
  --env ORIGIN=http://localhost:3000 \
  --env BETTER_AUTH_SECRET=container-smoke-test-only-not-a-real-secret \
  --env GOOGLE_CLIENT_ID=container-smoke.apps.googleusercontent.com \
  --env GOOGLE_CLIENT_SECRET=container-smoke-placeholder \
  --env ADMINISTRATOR_EMAIL=smoke@example.org \
  "$image"
for attempt in {1..30}; do
  if docker exec "$container" node --input-type=module -e \
    'const r = await fetch("http://localhost:3000/health/ready"); if (!r.ok) process.exit(1)' >/dev/null 2>&1; then
    docker exec "$container" node --input-type=module -e \
      'import { readFileSync } from "node:fs"; const p = JSON.parse(readFileSync("package.json")); if (!p.version || (process.argv[1] && p.version !== process.argv[1]) || !readFileSync("LICENSE", "utf8").includes("MIT License")) process.exit(1); console.log(`Container running: ${p.version}`);' "$expected_version"
    exit 0
  fi
  sleep 2
done
docker logs "$container"
exit 1
