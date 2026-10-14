# Issue #989: what actually causes the managed-Metro "fingerprint hang"

Knowledge-only investigation. No product code was changed. Heads examined:

| Head | Commit | Date | Ships as |
| --- | --- | --- | --- |
| `origin/develop` | `2d253a0` | 2026-10-14 | `qaren-cli` 1.0.13, `qaren-plugin` 1.0.13 |
| `origin/main` | `8abeed7` | 2026-09-29 | `rn-dev-agent-plugin` 1.0.14 |
| tag `v1.0.4` | `8d8b89db` | 2026-09-03 | the build the issue body reports against |

Third-party sources were read from the SDK 55 release tarballs: `@expo/cli@55.0.36`,
`expo-updates@55.0.33`, `@expo/fingerprint@0.16.8`, `@expo/config-plugins@55.0.11`,
`expo-dev-launcher@55.0.41`. Those are the `sdk-55` dist-tags on 2026-10-14; the PR 994
transcript names `@expo/cli` 55.0.34 and `expo-updates` 55.0.26, and the files cited
here are unchanged in shape between those patch releases.

## 1. The two heads do not share the code the issue describes

**Proven.** The managed-Metro launcher that the issue's framing refers to (a `startManagedMetro`
readiness loop, a `/status` fetch with a 2 s abort, a session-private `metro-home` HOME,
the Darwin seatbelt and the Node descendant fence) exists only on `main`:

- readiness loop: `packages/rn-dev-agent-core/src/session/managed-metro.ts:2480-2555`
  (probe the listener, prove ownership, `capture`, `wait(100)`), pre-kill snapshot at
  `:2556-2561`, refusal text at `:2137` and `:2597`.
- `/status` with a 2 s abort: `packages/rn-dev-agent-core/src/session/metro-binding.ts:136-148`,
  consumed by `captureMetroBinding` at `:150-199`.
- private HOME, TMPDIR, cache root, `EXPO_OFFLINE=1`, `EXPO_UNSTABLE_HEADLESS=1`:
  `managed-metro.ts:2239-2280`; the `git`/`node` PATH shim comment at `:2281-2288`.
- the `manifest-utility` lane of the descendant fence:
  `packages/rn-dev-agent-core/src/session/package-integration.ts:1362-1368` (boundary),
  `:1421-1436` (exact `runtimeversion:resolve --platform ios|android [--debug]` match),
  `:1625-1645` (admission); the child keeps every variable except `NODE_OPTIONS` and
  `RN_DEV_AGENT_*` (`:769-777`).

