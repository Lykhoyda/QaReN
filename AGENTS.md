# Repository Guide For Agents

This file is for coding agents working in this repository. Keep it current and
practical. Do not paste session memory, issue histories, or one-off debugging
notes here.

## Where the repository is

The repository is mid-pivot from rn-dev-agent (an MCP server plus host plugins
that drive React Native apps on simulators) to QaReN: a Rust CLI that owns the
run and spawns a TypeScript child that reads the screen. `main` still ships
rn-dev-agent 1.0.x; `develop` carries the migration as one PR per phase and
merges into `main` as 2.0.0 once the label path runs end to end. The QaReN
structure outline and TDD that the phase PRs cite are the specification; each
phase PR names its Linear issue in the QaReN project.

The package cut, literal `qaren check`, Jev seam, Phase 4 blocks, and PR run/publication commands are implemented. For saved-block replay, persistence, recovery and action inspection, read the [saved-block contract](packages/qaren-cli/README.md#saved-blocks); for `qaren pr` and `qaren publish`, the [CLI README](packages/qaren-cli/README.md#test-a-pull-request). Live model and device acceptance are separate from hermetic tests; [Packaging](packages/qaren-cli/README.md#plugin-runtime-installation) is implemented; `qaren listen` is not implemented.

## Repository Map

- Root workspace: Yarn 4 workspace, managed by `package.json` and `yarn.lock`.
  Use `corepack yarn ...` from the repository root. The Rust crate is driven
  with `cargo` directly.
- `packages/qaren-cli/`: Rust CLI, library and binary `qaren`, `publish = false`. `src/run.rs` orchestrates `check`; the prototype debug verbs remain. Device leases live under `QAREN_LOCK_ROOT` or `~/.qaren/locks`, and run evidence under `~/.qaren/runs`. `check` reclaims a lease whose holder is proven dead by running that run's own cleanup (`commands/cleanup.rs`); a live or unprovable holder still refuses `DEVICE_BUSY`. For runner-host ownership and lease retention, follow the [iOS cleanup contract](packages/qaren-cli/README.md#ios-admission-and-cleanup). An external `qaren cleanup` refuses without signaling or saving anything while the run's core is recorded and its recorded qaren owner is proven alive. A signal or a vanished caller ends the run as `RUN_CANCELLED` after normal teardown (`src/cancel.rs`). `src/exec/log.rs` owns redaction before durable subprocess logging, including detached debug runs. `observe/` is the Observe SPA (Vite); `target/` and `observe/dist/` are ignored.
- `packages/qaren-core/`: TypeScript screen child, entered through `src/qa/walk.ts`. The `qa/` module owns parsing, judgments, screen projections, walking and the ledger, using the kept handlers, CDP helpers, native runners and learned-action domain. `corepack yarn build:core` generates uncommitted `dist/`; entries run as `node packages/qaren-core/dist/<entry>.js`. The package is private; `scripts/build-qaren-tarball.ts` bundles its spawned entries into the CLI tarball.
- `packages/qaren-plugin/`: the one host package. Claude, Cursor and Codex
  manifests (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`), a
  SessionStart-only `hooks/hooks.json`, and `skills/`. The five skills keep
  their rn-dev-agent wording until Phase 8 rewrites them; commands arrive in
  Phase 8. Its `package.json` is the version source for changesets and `qaren`
  is the only released package.
- `packages/rn-fast-runner/` (package `qaren-ios-runner`) and
  `packages/rn-android-runner/` (package `qaren-android-runner`): native
  runner sources.
- `apps/docs-site/` (package `qaren-docs`): deliverable documentation site;
  its content still describes rn-dev-agent until Phase 8.
- Engineering processes, plans, stories, audits and research live in the
  workspace [`docs/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/tree/main/docs/);
  never add a top-level `docs/` tree here. Captain-approved architecture records
  belong in [Anton Factory `architect-docs`](https://github.com/Lykhoyda/anton-factory/tree/main/architect-docs/);
  link to either owner instead of copying.

## Editing Rules

- Use first-party framing in code, docs, comments, tests, changesets, issue/PR
  descriptions, review replies, and shipped artifacts: never name, quote, link
  to, cite, or present behavior as copied from competing repositories or
  implementation approaches.
- New source and test code must be TypeScript (`.ts`/`.tsx`) or Rust. The
  grandfathered `.js`/`.mjs` files are listed in
  `scripts/js-migration-baseline.txt`; do not grow that baseline casually.
- In `packages/qaren-core` the names are final and have no alias: `QAREN_*`
  environment variables, `.qaren/` in the app repository (`.qaren/actions` is
  the action corpus, a real directory; symlinked corpora and per-file symlinks
  are refused by `src/domain/action-store.ts`), `~/.qaren/runtime` for the
  installed runtime, `~/.qaren/state` for per-user state, `__QAREN` for the
  injected global. Do not reintroduce an old name there or add a shim for one.
  Old names that remain on purpose: the plugin skill text (Phase 8), the GitHub slug
  `Lykhoyda/rn-dev-agent` in `RUNNER_REPO` and the manifest URLs until the
  repository is renamed after the `develop` → `main` merge, and the codesign
  identifier of the committed darwin process-birth helper until CI rebuilds it.
- Do not commit generated artifacts: `packages/qaren-core/dist/`,
  `packages/qaren-cli/target/`, `packages/qaren-cli/observe/dist/`, simulator
  screenshots, temporary logs, or proof captures.
- Do not add or restore `BUGS.md`. Bugs are tracked in GitHub Issues; QaReN
  migration work is tracked in Linear.
- The SessionStart hook must never download. `hooks/hooks.json` runs
  `scripts/ensure-qaren.sh --print-bin`, the verify-only mode that exits 0;
  its output contract is documented in the script header. `maestro-runner-pin`
  no longer has an `install` subcommand; pin-cache messages that still name `ensure-maestro-runner.sh`
  are rewritten with the Phase 8 install path.
- Do not create compatibility symlinks or shims for removed paths and names.
- Code in `src/injected-helpers.ts` is evaluated via CDP inside an
  already-bundled Metro/Hermes runtime: `require('<package-name>')` throws
  there. Prove "is X bundled?" with Metro's dev registry
  (`globalThis.__r.getModules()`, per-module `verboseName`) or fiber/render
  evidence, bounded and fail-closed.

## Architecture Rules

- All nontrivial code architecture must follow Domain-Driven Design. Define
  explicit domain language and bounded contexts before implementation.
- Domain models own domain invariants and lifecycle transitions. Application
  layers orchestrate use cases; infrastructure, handlers, runners, transports,
  UI, and platform modules implement adapters, with dependencies directed
  inward toward the domain.
- Adapters, handlers, runners, transports, and UI or platform modules must not
  become competing owners of domain policy or authority. Trivial mechanical
  code does not need new layers or types, but it must reuse established domain
  boundaries and must not bypass or duplicate them.
- The CLI owns the run, the device lease and Metro; the core child owns the
  screen. The wire between them is one JSON object per line, and the result
  line must agree with the exit code (0 PASS, 1 FAIL, 4 typed refusal).

## Where To Make Changes

- Core screen layer: edit `packages/qaren-core/src/`, then
  `corepack yarn build:core`. Unit tests import `dist/`, so rebuild before
  running them or the suite silently tests the old build.
- CLI: edit `packages/qaren-cli/src/`, then
  `cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked`.
- Host surface: edit `packages/qaren-plugin/` in place. There is no mirror,
  no generated host copy and no sync gate.
- Native runners: edit `packages/rn-fast-runner/` or
  `packages/rn-android-runner/`.
- Docs site: edit `apps/docs-site/`, then `corepack yarn build:docs`.

Doctrine for the kept handlers, each with one owner:

- Authority hooks in `handlers/maestro-run.ts` and `handlers/run-action.ts`
  are optional deps defaulting to no-ops (`nestedMaestroAuthorityCallbacks`,
  `claimNativeOrigin`); `SessionAuthorityError` and
  `isProvenMetroOriginMismatch` live in `domain/authority-error.ts`. The walker
  passes its own from Phase 2; nothing else re-implements authority inline.
- Native runner launches require `QAREN_DEVICE_LEASE`; `runners/lease-env.ts` adapts the CLI lease to the runners' internal protocol.
- Jev decisions use `qa/questions.ts` thresholds and `qa/resolve.ts` policy; `qa/jev.ts` owns HTTP only. Keep observed identities and local literal assertions separate from outbound masking in `qa/privacy.ts`; generated masks are never assertion evidence.
- When changing private QA capture, follow the [capture and privacy contract](packages/qaren-cli/README.md#check-a-plan). `beginQaCapture`/`readQaCapture` use the context-pinned `qa/react-capture.ts` adapter; `qa/private-input.ts` owns native privacy admission, `qa/private-input-limits.ts` bounds React host evidence, and `qa/privacy.ts` owns masking history and sensitive screenshot withholding. Keep raw facts out of public tree envelopes, async result slots and logs.
- Login replay refusal is owned by `handlers/run-action.ts` using attested
  install provenance and `containsClearState` in `domain/maestro-validator.ts`.
  Flow-relaunch attribution is owned by `createFlowRelaunchTracker` in
  `handlers/maestro-run.ts`. Regressions: `test/unit/gh-993-*.test.ts`,
  `test/unit/gh-708-mid-flow-relaunch.test.ts`.
- React-tree replay presses (`createReplayPressByTestId` in
  `handlers/cdp-replay-dispatch.ts`) opt into `walkUp` and
  `allowInputDesignation` at the `InteractArgs` boundary; TextInput designation
  runs first inside the injected helper, then the bounded ancestor walk.
  Exact-ID replay eligibility is read on host fibers only. Pinned by
  `test/unit/gh-869-replay-tap-type-walkup.test.ts` and
  `test/unit/textinput-designation-replay.test.ts`.
- Exact-ID visibility has one owner: the injected `isTestIdFrontmost` oracle
  in `src/injected-helpers.ts`, consumed through `frontmostFor`; it scans
  fibers exactly and fail-closes on renderer coverage and scan budget, and its
  refusal carries `meta.coverage`. `replayTreeData` is a readability gate only;
  never infer exact-ID presence from `getTree(filter)` substrings. Fibers are
  compared modulo `fiber.alternate`. Regressions:
  `test/unit/ios-proof-domain-routing.test.ts`,
  `test/unit/issue-944-coverage-disclosure.test.ts`.
- Trailing-verification classification has one owner: the per-attempt ledger
  in `domain/maestro-run-ledger.ts` (artifact reader in
  `domain/maestro-runner-report.ts`) and its `classifyTrailingVerification`.
  Never classify command outcomes from renderer text, step counts or
  positional joins; unknown ledger evidence or unclean termination withholds
  the qualifier. Regressions: `test/unit/gh-623-*.test.ts`.
- WDA build persistence has one owner: the seed/publish pair around the
  per-spawn runner cache in `domain/engine-pin.ts`, backed by
  `.wda-store-<runner>/<host platform-architecture>/<xcode fingerprint>/`
  beside the pin-cache. Persist only contained `DerivedData/Build/Products`,
  seed after the snapshot seal walk, and skip publication if the toolchain
  fingerprint changed.
- Saved actions compile to `rn-flow/1` replay plans in one place,
  `flow/compile.ts` (`dist/qa/walk.js --compile`); the dialect contract is
  `apps/docs-site/src/content/docs/actions/rn-flow-1.md`. Change semantics
  there, never per action; regenerate the goldens under
  `test/fixtures/rn-flow-1/plans/` with `UPDATE_GOLDEN=1` and review the diff.
- Learned-action compatibility is diagnosed read-only by
  `diagnoseLearnedActions` (`domain/action-engine-compat.ts`), also reachable
  as `node packages/qaren-core/dist/maestro-runner-pin.js diagnose-actions --root <app> [--json]`,
  pinned by `test/unit/action-engine-diagnose.test.ts`.

## Validation Commands

Use the smallest relevant set first, then broaden before pushing. This is the
local set; `ci.yml` is the authority on what `Build & Test` runs.

```bash
corepack yarn format:check
corepack yarn lint
bash scripts/check-typescript-only.sh
bash scripts/sync-versions.sh
corepack yarn build && corepack yarn test
corepack yarn test:integration
corepack yarn workspace qaren-core test:contract
cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked
bash scripts/check-public-runner-assets.sh
for t in scripts/test/*.test.sh; do bash "$t"; done
node --test scripts/test/check-document-ownership.test.ts scripts/test/assert-qaren-check.test.ts scripts/test/gate-qaren-check.test.ts scripts/test/native-ios-command.test.ts
corepack yarn build:docs
```

Jev unit tests are hermetic. `corepack yarn jev:evals` requires `TYPESAFE_API_KEY` and makes live calls; run it before changing the pinned model. The device-bound `gate:qaren-check` follows the [plan readiness contract](packages/qaren-cli/README.md#check-a-plan) and uninstalls the selected test app through `qaren check --fresh-install` under the CLI's device lease; coordinate external device ownership before running it. It accepts `--plan-file` for the phrase fixture under `packages/qaren-core/test/fixtures/plans/`.

For a shutdown iOS target, explicitly pass `check --boot-device --device <UUID>`; the existing lease and durable record precede strict admission, boot and exact-target readiness readback. Default selection remains booted-only, and cleanup keeps the borrowed simulator. The gate forwards this opt-in with `QAREN_BOOT_DEVICE=1` alongside `QAREN_DEVICE_UDID`.

CLI-owned iOS builds require `devClientScheme`; use the default app-local Expo generic-build route or explicitly configure `ios.build` with an existing workspace and Xcode scheme for older Expo CLIs (see `packages/qaren-cli/README.md`, including native-dependency preparation limits). Both routes verify a finite simulator bundle before exact-device installation and separate managed Metro. Workspace builds bind route and selection into the native cache and retire run-local outputs only after verified publication and proven build-group shutdown; unknown cleanup retains the build lock and device lease for `qaren cleanup`.

Every `cdp_run_action` RunRecord write goes through the proven-identity action
write lock (`src/domain/atomic-writer.ts`); `qaren check` uses its own ledger instead. A
shell that cannot execute setuid `/bin/ps` or read `kern.bootsessionuuid`
makes `probeProcessBirth` return `unknown`, so persistence throws and
handler-driven tests report zero RunRecords. Run those tests from an
unsandboxed shell before treating that as a regression.

Local native iOS checks use the developer-only suite owner, which acquires the same device lease as `qaren check`, proves strict admission, and sets one exact destination with parallel workers disabled:

```bash
corepack yarn build:core
cargo run --manifest-path packages/qaren-cli/Cargo.toml --locked --example native-ios-suite -- run --device <UDID>
corepack yarn test:native:android
```

Suite records and redacted logs live under `~/.qaren/native-suites/<run-id>`. Unknown cleanup retains the lease; use the same example with `recover --run-id <run-id>` after the owner exits, rather than deleting locks. Recovery proves the owned group and exact-simulator runner hosts absent, not global admission, and preserves the original test verdict. Admission's controller classification requires kernel identity plus exact argv; an attested unscoped MCP controller is not itself a device conflict, but the scan cannot exclude uncooperative in-process automation. The wrapper neither shuts down nor deletes the borrowed simulator; re-read its state before subsequent app work. Isolated CI still invokes `corepack yarn test:native:ios` directly.

## Changesets And Versions

- A changeset must land in the same PR as the change it describes
  (`scripts/require-changeset.sh` watches `packages/qaren-core/src`,
  `packages/qaren-cli/src` and `packages/qaren-plugin/{commands,skills,hooks,scripts}`).
  The frontmatter key is `qaren`; `qaren-core`, both runners and `qaren-docs`
  are ignored in `.changeset/config.json`.
- `packages/qaren-plugin/package.json` is the version source.
  `corepack yarn version-packages` runs `changeset version`,
  `scripts/sync-plugin-manifest.mjs` and `scripts/sync-versions.sh --fix`,
  which keeps the three manifests, both marketplaces, `Cargo.toml` and the
  `qaren` entry in `Cargo.lock` on that version with a GNU/BSD-portable
  in-place edit and re-checks itself (`scripts/test/sync-versions.test.sh`).
- During the pivot changesets accumulate on `develop`; the `develop` → `main`
  merge produces one Version Packages PR for 2.0.0.
- Docs, tests, CI-only changes, and generated-artifact cleanup do not need a
  changeset unless they alter shippable behavior.

## Branches, CI And Release

- `main` is protected and its only required check is `Build & Test`
  (`ci.yml`), which now requires `cargo-test` as well. Nothing reaches `main`
  except a PR carrying that check green.
- `ci.yml`, `codeql.yml` and `native-tests.yml` trigger on `main` and
  `develop`; `release.yml` and `deploy-docs.yml` trigger on `main` only, so
  nothing releases or deploys from `develop`.
- `release.yml` and `scripts/runner-manifest-publication.mts` ship the runner
  zips and one Apple silicon `qaren` tarball through the
  retained-bytes transaction, with `packages/qaren-plugin/runner-manifest.json`
  as the plugin's copy of the trust root. On `develop` only
  `scripts/check-public-runner-assets.sh` runs; it reads the advertised version
  from `packages/qaren-plugin/.claude-plugin/plugin.json` and asserts that
  version's listed bytes are public. A published release is never rebuilt,
  clobbered or retagged.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
