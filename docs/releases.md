# Releases and automation

Open a pull request into `main`. Use a Conventional Commit title, such as `fix: preserve the saved photo` or `feat: share a gift list`. The squash title determines the release version. No release ticket, version-bump commit or release PR is needed.

The required **Lint and tests** job checks the title, scans the entire Git history with Gitleaks, validates workflow syntax, checks types and formatting, runs the unit, integration and Chromium browser suites, validates the source/release Compose configurations, and builds and starts the Docker container. The same job runs again on `main` before publication. Neither tests nor builds need real sign-in or provider secrets.

Branch protection on `main` applies to administrators too. Changes require a PR, the current checks must pass against an up-to-date base, review conversations must be resolved, and linear history is enforced. Required human approvals are `0` because this is maintained by one owner and automated dependency PRs merge without manual intervention once checks pass. Only squash merges are enabled.

## Dependency updates and automated repair

[Renovate](../renovate.json) runs daily at 03:17 UTC via `.github/workflows/renovate.yml` (and after PR merges while Renovate PRs remain open) using a short-lived GitHub App installation token (`AUTOPATCH_APP_CLIENT_ID` / `AUTOPATCH_APP_PRIVATE_KEY` with repository permissions `Actions: Read`, `Checks: Read`, `Contents: Read & write`, `Issues: Read & write`, `Metadata: Read`, `Pull requests: Read & write`, `Vulnerability alerts: Read-only`, and `Workflows: Read & write`):

- **Security advisories**: GitHub Vulnerability Alerts and OSV alerts open `fix(deps): ...` PRs immediately with no release-age cooldown.
- **Routine bumps**: npm dependencies, GitHub Actions SHAs, Docker base image digests and Node runtime pins are grouped and scheduled weekly on Monday mornings (`before 8am on monday`, `Europe/London`) after a 3-day release-age cooldown.
- **Auto-merge**: passing Renovate PRs enable GitHub squash auto-merge automatically.
- **Agentic repair**: when `Application checks` fails on a Renovate PR, `.github/workflows/dep-repair.yml` runs Gemini CLI (`GEMINI_API_KEY`, optional `REPAIR_GEMINI_MODEL` variable) to patch compatible source, test, lockfile or container fixes on allowlisted paths, verifies `npm run verify` (and Compose/container smoke checks when relevant), and pushes up to 2 repair commits using the GitHub App token so CI re-runs and auto-merges cleanly.

## Automatic versions

The first release is `v0.1.0`. For later releases, all squash commits since the previous version are considered:

| Commit                                                     | Version change                   |
| ---------------------------------------------------------- | -------------------------------- |
| `feat: ...` or `feat(scope): ...`                          | Minor, such as `0.1.2` → `0.2.0` |
| A `!` after the type/scope, or a `BREAKING CHANGE:` footer | Major, such as `0.2.0` → `1.0.0` |
| Everything else, including documentation and CI            | Patch, such as `0.1.0` → `0.1.1` |

The largest change wins. Tags are the version source of truth; the source package version is only a development placeholder. The release version is injected into the container's package metadata and OCI labels. Existing releases are skipped on re-run. Every Monday at 03:23 UTC (or on manual dispatch with `rebuild_os`), the release workflow also builds without cache to pull upstream base image and Debian `apt` security fixes; if the base image digest or installed packages changed from `:latest`, it re-runs checks and publishes a new patch release (such as `0.2.0` → `0.2.1`) before updating tags. Publication failures can be retried from Actions without another commit. A failed publication may leave an image without a GitHub release; the retry uses the same version. Published version tags must never be moved or deleted.

Publication is serialised and is not cancelled mid-push. If several changes merge quickly, a queued run may be replaced by the newest run; that release includes every unreleased commit. Runs for an outdated `main` commit skip publication.

## Container image

For the prebuilt Compose option, follow [Start from a published image](deployment.md#start-from-a-published-image-amd64). It pins one version for both app and worker and retains the existing data volume.

Images are published to `ghcr.io/marengaz/gift-registry` with `0.1.0`, `v0.1.0`, `sha-<full commit>` and `latest` style tags. Pin a numbered version or digest for home deployments. `latest` moves with each successful publication; it does not update a running container automatically. The same image starts the web app or, with `node build-worker/worker.js`, the worker. Keep their versions aligned and back up the data volume before upgrading.

Before tagging `latest` or creating the GitHub release, publication pushes by digest, pulls that digest, starts the container, checks readiness, and verifies its package version, architecture and base-digest/revision/version labels.

The initial target is **Linux AMD64**, for an Intel/AMD home server. ARM64 is not yet built. The final image includes the MIT licence and source, revision, version and base-digest labels. Builds publish provenance and software-bill-of-materials attestations.

## Usage and costs

The repository is public. Workflows use standard `ubuntu-24.04` runners, with no larger runners or matrices. Schedules run once daily for Renovate vulnerability/rebase checks and once weekly for OS package rebuild checks (skipping full CI and publishing when nothing changed). PR updates cancel superseded checks. Branch pushes do not duplicate PR checks. Main checks are repeated deliberately before every release. Each job has a 20-minute timeout.

[Standard runners for public repositories are free](https://docs.github.com/en/billing/concepts/product-billing/github-actions). [GitHub Container Registry storage and bandwidth are currently free](https://docs.github.com/en/billing/concepts/product-billing/github-packages). These terms can change. npm and minimal Docker build caches are the only deliberate caches; no test reports or application data are uploaded as artifacts. The publish action's automatic build-record upload is disabled. All Actions are pinned to commit hashes, with no long-lived personal access tokens: publication uses `GITHUB_TOKEN`, and Renovate/repair mint short-lived GitHub App installation tokens.

## Recover a failed release

Check the failed job before retrying. Fix a code or check failure through a PR. For a temporary registry or API outage, re-run the failed workflow in **Actions → Release**. A published GitHub release causes publication to be skipped. Do not manually bump `package.json`, force a version tag, or bypass branch protection.
