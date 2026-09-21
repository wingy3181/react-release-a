# Release train POC

This POC implements the agreed release policy using shell entry points, the **Nx CLI** for versioning/affected projects, and Git for branch/commit/tag operations. No Nx Release programmatic API is used. Shop represents eBanking; API represents NTB; `packages/shared/models` is their shared library.

Initialize explicitly in either a disposable clone or this checkout. **In-place mode creates and pushes real commits, branches, and tags to the exact origin you select**, including deleting release branches on closure. Production deployment remains mocked, and PR merges are still simulated Git rebase/fast-forward operations (not real GitHub reviews). GitHub Actions continues to run isolated scenarios against a local bare remote.

## Use this workspace and GitHub

Commit the implementation changes and push `main` before initializing. The working tree must be clean, on `main`, and at the same commit as remote `main`.

```bash
# Preview only: no refs, manifests, commits, or pushes are changed.
bash tools/release/simulation/setup.sh --in-place \
  --remote git@github.com:wingy3181/react-release-a.git --dry-run

# Initialize this checkout and push baseline tags + development snapshots.
bash tools/release/simulation/setup.sh --in-place \
  --remote git@github.com:wingy3181/react-release-a.git

bash tools/release/simulation/status.sh
```

Initial app versions represent mock production. With the example's `0.0.1` baselines, initialization tags `@org/shop@0.0.1` and `@org/api@0.0.1`, then commits/pushes `0.1.0-snapshot.0` for both apps on main via Nx. It keeps your Git author/signing configuration. State and mock production live under `.git/release-poc/` and are not committed or pushed. Subsequent commands reject a changed fetch or push URL. Re-running completed setup is a no-op; interrupted setup can resume its saved version plan, provided unrelated working-tree changes are not introduced.

This is a single-checkout POC: other clones/runners cannot reconstruct the operation journal automatically. In-place simulated PR merges push directly to main, so repository rules requiring actual PR approval would reject them. Use a test repository where that behavior is acceptable; a real PR adapter remains future work.

## Quick start

Prerequisites: Git, Bash, Node 24+, and the workspace's installed npm dependencies (`npm ci`). From the original workspace:

```bash
bash tools/release/simulation/setup.sh
# Copy the POC_WORKSPACE path printed at the end:
cd /path/printed/by/setup/work
bash tools/release/simulation/status.sh
```

Setup creates a temporary clone and a **local bare origin**, copies the current POC scripts/config into it, seeds production tags/manifests from the existing app versions, and advances main to initial minor snapshots via Nx. It does not modify the source repository's branches, tags, index, or app versions. Installed dependencies are copied without a network install (copy-on-write where available), preserving npm's relative workspace links so builds use the sandbox's libraries. Each sandbox requires approximately the size of `node_modules` plus its artifacts. Sandbox directories are retained for inspection; no automatic destructive cleanup is performed.

Run all automated scenarios from the original workspace:

```bash
bash tools/release/simulation/run-scenarios.sh
# Exercise in-place mode against a fresh LOCAL test remote (not your GitHub repo):
bash tools/release/simulation/run-scenarios.sh --in-place
# Also run actual application builds in each candidate checkout:
RELEASE_POC_REAL_BUILD=1 bash tools/release/simulation/run-scenarios.sh
```

The default simulator creates explicitly marked mock artifact records. `RELEASE_POC_REAL_BUILD=1` runs Nx builds, archives each app's output, and records/verifies its SHA-256 checksum before successful simulated deployment. Retries reuse the retained archive. Registry publishing and real deployment are not implemented. Mock-mode identifiers are candidate identifiers, **not checksums of compiled output**.

## Scripts and arguments

All commands below run inside the initialized checkout (disposable or in-place). Project arguments are `shop` or `api`. App Git tags use actual project names, e.g. `@org/api@0.1.1`.

| Script                        | Arguments and responsibility                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `train/cut.sh`                | `yyyy.mm.nn`: enforce one open normal train; compare each app's deployed source to main's fixed cutoff; patch selected apps, commit, tag, push                  |
| `train/cherry-pick.sh`        | `release/yyyy.mm.nn operation-id sha [sha ...]`: apply the ordered commits of a merged PR, then bump each affected app once                                     |
| `train/close.sh`              | `release/yyyy.mm.nn`: verify production; create train tag and snapshot bookkeeping branch; run again after its simulated PR merges to delete the release branch |
| `hotfix/cut.sh`               | `shop\|api identifier`: create one app-specific hotfix from its deployed app tag                                                                                |
| `hotfix/cherry-pick.sh`       | `hotfix/app/identifier operation-id sha [sha ...]`: apply code and prepare an app candidate; reject unexpected cross-app impact                                 |
| `hotfix/close.sh`             | `hotfix/app/identifier`: verify deployment and propagation to open trains, then delete branch; no snapshot advance                                              |
| `deployment/verify.sh`        | `release-or-hotfix-branch`: compare expected versions and source SHAs with mock production                                                                      |
| `simulation/change.sh`        | `shop\|api\|both\|shared feature-name`: create/push a real feature branch with independent synthetic source files                                               |
| `simulation/merge-pr.sh`      | `feature/name` or `bookkeeping/train-id`: rebase onto main, fast-forward main, print the resulting ordered commit SHAs                                          |
| `simulation/deploy.sh`        | `release-or-hotfix-branch shop\|api [success\|fail]`: build/record candidate and update mock production, or simulate failure without changing production        |
| `simulation/status.sh`        | Display operation state and production manifest                                                                                                                 |
| `simulation/run-scenarios.sh` | Create a fresh sandbox and exercise four trains, dynamic membership, failures, retries, and a production hotfix                                                 |

