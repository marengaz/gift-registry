# Releases and automation

Open a pull request into `main`. Use a Conventional Commit title, such as `fix: preserve the saved photo` or `feat: share a gift list`. The squash title determines the release version. No release ticket, version-bump commit or release PR is needed.

The required **Lint and tests** job checks the title, scans the entire Git history with Gitleaks, validates workflow syntax, checks types and formatting, runs the unit, integration and Chromium browser suites, validates the source/release Compose configurations, and builds and starts the Docker container. The same job runs again on `main` before publication. Neither tests nor builds need real sign-in or provider secrets.

Branch protection applies to administrators too. Changes require a PR, the current checks must pass against an up-to-date base, and review conversations must be resolved. A second person's approval is optional because this is maintained by one owner. Only squash merges are enabled.

## Automatic versions

The first release is `v0.1.0`. For later releases, all squash commits since the previous version are considered:

| Commit                                                     | Version change                   |
| ---------------------------------------------------------- | -------------------------------- |
| `feat: ...` or `feat(scope): ...`                          | Minor, such as `0.1.2` → `0.2.0` |
| A `!` after the type/scope, or a `BREAKING CHANGE:` footer | Major, such as `0.2.0` → `1.0.0` |
| Everything else, including documentation and CI            | Patch, such as `0.1.0` → `0.1.1` |

The largest change wins. Tags are the version source of truth; the source package version is only a development placeholder. The release version is injected into the container's package metadata and OCI labels. Existing releases are skipped on re-run. Publication failures can be retried from Actions without another commit. A failed publication may leave an image without a GitHub release; the retry uses the same version. Published version tags must never be moved or deleted.

Publication is serialised and is not cancelled mid-push. If several changes merge quickly, a queued run may be replaced by the newest run; that release includes every unreleased commit. Runs for an outdated `main` commit skip publication.

## Container image

For the prebuilt Compose option, follow [Start from a published image](deployment.md#start-from-a-published-image-amd64). It pins one version for both app and worker and retains the existing data volume.

Images are published to `ghcr.io/marengaz/gift-registry` with `0.1.0`, `v0.1.0`, `sha-<full commit>` and `latest` style tags. Pin a numbered version or digest for home deployments. `latest` moves with each successful publication; it does not update a running container automatically. The same image starts the web app or, with `node build-worker/worker.js`, the worker. Keep their versions aligned and back up the data volume before upgrading.

Before creating the GitHub release, publication pulls the pushed image by digest, starts it, checks readiness, and verifies its package version, architecture and revision/version labels.

The initial target is **Linux AMD64**, for an Intel/AMD home server. ARM64 is not yet built. The final image includes the MIT licence and source, revision and version labels. Builds publish provenance and software-bill-of-materials attestations.

## Usage and costs

The repository is public. Workflows use standard `ubuntu-24.04` runners, with one check job and one publish job; there are no larger runners, matrices or schedules. PR updates cancel superseded checks. Branch pushes do not duplicate PR checks. Main checks are repeated deliberately before every release. Each job has a 20-minute timeout.

[Standard runners for public repositories are free](https://docs.github.com/en/billing/concepts/product-billing/github-actions). [GitHub Container Registry storage and bandwidth are currently free](https://docs.github.com/en/billing/concepts/product-billing/github-packages). These terms can change. npm and minimal Docker build caches are the only deliberate caches; no test reports or application data are uploaded as artifacts. The publish action's automatic build-record upload is disabled. All Actions are pinned to commit hashes, with no long-lived publication token: the workflow uses its scoped `GITHUB_TOKEN`.

## Recover a failed release

Check the failed job before retrying. Fix a code or check failure through a PR. For a temporary registry or API outage, re-run the failed workflow in **Actions → Release**. A published GitHub release causes publication to be skipped. Do not manually bump `package.json`, force a version tag, or bypass branch protection.