`develop` removed all of it in `b832ecb` (#1071, "cut to qaren-cli, qaren-core and
qaren-plugin"). There is no `METRO_START_UNAVAILABLE`, no spawn gate and no seatbelt anywhere
under `packages/qaren-*` (grep over `packages/` on `develop`, `dist/` excluded). Metro on
`develop` is started by the Rust CLI as a plain `pnpm exec expo start --port <port>` with the
parent environment inherited (`packages/qaren-cli/src/adapters/metro.rs:6-16`;
`packages/qaren-cli/src/exec.rs:461-478` only applies the spec's `env`/`env_remove`). Readiness
is `/status` through `curl --max-time 5` (`metro.rs:55-67`, `:159-162`) under the scenario's
`build_seconds` budget, default 2400 s (`packages/qaren-cli/src/scenario.rs:249-251`,
`packages/qaren-cli/src/commands/prepare.rs:1532-1578`). After readiness, `develop` requests the
dev-client manifest once itself, with a 60 s cap, before launching the app
(`metro.rs:18-35`, `prepare.rs:1704-1725`, added by `767b53d` on 2026-10-05). A manifest
timeout there is reported as `CORE_REFUSED: dev client manifest timed out ... (host 1-minute
load N.N; an environment refusal after 1 attempts)` (`prepare.rs:3046-3075`).

So on `develop` the question "which candidate causes `METRO_START_UNAVAILABLE`" has no
object; the residual of #989 surfaces as that `CORE_REFUSED` manifest timeout, or as the
dev client's own "Failed to connect" when its later requests exceed its budget.

## 2. Issue #989 contains two different symptoms

The body (2026-09-07, plugin 1.0.4) reports `METRO_START_UNAVAILABLE` at Metro start and
attributes it to a denied `git` child under `@expo/fingerprint`. The two follow-up comments
(same day, 1.0.4 then 1.0.6) report something else: Metro is up, the manifest is served with
a real fingerprint runtime version, but each manifest request recomputes the fingerprint and
takes 4.4 s idle, 14.75 s cold, up to 57 s under host load (all three figures as reported in
the issue, not reproduced here), against a dev-client manifest budget of 10 s. The ranking
below treats them separately because no single candidate explains both.

### What the start path provably does not do

**Proven, SDK 55 sources.**

- `expo start` brings the dev server up before anything touches TypeScript or the manifest:
  `@expo/cli@55.0.36/build/src/start/startAsync.js:152` starts the servers, `:156` then runs
  the TypeScript bootstrap. Inside the Metro server, `instantiateMetroAsync` (which calls
  `runServer`, i.e. listens, at `build/src/start/server/metro/instantiateMetro.js:331`) runs
  at `build/src/start/server/metro/MetroBundlerDevServer.js:876-879`, and the manifest
  middleware is created and prepended only afterwards (`:885-895`).
- `@expo/cli` touches runtime-version resolution in exactly four files
  (`start/server/middleware/ExpoGoManifestHandlerMiddleware.js`,
  `start/server/middleware/resolveRuntimeVersionWithExpoUpdatesAsync.js`,
  `utils/expoUpdatesCli.js`, `utils/build-cache-providers/index.js`). None is on the start
  path. The only start-server consumer is the manifest handler, which calls
  `resolveRuntimeVersionWithExpoUpdatesAsync` per request
  (`ExpoGoManifestHandlerMiddleware.js:132-135`; the request entry at
  `ManifestMiddleware.js:301-310` has no memoisation).
- That function spawns `expo-updates/bin/cli.js runtimeversion:resolve --platform <p>` with
  the parent's whole environment and no timeout
  (`resolveRuntimeVersionWithExpoUpdatesAsync.js:14-26`, `utils/expoUpdatesCli.js:91-105`).
  `@expo/fingerprint` is reached only from inside that child
  (`expo-updates@55.0.33/utils/src/resolveRuntimeVersionAsync.ts:12-50` →
  `utils/src/createFingerprintAsync.ts`). The config-plugins fallback returns the
  `file:fingerprint` sentinel instead of computing anything
  (`@expo/config-plugins@55.0.11/build/utils/Updates.js:83`, `:146-163`).
- The readiness gate on `main` needs only a listener owned by the launcher and a `/status`
  body containing `packager-status:running` within 2 s (`managed-metro.ts:2493-2535`,
  `metro-binding.ts:136-148`, `:182-185`). It never requests the manifest. A slow or stuck
  `runtimeversion:resolve` child therefore cannot hold the start gate open, and a refused
  `git` inside that child surfaces as an HTTP 500 on the manifest (the #986 symptom), never
  as `METRO_START_UNAVAILABLE`.
- At tag `v1.0.4` the `manifest-utility` lane already existed
  (`package-integration.ts:1644` at `8d8b89db`) and PR #994's second commit established that
  the Darwin profile was not enforced on 1.0.4 at all (the platform code-signing leaf was
  rejected until `6d6dc39`, shipped in 1.0.5, so enforcement degraded to `reported-v1`). The
  issue body's "the spawn gate denies the `git` child" therefore had no mechanism on the build
  it was reported against, and comment 1 on the same thread confirms 1.0.4 served the
  fingerprint manifest, slowly.

### The budget that produced the body's symptom

**Proven.** At `v1.0.4`, `v1.0.5` and `v1.0.6` the readiness deadline is a fixed
`Date.now() + 20_000` (`managed-metro.ts:2355`, `:2423`, `:2435` at `8d8b89db`, `d15ab40`,
`7f33f73`). The refusal text at those tags was assembled after the group SIGTERM, so it
reported the kill's own artifacts. PR #996 (`b352043`, shipped 1.0.7 on 2026-09-10) changed
both: the snapshot is taken before the kill, the detail names the readiness outcome
(`launcher alive at deadline; readiness deadline N ms expired: listener absent ...`), and the
budget became 90 s by default, configurable through `.rn-agent/config.json`
`metro.readinessTimeoutMs` (`packages/rn-dev-agent-core/src/project-config.ts:288`,
`:314-324`; the generated adapter sizes `ensure-metro` from it at
`package-integration.ts:3597-3618`, `:3800-3807`).

**Hypothesis by fit, not proven.** Issue #992, filed by the same reporter the same day on the
same machine class with 145 other local sessions present, is the same refusal with a Metro log
tail that stops at `file-map crawl in progress`; its accepted diagnosis (PR #996 body) is that
a cold Metro simply did not open its port inside 20 s on a loaded host. That is the only
mechanism in the source that yields `METRO_START_UNAVAILABLE` with Metro "up but not ready",
and it needs neither `git` nor a fingerprint. The issue body's own repro note ("same result
with the agent sandbox disabled") is consistent with a load/time cause and inconsistent with a
denial cause. Comment 2 reports a 1-minute load of 50-75 during the retest.

## 3. Ranking of the five candidates

Ordered by how much of #989 each can explain on current `develop`, with `main` noted where
the code lives only there.

### Rank 1: cold, uncached `runtimeversion:resolve` in the CLI child after listen

**Mechanism proven; magnitude as reported.** Every dev-client manifest request spawns the
`expo-updates` CLI, which in turn runs `git --help`, `git rev-parse --show-toplevel` and, when a
native marker exists, `git check-ignore` (`expo-updates@55.0.33/utils/src/vcs.ts:12-60`,
`utils/src/workflow.ts:9-39`); then `@expo/fingerprint` spawns `node` for the config loader
over IPC (`@expo/fingerprint@0.16.8/build/ExpoConfig.js:16-27`) and twice for autolinking
(`build/sourcer/Expo.js:231`, `:301`), and hashes every native source directory with
`concurrentIoLimit = os.cpus().length` (`build/Options.js:77`, `build/hash/Hash.js:26-27`).
There is no on-disk fingerprint cache anywhere in `@expo/fingerprint` 0.16.8, `expo-updates`
55.0.33 or `@expo/cli` 55.0.36 (grep for `cache` finds only in-memory module caches). The
client budget is 10 s and is fixed: `expo-dev-launcher@55.0.41/ios/EXDevLauncherController.m:41`
(`EXDevLauncherDefaultRequestTimeout = 10.0`), applied at `:324-338` and
`ios/Manifest/EXDevLauncherManifestParser.m:106`.

This explains the comment-thread symptom on both heads. On `main` nothing warms the manifest
before launch (no `expo-platform` request anywhere under `src/`). On `develop` the one-time
pre-warm (`767b53d`) moves the cold request off the dev client, but the client's own request
still recomputes (4.4 s idle floor and 5.7-7.7 s "warm" under load, as reported), and any
relaunch or reload re-pays it. It does not explain the body's `METRO_START_UNAVAILABLE`
(section 2).

### Rank 2: tsconfig EPERM at dev-server start

**Proven mechanism, `main` only, 1.0.5 and later, specific projects.** After the server is
listening, `expo start` runs the TypeScript prerequisite
(`startAsync.js:156`, `DevServerManager.js:219`). When the project has `.ts`/`.tsx` sources
and no `tsconfig.json`, or an empty one, or one without an `extends` key, it writes
`tsconfig.json` in the app root (`build/src/start/doctor/typescript/updateTSConfig.js:88-115`).
Under the enforced Darwin profile the app root is read-only, so the write fails with
`EPERM ... tsconfig.json.<tmp>` and `expo start` exits; PR #994's second commit had to add a
`tsconfig.json` to the SDK 55 dev-client fixture for exactly this reason. `main` does not set
`EXPO_NO_TYPESCRIPT_SETUP` (grep over `managed-metro.ts`). This is a fast, deterministic
crash, visible in `metro.log`, that races the 100 ms readiness probe; it is not a hang. It is
impossible on 1.0.4 (no enforcement) and on `develop` (no sandbox), so it cannot be the #989
report, but it is the one candidate that still produces a start failure on current `main`.

### Rank 3: native-build `createUpdatesResources` fingerprinting

**Proven to be a build-leg cost, not a Metro-start cost.** The script phase runs inside the
native build (`expo-updates@55.0.33/scripts/create-updates-resources-ios.sh:5-16`, Debug
configurations use `only-fingerprint`; `utils/src/createUpdatesResources.ts`), honours
`EXPO_UPDATES_FINGERPRINT_OVERRIDE` (`utils/src/createFingerprintForBuildAsync.ts:42-57`), and
writes a `fingerprint` file into the bundle. On `main` the adapter runs `ensure-metro` first
and the build (`expo run:ios --no-bundler`, `package-integration.ts:3853-3863`, `:3888-3891`)
afterwards, so this fingerprint cannot delay readiness. On `develop` Metro is spawned and then
the finite build runs concurrently (`prepare.rs:2407-2408`; `adapters/ios.rs:571-585`), so the
build-time fingerprint competes for CPU with Metro's cold start under a 2400 s budget. Load
contention only; irrelevant to the hang code.

### Rank 4: `expo run` build-cache-provider hashing

**Proven irrelevant unless configured.** `@expo/cli` reads `exp.buildCacheProvider` or
`exp.experiments.buildCacheProvider` (`build/src/run/ios/options/resolveOptions.js:45`) and
only then calls `resolveBuildCache`, which runs `createFingerprintAsync` in-process
(`run/ios/runIosAsync.js:119-124`, `utils/build-cache-providers/index.js:195-208`). Nothing
in either head sets it; `develop` computes its own build identity through the
`@expo/fingerprint` CLI in the plan stage instead (`packages/qaren-cli/src/fingerprint.rs:804-812`,
`:967-1041`, 120 s cap, PR #1159 and `c29d2e8`), before Metro exists. Build leg only.

### Rank 5: session-private `metro-home` HOME defeating caches

**Proven irrelevant for latency.** On `main` the Metro child and, through
`utils/expoUpdatesCli.js:102-105`, the `expo-updates` child both run with
`HOME=<runtime>/metro-home` (`managed-metro.ts:2239`, `:2270`; the fence strips only
`NODE_OPTIONS` and `RN_DEV_AGENT_*`, `package-integration.ts:769-777`). But there is no
fingerprint cache for that HOME to defeat (rank 1), and the only HOME consumer in the CLI is
the `.expo/state.json` anonymous scope key
(`@expo/cli@55.0.36/build/src/api/user/UserSettings.js:124-139`), which is exactly the one
file comment 1 observed there. `develop` inherits the real HOME (`metro.rs:6-16`), so the
candidate does not exist on the head the question is about. One side effect is worth a
sentence as a **hypothesis**: a user-level git config that the repo needs (for example a
`safe.directory` entry) is invisible under the private HOME, which flips `vcs.ts` to the
no-VCS client and changes the hash, not the time.

### Summary table

| Candidate | Explains body (`METRO_START_UNAVAILABLE`, 1.0.4) | Explains comments (slow manifest vs 10 s) | On `develop` |
| --- | --- | --- | --- |
| Readiness budget exhausted by cold start under load (#992 mechanism) | best fit, unproven | no | n/a (2400 s budget) |
| Cold `runtimeversion:resolve` per manifest request | no | yes, proven mechanism | yes, after the one-time pre-warm |
| tsconfig EPERM | no (not enforced on 1.0.4) | no | no sandbox |
| `createUpdatesResources` in the native build | no (runs after Metro on `main`) | no | load contention only |
| build-cache-provider hashing | no (not configured) | no | not used |
| private HOME | no | no (no cache exists) | HOME inherited |

## 4. Cheapest discriminating experiment

The two live explanations for "the plugin is waiting on Metro" are (A) Metro has not opened
its port or `/status` yet, and (B) Metro is listening and a `runtimeversion:resolve` child is
computing a fingerprint for a manifest request. One probe loop separates them. Start it in a
second terminal before triggering the build so the 20-90 s window on `main` is not missed.

Find the port:

```bash
# main: metroPort from the session
#   rn_session action=status   -> bindings.metroPort
# develop: the run record (packages/qaren-cli/src/runrecord.rs:145-151, :535)
PORT=$(jq -r '.resources.metro.port' ~/.qaren/runs/<run-id>/run.json)
```

Probe loop (works on both heads):

```bash
while :; do
  printf '%s ' "$(date +%T)"
  curl -s --max-time 2 "http://127.0.0.1:$PORT/status" || printf 'no-status'
  printf ' | '
  pgrep -af 'expo-updates/bin/cli.js runtimeversion:resolve|ExpoConfigLoader|expo-modules-autolinking|git (rev-parse|check-ignore)' | cut -c1-120 | tr '\n' ';'
  echo
  sleep 1
done | tee ~/989-probe.txt
```

Readout:

- `no-status` and no child process: Metro is not listening. That is (A). Confirm with the
  log tail, which on `main` should stop at `file-map crawl in progress` or the transformer
  construction: `tail -n 20 "${XDG_STATE_HOME:-$HOME/Library/Application Support}/rn-dev-agent/v2/sessions/<session-id>/runtime/metro.log"`
  (`packages/rn-dev-agent-core/src/util/secure-state-file.ts:9-17`,
  `src/session/state-root.ts:207`, `managed-metro.ts:2417`); on `develop`
  `tail -n 20 ~/.qaren/runs/<run-id>/logs/metro.log`. A line containing
  `EPERM` and `tsconfig.json` instead is rank 2, not (A).
- `packager-status:running` together with a live `runtimeversion:resolve` child (and its
  `ExpoConfigLoader`, autolinking and `git` grandchildren): readiness has passed and the wait
  is the manifest lane. That is (B). Measure it once with the request the dev client makes:

```bash
time curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'expo-platform: ios' \
  -H 'accept: multipart/mixed,application/expo+json,application/json' \
  -H 'expo-updates-environment: DEVELOPMENT' \
  "http://127.0.0.1:$PORT/"
```

A wall time above 10 s reproduces the comment-thread failure on its own, with no device
involved. To rule the HOME candidate out explicitly on `main`, run the child directly twice
and compare; the source predicts equal times:

```bash
cd <app-root>
time node node_modules/expo-updates/bin/cli.js runtimeversion:resolve --platform ios
time env HOME="$(mktemp -d)" node node_modules/expo-updates/bin/cli.js runtimeversion:resolve --platform ios
```

## 5. Facts versus hypotheses

Proven from source:

- No SDK 55 start-path code reaches `@expo/fingerprint`; only the manifest handler does, per
  request, through an untimed `expo-updates` child.
- `main` readiness is listener ownership plus `/status` within 2 s; 20 s fixed on 1.0.4-1.0.6,
  90 s configurable since 1.0.7; `develop` readiness is `/status` under a 2400 s budget plus a
  60 s one-time manifest warm.
- The 10 s manifest budget is a constant in `expo-dev-launcher`, not `expo-dev-client`.
- There is no on-disk fingerprint cache in the SDK 55 toolchain for a private HOME to defeat.
- The tsconfig EPERM failure is real, `main`-only, enforced-sandbox-only, and a crash rather
  than a hang.
- `develop` has no spawn gate or sandbox around Metro and inherits HOME.

Hypotheses:

- The 1.0.4 `METRO_START_UNAVAILABLE` in the issue body was the 20 s readiness budget
  expiring on a cold start under load (the #992 mechanism), not a fingerprint or a denied
  `git`. The log that would settle it was not attached to the issue.
- A private HOME can change the fingerprint hash through git configuration visibility; it
  cannot change its duration.
- The reported 4.4 s / 14.75 s / 57 s manifest times were not reproduced here; their
  composition (four node processes, three git calls, a tree hash) is inferred from source.