## Walkthrough: both apps, then an API-only cherry-pick

```bash
bash tools/release/simulation/change.sh both first-feature
bash tools/release/simulation/merge-pr.sh feature/first-feature
bash tools/release/train/cut.sh 2026.09.01
bash tools/release/simulation/deploy.sh release/2026.09.01 shop

bash tools/release/simulation/change.sh api payment-fix
bash tools/release/simulation/merge-pr.sh feature/payment-fix
# Use the SHA(s) printed by merge-pr, in that order:
bash tools/release/train/cherry-pick.sh release/2026.09.01 pr-payment-fix MERGED_SHA
bash tools/release/simulation/deploy.sh release/2026.09.01 api
bash tools/release/deployment/verify.sh release/2026.09.01

bash tools/release/train/close.sh release/2026.09.01
bash tools/release/simulation/merge-pr.sh bookkeeping/2026.09.01
bash tools/release/train/close.sh release/2026.09.01
```

Re-running a completed cherry-pick with the same operation ID and SHA list is a no-op. Reusing the ID with different commits is rejected. Re-running close is also a no-op after closure. Deployment failure is simulated with a trailing `fail`; retry `success` without another bump.

## Hotfix during an open train

```bash
bash tools/release/hotfix/cut.sh api payment-urgent
bash tools/release/simulation/change.sh api urgent-fix
bash tools/release/simulation/merge-pr.sh feature/urgent-fix
bash tools/release/hotfix/cherry-pick.sh hotfix/api/payment-urgent pr-urgent MERGED_SHA
bash tools/release/simulation/deploy.sh hotfix/api/payment-urgent api
bash tools/release/train/cherry-pick.sh release/2026.09.02 pr-urgent MERGED_SHA
bash tools/release/hotfix/close.sh hotfix/api/payment-urgent
```

Normal deployment of that app is blocked while its hotfix is open. Other apps may deploy. A second hotfix for the same app is rejected. Version allocation skips existing candidate tags, including versions consumed by failed candidates. Hotfix closure checks ancestry or stable patch identity for the fix in the active train. An adapted backport with different patch content requires review; this POC deliberately fails closed rather than guessing equivalence.

## Change detection

For each app, read its version/tag from mock production. Directly compare that tag's file tree with the fixed cutoff (`git diff`, not merge-base). Normalize only app-owned `version` fields and their corresponding workspace lockfile version entries. Dependency changes, scripts, configuration, other lockfile entries, and library versions remain visible.

Pass changed files into `nx show projects --affected --files=... --json` and retain the app being examined. Repeat per app; deployed baselines can differ. Zero changed files returns no apps without invoking Nx. Shared model changes reach both apps through the actual Nx graph. During cherry-picking, compare the branch before/after the batch instead.

This is conservative impact detection, not behavioral-equivalence analysis. Source control must include every relevant build input; external dependency/image changes require an explicit rebuild policy. File paths containing comma/newline are not supported by the POC's CLI file-list transport.

## Version and state policy

`nx.json` selects only shop/API, independent versions, disk resolution, standard zero-major behavior, and no implicit dependent bumps (`updateDependents: never`). This policy is for private deployed apps, not separately published libraries. Nx automatic Git operations are disabled; the scripts commit and tag the exact versioned source before deployment.

The next snapshot is calculated from each final deployed version using SemVer `preminor` with `snapshot`, and supplied as an explicit version to Nx on the bookkeeping branch. The next cutoff's patch removes the snapshot suffix. A train stays open through bookkeeping merge.

State locations inside each sandbox:

- `work/.git/release-poc/state.json`: train membership, operation journal, merge results, expected candidates.
- `state/production.json`: replaceable production-manifest adapter (outside the Git worktree).
- `state/artifacts/`: immutable candidate records used by simulated deployments.
- `origin.git`: real local branches and tags.

An exclusive local lock serializes operations sharing the sandbox. Remote branch checks additionally reject an existing train/hotfix. These checks are not a distributed lock: a real GitHub deployment needs a shared Actions concurrency group and branch-creation permissions. The provided workflow serializes its POC runs and creates a fresh sandbox each run.

## Interrupted operations and conflicts

Completed-operation retries are supported. A crash after preparation starts or a cherry-pick conflict leaves an explicit incomplete journal and stops future automatic retries. Inspect `git status` and the journal; use a fresh sandbox to repeat a POC scenario. The tool never resets user changes, force-moves tags, or guesses whether a partial bump succeeded. Automatic crash recovery/manual conflict-resume is not implemented yet.

## GitHub Actions and remaining production integration

Run **Release workflow POC** via `workflow_dispatch`. It calls the scenario shell entry point, optionally performs real Nx builds, and uploads mock manifests/artifact records. It only requests `contents: read`; no real remote branch/tag mutations or deployments happen.

To promote this POC to production, replace the local-only adapter with:

1. A durable operation journal and shared locks across runner checkouts.
2. Actual production-manifest polling, timeout, rollout-completion checks, and artifact provenance.
3. Build/publish and deploy jobs, with immutable artifact retention.
4. `gh pr create` and verified rebase-merge commit discovery for feature/bookkeeping PRs.
5. Repository rules, narrow write credentials, and explicit tag-trigger behavior.

The shell entry points and Nx CLI policy remain the same. This POC tests Git/version semantics; it does not pretend to validate unavailable production integration.
