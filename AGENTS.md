# Project Guidelines & Workflow (`AGENTS.md`)

## Development Workflow

- **Branching:** Always develop new features and fixes on a dedicated feature branch (never directly on `main`).
- **Commits:** Commit at suitable milestones using pragmatic [Conventional Commits](https://www.conventionalcommits.org/) messages (e.g. `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`). PR titles must also pass `node scripts/release.mjs title`.
- **Verification before pushing:** Run the full test and check suite (`npm run verify`) before pushing code to GitHub.
- **Pull requests:** Target the default branch (`main`). PR stacks may be used when it is helpful to break larger problems into deliverable chunks.
- **Visual evidence on PRs:** When opening a PR, include screenshot(s) or a GIF of the created or changed features in the PR description so reviewers can see how it works and what it looks like.
- **Adversarial PR review loop:** Spin up independent subagent(s) to adversarially review the PR and iterate back and forth until the reviewer approves, or for up to 5 rounds, whichever comes first.
- **Merge readiness & handoff:** Ensure the PR is ready to merge (all CI checks passed, review conversations resolved, etc.) before handing back to the user.
- **No auto-merge:** You may review any PR on the user's behalf, but **do not merge**. The user always merges manually.
