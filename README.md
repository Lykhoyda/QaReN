This checkout develops **QaReN**, a CLI that checks Markdown QA plans, replays
saved blocks and persists passing walks. For current build and usage instructions,
read the [QaReN CLI guide](packages/qaren-cli/README.md). QaReN 2.0.0 has no
backward compatibility with rn-dev-agent 1.x; to move from 1.0.14, follow
[Upgrading from rn-dev-agent 1.x](packages/qaren-cli/README.md#upgrading-from-rn-dev-agent-1x-1014-to-20).

## Set up QaReN

Until a QaReN release asset is published, install from this checkout's root:

```sh
bash scripts/install-qaren-from-source.sh
```

The source installer requires an Apple silicon Mac, Node 24 or newer, Corepack
and Rust/Cargo. It builds and verifies the runtime; see the
[installation contract](packages/qaren-cli/README.md#plugin-runtime-installation)
for PATH linking, the fallback export and existing-command protection.

To update later, run `qaren update` from the same checkout root: it fast-forwards
the checkout (refusing when it has local changes), rebuilds and reinstalls, and
reports whether the build is already current, updated or newly installed.

Run `qaren doctor` to diagnose setup problems and rn-dev-agent 1.x leftovers;
see [Doctor](packages/qaren-cli/README.md#doctor) for checks and output options.

From your app's root, load the checkout's plugin in Claude Code:

```sh
claude --plugin-dir /absolute/path/to/rn-dev-agent/packages/qaren-plugin
```

Then run `/qaren:setup`. The [setup skill](packages/qaren-plugin/skills/setup/SKILL.md)
owns app requirements and onboarding: it writes `.qaren/config.yaml` and a smoke
plan, selects a simulator and runs the first check. The
[using-qaren skill](packages/qaren-plugin/skills/using-qaren/SKILL.md) writes
subsequent feature plans. These replace `rn-setup` and `using-rn-dev-agent`
without aliases. For manual runs, see [Check a plan](packages/qaren-cli/README.md#check-a-plan).

## Watch a QaReN run

Watch test stages in a second terminal:

```sh
qaren watch --latest
```

See the [watch guide](packages/qaren-cli/README.md#watch-a-run) for selecting a
run, SSH usage, output modes, privacy, stage semantics and exit codes.

The rn-dev-agent product and marketplace instructions below describe the
published 1.x release, not this QaReN checkout.

<div align="center">

# rn-dev-agent

### Your agent writes the code. This proves it runs.

A plugin for **Claude Code**, **Codex**, and **Cursor** that turns your coding agent into a React Native
development partner — one that reads your running app's component tree, store state, and
navigation over the Chrome DevTools Protocol, taps real UI on iOS and Android, and **records the
evidence** that the feature actually works.

[![CI](https://github.com/Lykhoyda/rn-dev-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Lykhoyda/rn-dev-agent/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-lykhoyda.github.io%2Frn--dev--agent-blue)](https://lykhoyda.github.io/rn-dev-agent/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**[Get started](#see-it-in-60-seconds)** · **[Documentation](https://lykhoyda.github.io/rn-dev-agent/)** · **[Benchmarks](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)** · **[Tools](https://lykhoyda.github.io/rn-dev-agent/tools/)**

</div>

![The observe UI live: inspecting a failed flow, checking store state, replaying a saved action, and running the locked E2E suite — all from the browser](apps/docs-site/public/observe/observe-demo.gif)

---

## See it in 60 seconds

```text
# 1. Install (Claude Code — Cursor and Codex below)
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@rn-dev-agent
/reload-plugins
```

```text
# 2. Onboard your app — checks the toolchain, writes the project config
/rn-dev-agent:setup

# 3. Ask for a feature. Get it back verified on the simulator.
/rn-dev-agent:rn-feature-dev add a shopping cart with badge, item list, and checkout flow
```

The agent explores your codebase, designs the change, implements it — then connects to the running
app, navigates to the screen, checks the component tree and store state, taps through the flow, and
saves the walk as a replayable test. You get working code **and** the proof.

Codex users: replace `/rn-dev-agent:<name>` with `$rn-dev-agent:<name>`. Cursor uses the Claude package (same slash commands). [Install steps →](#install)

---

## Coding agents ship blind

They are good at writing React Native code and bad at knowing whether it runs. This plugin closes
that loop — and the numbers below come from real features built on a real Expo app, not synthetic
benchmarks.

| | |
|---|---|
| **Verified, not claimed** | After implementing, the agent connects over CDP, walks the screen, reads the component tree and store, exercises the interaction, and screenshots the result — before it says "done" |
| **210× faster replays** | A 3-step wizard that took ~14 min as an interactive walk replays in **~4 s** as a saved action. Average session time across the measured features dropped from ~12 min to ~4 min once actions existed |
| **Flows that repair themselves** | When a `testID` drifts, the saved action fuzzy-matches the live snapshot, patches its own YAML, and retries. Cosmetic drift is absorbed; genuinely broken product logic is surfaced, never auto-fixed |
| **Minutes, not sessions** | Simple features land in 3–5 min, complex multi-step flows in 11–25 min. **Zero crashes and zero manual interventions** |
| **iOS and Android, one contract** | In-tree XCTest and UiAutomator runners give real taps, typing, scrolling, and screenshots; see [Android runner provisioning](packages/qaren-cli/README.md#android-runner-provisioning) for Android setup |
| **Claude, Codex, and Cursor** | Claude and Cursor: 17 slash commands + 11 skills + 6 agents. Codex: 28 native skills (17 workflow + 11 domain). The same MCP tools on every host |

[Full benchmarks and methodology →](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)

## Is this for you?

**Yes, if** you build React Native or Expo apps with a coding agent, you run an iOS Simulator or
Android Emulator locally, and you are tired of reviewing changes that were never actually opened.
It pays off most on apps with real navigation, real state, and flows you re-walk every session.

**Not yet, if** you work on web-only React, have no local simulator or emulator, or need an agent
pointed at production or store-signed builds — that last one is deliberately out of scope, see
[Security](#security).

---

## How it works

```
  /rn-dev-agent:rn-feature-dev "<what you want>"
        │
        ├─ 1 Discover    understand the feature, plan the work
        ├─ 2 Explore     parallel agents map screens, store, navigation, conventions
        ├─ 3 Question    clarify edge cases, error states, data flow
        ├─ 4 Architect   design the change against your existing patterns
        ├─ 5 Implement   store, components, navigation, testIDs
        ├─ 5.5 VERIFY    ◀── CDP health · component tree · store state · interaction · screenshot
        ├─ 6 Review      parallel agents check correctness and RN conventions
        └─ 7 PROOF       ◀── rehearse off camera, persist the action, record a clean replay
                                                            │
                                    working code  +  video  +  screenshots  +  PR body
```

Phase 5.5 is the one that makes the difference: nothing is reported as working until it has been
observed working. Phase 7 rehearses first, so discovery fumbling never ends up in the recording.

[The 8-phase pipeline in detail →](https://lykhoyda.github.io/rn-dev-agent/commands/rn-feature-dev/)

## Commands

Claude spelling shown. Codex has native parity for every row — use `$rn-dev-agent:<name>`.

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:rn-feature-dev <desc>` | Full 8-phase feature pipeline |
| `/rn-dev-agent:test-feature <desc>` | Test an already-implemented feature; auto-replays a matching saved action |
| `/rn-dev-agent:qa-pr <PR>` | Device-test a GitHub PR on iOS simulator, Android emulator, and/or physical device |
| `/rn-dev-agent:debug-screen` | Diagnose and fix a broken screen — parallel evidence from CDP + native logs + component tree |
| `/rn-dev-agent:proof-capture <desc>` | Rehearsal-gated video + screenshots + generated PR body |
| `/rn-dev-agent:observe` | Local web UI to **watch the agent live** — tool-call timeline, device mirror, route/store/component-tree panels, browser-triggered action and E2E replays ([guide](https://lykhoyda.github.io/rn-dev-agent/commands/observe/)) |
| `/rn-dev-agent:setup` | Onboard a project — Claude manages `CLAUDE.md`, Codex manages `AGENTS.md`; every project write is previewed |

<details>
<summary><strong>The other 10 commands — actions, regression, build, diagnostics</strong></summary>

**Actions & regression:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:list-learned-actions` | List persisted actions, flows, and feedback memories |
| `/rn-dev-agent:run-action <name>` | Replay a saved action with auto-repair and structured run records |
| `/rn-dev-agent:lock-e2e <name>` | Promote a verified action into a **frozen, locked e2e regression test** (strict no-repair run required) |

**Build & session:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:run-workflow <journey>` | Establish the proven operating sequence before a real device journey |
| `/rn-dev-agent:build-and-test <desc>` | Build the app (local or EAS), install on device, then test |

**Diagnostics:**

| Command | Purpose |
|---------|---------|
| `/rn-dev-agent:doctor` | Strictly read-only multi-axis plugin/MCP/schema/task/environment diagnosis; recommends but never executes recovery |
| `/rn-dev-agent:check-env` | Quick environment-readiness check |
| `/rn-dev-agent:nav-graph` | Extract and inspect the app navigation graph |
| `/rn-dev-agent:check-vercel-rules` | Report drift between bundled best-practice rules and upstream |
| `/rn-dev-agent:send-feedback` | Open a GitHub issue with sanitized environment context |

Codex exposes exactly these 17 workflow skills plus 11 domain skills; install-time
`source-command-*` migration is deliberately disabled.

The plugin also keeps a gitignored per-project troubleshooting memory
(`.rn-agent/local/troubleshooting.md`) — auto-captured failures and config notes, read at session start.

</details>

## Actions: the memory of the loop

An **action** is a saved Maestro flow the agent **emits** when verification passes — not something
you author. Each task then splits in two: **replayable actions** for the predictable parts (login,
navigation, multi-step setup) and **live discovery** for the part that is actually new. Actions run
as prologues to reach a known state before fresh interactive work.

| | |
|---|---|
| **What** | A saved, parameterised flow with a metadata header and `${KEY}` placeholders |
| **Where** | `.rn-agent/actions/<name>.yaml` — the plugin's home in your project is `.rn-agent/` |
| **Create one** | Run `/rn-dev-agent:test-feature <description>`; the verified walk is saved automatically |
| **Run one** | `/rn-dev-agent:run-action <name>` — the agent also picks actions itself when it needs a known state |
| **Self-repair** | If a `testID` changes, `cdp_repair_action` fuzzy-matches against the live snapshot, patches the YAML, and retries. Small UI drift is absorbed; broken product logic is surfaced, never auto-fixed |
| **Lock it in** | `/rn-dev-agent:lock-e2e` freezes a passing action into `.rn-agent/e2e/` — locked tests run strict (no repair) via `cdp_run_e2e_suite` |
| **Why it works** | Pure scripts don't adapt; a pure LLM re-derives everything every session. Every successful verification adds an action, every drift gets quietly absorbed, every truly broken flow escalates |

[Full actions guide →](https://lykhoyda.github.io/rn-dev-agent/actions/)

## Under the hood

Everything the commands above are built from — expand what you need. The architecture and review
phases also apply a bundled set of React Native and React
[best-practice rules](https://lykhoyda.github.io/rn-dev-agent/best-practices/).

<details>
<summary><strong>81 MCP tools across six families</strong></summary>

| Family | What it's for | Examples |
|---|---|---|
| **Session** | Fence one worktree, Metro, app, device, runner, Observe UI, and proof run | `rn_session` |
| **CDP** | React internals via Chrome DevTools Protocol | `cdp_status`, `cdp_component_tree`, `cdp_store_state`, `cdp_evaluate`, `cdp_native_errors`, `cdp_navigate`, `collect_logs` |
| **Device** | Native interaction with the simulator/emulator | `device_find`, `device_press`, `device_fill`, `device_screenshot`, `device_pick_date`, `device_batch` |
| **Actions** | Record / replay / self-repair persistent flows, including fail-stop login | `cdp_login_prologue`, `cdp_run_action`, `cdp_repair_action`, `cdp_record_test_save_as_action`, `cdp_lock_e2e_test`, `cdp_run_e2e_suite` |
| **Testing** | E2E replay and PR-ready proof | `proof_step`, `cross_platform_verify`, `maestro_run`, `maestro_test_all` (`cdp_auto_login` is legacy per-call recovery, not a failed-login fallback or PR proof) |
| **Macro-Asserts** | State-assertive replays — internal state, not pixels | `expect_redux`, `expect_route`, `expect_visible_by_testid`, `expect_text` |

[Published 1.x tool reference →](https://lykhoyda.github.io/rn-dev-agent/tools/)

</details>

<details>
<summary><strong>Reliability baked into the tool layer</strong></summary>

- **Self-healing taps** — a stale `@ref` is re-bound by identity (testID/label/role, unique match only). Opt out with `RN_SELF_HEAL=0`. A dispatched tap is never replayed because its effect is uncertain: on iOS an unchanged tap stays a success carrying `meta.noUiChange`, and on Android a tap whose effect cannot be observed fails (`INTERACTION_EFFECT_UNVERIFIED`, `mutation: possible`) rather than reporting success. If Android's first window check reports idle and the hierarchy hash still matches the supplied pre-tap hash, settle waits once more for a window update, for up to the smaller of 2,000 ms and the remaining settle budget, then re-hashes only if an update arrives. This gives a delayed render time to become observable without dispatching another tap; an already changed hierarchy or a call without a pre-tap hash incurs no extra window wait.
- **Quiescence bypass (iOS)** — XCTest's private idle-wait is disabled by default so apps with Reanimated or looping animations can't hang queries. Opt out with `RN_QUIESCENCE_BYPASS=0`.
- **Engine pinning** — setup installs attested [maestro-runner](https://github.com/devicelab-dev/maestro-runner) `1.1.28` in the versioned pin-cache (floor `>= 1.1.28`) and verifies its checksum fail-closed; replay and `/doctor` refuse missing, older, or unattested engines.
- **Degraded-runtime detection** — when taps succeed but the app doesn't respond, results carry a "simulator likely wedged, reboot it" hint instead of a misleading "element not found."

</details>

<details>
<summary><strong>Six specialized agents</strong></summary>

Each runs a focused protocol: [tester](https://lykhoyda.github.io/rn-dev-agent/agents/rn-tester/),
[PR QA](https://lykhoyda.github.io/rn-dev-agent/agents/rn-pr-qa/),
[debugger](https://lykhoyda.github.io/rn-dev-agent/agents/rn-debugger/),
[code explorer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-explorer/),
[architect](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-architect/),
[reviewer](https://lykhoyda.github.io/rn-dev-agent/agents/rn-code-reviewer/).

> **Note:** `rn-tester`, `rn-pr-qa`, and `rn-debugger` need MCP tools, which don't propagate to spawned
> subagents — use `/rn-dev-agent:test-feature`, `/rn-dev-agent:qa-pr`, and `/rn-dev-agent:debug-screen`, which run the
> protocols inline (GH #31).

</details>

<details>
<summary><strong>Architecture</strong></summary>

```
Claude Code / Codex
  ├── Host workflows + shared domain knowledge
  │   Claude: commands/agents · Codex: explicit workflow/domain skills
  │
  ├── Fenced session authority ── worktree → Metro → app → device
  │
  ├── MCP Server (CDP Bridge) ─── WebSocket → bound Metro → Hermes CDP
  │   Tools: component tree, store state, profiling, network,
  │   interaction, recording, self-healing replay
  │
  └── Device interaction
      ├── iOS    → in-tree rn-fast-runner (XCTest /command HTTP)
      └── Android → in-tree rn-android-runner (UiAutomator instrumentation)
          │                         │
     iOS Simulator           Android Emulator

      Device lifecycle (boot / install / launch): xcrun simctl + adb
      E2E test execution: maestro-runner 1.1.28 (pin-cache only)
```

[Architecture details →](https://lykhoyda.github.io/rn-dev-agent/architecture/)

</details>

---

## Install

### Claude Code

```text
/plugin marketplace add Lykhoyda/rn-dev-agent
/plugin install rn-dev-agent@rn-dev-agent
/reload-plugins
```

### Cursor

Install the published rn-dev-agent release from **Customize → Plugins**.

### Codex

```bash
codex plugin marketplace add Lykhoyda/rn-dev-agent
codex plugin add rn-dev-agent@rn-dev-agent
```

Codex does not load Claude Code hooks — `No plugin hooks` is expected. Codex 0.145.0 is the
live-refresh floor; older hosts are restart-only. An external CLI or manual plugin change always
requires exiting and relaunching Codex.

### Then set up your project

```text
cd /path/to/your-rn-app

Claude: /rn-dev-agent:setup
Cursor: /rn-dev-agent:setup
Codex:  $rn-dev-agent:setup
```

Claude setup manages `CLAUDE.md`; Codex setup manages an idempotent sentinel-bounded `AGENTS.md`
block, runs strictly read-only package/recovery diagnostics first, and previews every later
project write for consent. [Full setup guide →](https://lykhoyda.github.io/rn-dev-agent/getting-started/)

<details>
<summary><strong>What setup checks, and what it fixes for you</strong></summary>

Claude hooks and normal runtime use can perform the automatic handling below; Codex setup keeps
recovery diagnosis read-only and prints the exact commands for you to confirm and run.

| Check | Required | Automatic handling |
|-------|----------|--------------|
| Node.js ≥ 24 | Yes | No |
| CDP bridge deps | Yes | Yes |
| rn-fast-runner (iOS) | iOS targets only | Prebuilt artifact on releases; one-time `xcodebuild build-for-testing` fallback |
| rn-android-runner (Android) | Android targets only | See [Android runner provisioning](packages/qaren-cli/README.md#android-runner-provisioning) |
| [maestro-runner](https://github.com/devicelab-dev/maestro-runner) | Yes | Yes (pin-cache engine `>= 1.1.28`, attested 1.1.28 checksum-verified) |
| iOS Simulator / Android Emulator | One platform | No |
| Session-bound Metro | Yes | Project integration starts or validates it through literal `pnpm ios` / `pnpm android` |
| CDP connection | Yes | `rn_session` owns the binding; `cdp_status` is passive and `cdp_connect` pins the exact target |
| ffmpeg | Optional (proof videos; required for strict iOS proof) | Yes |
| idb + idb-companion | Optional (smooth observe-UI mirroring) | Yes |

Claude automation failures and Codex missing prerequisites are reported with step-by-step manual
instructions.

<a id="prebuilt-runners"></a>

**Prebuilt iOS runner:** QaReN accepts only artifacts for its exact runtime version,
including the prerelease suffix. Both cached and downloaded archives must match the
manifest's SHA-256 and carry a matching `qaren-runner.json` build identity before use.
Manifest, asset-name and archive-identity mismatches refuse with `RUNNER_VERSION_MISMATCH`.
Legacy 1.x release versions always select the shipped source, so an unreleased QaReN build
that still reports a 1.x version cannot download or reuse a published 1.x runner.
Offline downloads, checksum failures and checkouts without a runner manifest fall back
to building locally. Force local builds with `RN_RUNNER_BUILD=local`.

For Android, see [Android runner provisioning](packages/qaren-cli/README.md#android-runner-provisioning).

When an iOS runner launched from a prebuilt lacks required capabilities or commands,
startup attempts to persist a `stale` marker under
`~/.qaren/runtime/runners/<plugin-version>/ios/` before checking the one-rebuild-per-version
budget. With that marker present, later starts select the local runner without reusing or
downloading that version's prebuilt, including after a process restart; cached products
remain intact and other versions are unaffected. A spent rebuild budget still refuses
the current start. Authority mismatches and stale local runners do not mark the prebuilt.
If the marker cannot be written, the rebuild budget still applies, but persistent
rejection is not guaranteed.

</details>

### What your app needs

**Most apps need zero setup** — the plugin reads the React fiber tree directly via Metro's CDP
endpoint. Redux is auto-detected.

**Zustand stores** — one line in your app entry
([details](https://lykhoyda.github.io/rn-dev-agent/getting-started/#zustand-stores-one-bridge-call)):

```typescript
if (__DEV__) {
  global.__ZUSTAND_STORES__ = { auth: useAuthStore, cart: useCartStore };
}
```

**testIDs** — add to interactive elements for reliable queries:

```tsx
<Pressable testID="checkout-button" onPress={handleCheckout}>
  <Text testID="cart-badge">{itemCount}</Text>
</Pressable>
```

---

## Benchmarks

| Complexity | Time | Crashes | Manual interventions |
|-----------|------|---------|---------------------|
| Simple (search, toggle, store) | 3–5 min | 0 | 0 |
| Medium (forms, charts, lists) | 5–10 min | 0 | 0 |
| Complex (3-step wizard, onboarding) | 11–25 min | 0 | 0 |

**Libraries verified end-to-end:** react-hook-form, zod, @tanstack/react-query,
@gorhom/bottom-sheet, @shopify/flash-list, zustand, react-native-svg, expo-notifications,
react-native-reanimated, react-native-gesture-handler, expo-haptics

[Full benchmarks →](https://lykhoyda.github.io/rn-dev-agent/benchmarks/)

## Security

The `cdp_evaluate` tool runs arbitrary JavaScript in your app's Hermes runtime with full access to
the component tree, store state, AsyncStorage, and any in-memory secrets. This is **intentional** —
runtime introspection is what makes the plugin useful — but it means **only run this plugin against
apps where you trust the agent's prompts**.

- **Local dev environments only.** Do not point the plugin at production builds, store-signed apps, or any app holding real user data.
- **Treat the agent like a developer with shell access to your laptop.** Any prompt that reaches `cdp_evaluate` (directly or through another tool) can read or mutate your app's runtime state.
- **Use the fenced session as CDP authority.** `rn_session` binds the intended worktree, Metro, app, and device; `cdp_targets` may explain ambient Hermes processes but never authorizes selecting one. See [Parallel session authority](https://lykhoyda.github.io/rn-dev-agent/session-authority/).

The plugin makes no attempt to sandbox `cdp_evaluate`. If you need that, gate tool access through
your agent's permission prompts rather than trusting the tool layer.

<details>
<summary><strong>What the observability UI and the local evidence store record</strong></summary>

The **observability UI** ([`/rn-dev-agent:observe`](https://lykhoyda.github.io/rn-dev-agent/commands/observe/))
binds to `127.0.0.1` only and rejects cross-origin requests via Host-header + `Sec-Fetch-Site`
checks. It is read-only except for two deliberate, CSRF-token-gated endpoints that trigger action
and locked-E2E replays. Tool arguments are deep-redacted fail-closed before reaching the stream and
typed fill text is never streamed verbatim (see the
[security posture](https://lykhoyda.github.io/rn-dev-agent/commands/observe/#security-posture) for
what is redacted and what stays visible), and the recorder keeps only a small bounded in-memory
ring buffer — the event stream itself never touches disk (action RunRecords and locked-E2E run
output follow the session state directory: fenced sessions use their session-private runtime state,
while an unfenced process uses `.rn-agent/state/` for actions and `.rn-agent/state/e2e-runs/` for
E2E history; `.rn-agent/e2e/` contains the locked test definitions).

Meaningful tool failures and immediate successful retries also feed a separate, local-only evidence
store at `~/.claude/rn-agent/experience/patterns.jsonl`. Records are sanitized before writing,
deduplicated, capped at 500 patterns, and retained for 14 days; ordinary successful calls are never
stored. Runner failures, failed `cdp_run_action` or `maestro_run` calls, and recognized authority
refusals may also retain up to five sanitized diagnostics bundles alongside that store, each capped
at 200 typed lifecycle events and 256 KB for reviewed feedback or an explicit `collect_logs` export.
From an installed plugin package, inspect the read-only trend report with
`node <plugin-package>/rn-dev-agent-core/dist/experience-trends.js --since <previous-report-ISO-timestamp>`
(omit `--since` for the last 24 hours; it only scopes the new-pattern list, other totals cover all
retained history). Recognized authority refusals are also grouped per code and platform across
tools; those groups describe retained history only and never claim recovery or a currently blocked
session. The command never updates the evidence store or uploads data.

</details>

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Metro not found" | Inspect `rn_session(action="status")`, then use literal `pnpm ios` or `pnpm android` through the confirmed project integration |
| "No Hermes target" | Open the bound app, inspect passive `cdp_status`, then use `cdp_connect` to pin the exact signed target |
| CDP rejected (1006) | Close React Native DevTools, Flipper, or Chrome DevTools |
| Zustand store error | Add `global.__ZUSTAND_STORES__` ([setup](https://lykhoyda.github.io/rn-dev-agent/getting-started/#zustand-stores-one-bridge-call)) |
| Plugin not detected (Claude) | `/plugin install rn-dev-agent@rn-dev-agent` then `/reload-plugins` |
| Plugin not detected (Cursor) | Customize → Plugins. Reload the window. Requires Node.js >= 24 |
| Subagent says "MCP tools unavailable" | Never spawn `rn-tester`/`rn-pr-qa`/`rn-debugger` via the Task tool — use `/rn-dev-agent:test-feature`, `/rn-dev-agent:qa-pr`, or `/rn-dev-agent:debug-screen` instead (GH #31) |

<details>
<summary><strong>More: host recovery, device runners, wedged simulators</strong></summary>

| Problem | Solution |
|---------|----------|
| Plugin not detected (Codex) | Inspect with `codex plugin list --json` and `/mcp verbose`; user-confirm `codex plugin add rn-dev-agent@rn-dev-agent --json`, then relaunch after external changes |
| Codex tools fail after upgrade | `/mcp verbose` inspects only. Relaunch Codex for external/manual changes or legacy hosts; never kill another host's bridge |
| Blank white screen after many reloads | NativeWind stylesheet corruption after 5+ `cdp_reload` cycles — kill and restart Metro, relaunch the app |
| `device_scroll` times out on Reanimated screens | A `waitForIdle` round-trip can deadlock against Reanimated worklets; scroll routes through the in-tree runner's HID synthesis instead. Ensure the runner is healthy via the device session |
| Legacy `AgentDeviceRunner` re-appears on iOS | Stale `~/.agent-device/daemon.json` respawns the upstream runner. The plugin terminates stale processes at session-open (opt out: `RN_DEVICE_KILL_LEGACY=0`); manual cleanup: `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.{json,lock}` |
| iOS "rn-fast-runner did not become ready" | The runner self-build timed out or failed. In a source checkout, pre-build once: `cd packages/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "platform=iOS Simulator,id=<UDID>" -derivedDataPath ../build/DerivedData` |
| `device_fill` reports `TEXT_ENTRY_UNVERIFIED` | A fill attempt ran, but stable exact read-back could not prove the requested value. Check `meta.mutation`: retry from a fresh snapshot only when it is `none`; for `observed` or `possible`, read and rebind the field before correcting it so a blind retry cannot double-type |
| Need an intentional coordinate tap | Use `device_press({x, y})` (or a batch press step with `x`/`y`). With a visible iOS keyboard, raw coordinates are geometry-unknown: the keyboard is proven hidden before the one tap. Prefer fresh refs for normal UI controls |
| Native logs include another device/app | Reopen the exact device session. `collect_logs` pins Android to that session's adb serial and iOS to that simulator plus the current target-app PID; it fails closed when exact scope cannot be resolved. When the probe runs and proves the app is not running, the stream stays pinned to that simulator and reports `scopes.native_ios.process = app-not-running-device-scoped` so a crash trail is still captured |
| Want XCTest's stock idle-waits back | Kill the running runner (`pkill -f RnFastRunnerUITests`), set `RN_QUIESCENCE_BYPASS=0`, reopen the device session, and inspect the next device result's `meta.quiescenceBypass` |
| Seeing `meta.reResolved` / `meta.noUiChange` | Stale-ref healing at work; `meta.noUiChange` means the iOS tap was dispatched but changed nothing. Disable ref healing with `RN_SELF_HEAL=0` (`retryIfNoChange` is a deprecated no-op — taps are never replayed) |

</details>

[Full troubleshooting guide →](https://lykhoyda.github.io/rn-dev-agent/troubleshooting/)

## Keeping up to date

Enable auto-update in the host plugin manager, or update manually:

```text
Claude: /plugin update rn-dev-agent@rn-dev-agent
        /reload-plugins
Cursor: Customize → Plugins, then Developer: Reload Window
Codex:  codex plugin marketplace upgrade rn-dev-agent
        codex plugin add rn-dev-agent@rn-dev-agent --json
        # relaunch after this external mutation
```

Release notes: [GitHub Releases](https://github.com/Lykhoyda/rn-dev-agent/releases) · [core changelog](packages/qaren-core/CHANGELOG.md)

<details>
<summary><strong>Development — building from source</strong></summary>

See the [CLI build instructions](packages/qaren-cli/README.md#build) for the
current checkout and [repository guide](AGENTS.md) for package ownership,
validation commands and changeset mechanics.

</details>

---

<div align="center">

### Stop taking your agent's word for it.

**[Install it in 60 seconds →](#see-it-in-60-seconds)**

**[Read the docs](https://lykhoyda.github.io/rn-dev-agent/)** · **[Star the repo](https://github.com/Lykhoyda/rn-dev-agent)** · **[Report a bug](https://github.com/Lykhoyda/rn-dev-agent/issues/new)** or run `/rn-dev-agent:send-feedback`

Free · open source · MIT

</div>
