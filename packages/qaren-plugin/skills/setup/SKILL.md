---
name: setup
description: "Set up QaReN in this app: install the qaren CLI onto PATH, write .qaren/config.yaml, pick the simulator and discover the route to the usable main screen. Use for /qaren:setup, first use in an app, or when qaren is not found."
---

# Set up QaReN

Run these steps in order from the selected app root. Before any setup effects, **read** [Project QA workflow](../using-qaren/references/project-qa.md), resolving that path from this skill's directory. Perform initial and refresh guide admissions in their own metadata-only tool calls, with no file-content reads or hashes of any file batched into them. Observe each admission result before any later content/hash call for optional `.qaren/QA.md`, then apply its ready-route, coverage and evidence steps. Use already assigned routine setup authority; resolve only genuine missing facts, scope or custody boundaries. When a step stops, report the affected work and the fix; continue independent authorized coverage.

QaReN 2.0 needs an Apple silicon Mac with Xcode, Node 24 or newer, pnpm, and an Expo app that uses `expo-dev-client`. This setup prepares an iOS simulator; for a booted Android emulator, see the CLI README's [Check a plan](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#check-a-plan).

## 1. CLI

The plugin root is two directories above this skill's base directory. Resolve one absolute qaren path and use it for every later `qaren` command in this session:

1. Run `bash <plugin root>/scripts/ensure-qaren.sh --print-bin`. If it prints an absolute path ending in `/bin/qaren`, that is the plugin-verified binary; use it and go to step 2.
2. Otherwise run `bash <plugin root>/scripts/ensure-qaren.sh --install`. Use its printed binary path and pass the user any stderr notice about PATH or an existing command. The [CLI installation guide](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#plugin-runtime-installation) owns the verification, PATH-linking and fallback contract.
3. If it refuses because this plugin version carries no qaren tarball, QaReN is not released yet. If `command -v qaren` resolves, through links, to a binary under `~/.qaren/runtime/` and `qaren --version` prints `qaren <version>` with the `version` in `<plugin root>/.claude-plugin/plugin.json`, it is a source install made through the same verified installer; use that resolved path. Otherwise tell the user the one line to run from a `develop` checkout of `Lykhoyda/rn-dev-agent`, and offer to run it for them if they give the checkout path; it needs Rust (https://rustup.rs) as well and prints the binary path to use:

   ```sh
   bash scripts/install-qaren-from-source.sh
   ```

4. Any other refusal: stop and quote the installer's message.

`<qaren path> doctor` lists what is missing before setup continues.

## 2. App

- `package.json` must list `expo` and `expo-dev-client`, and `pnpm-lock.yaml` must exist. Otherwise stop: "QaReN supports pnpm Expo dev-client apps."
- If `node_modules` is absent, run `pnpm install` within existing setup authority; ask only when dependency installation is outside that authority.
- Run `pnpm exec expo config --type public --json`. Take `appId` from `ios.bundleIdentifier` and set `devClientScheme` to `exp+<slug>`, where `<slug>` is the config's `slug`; `expo-dev-client` registers that scheme unless its config plugin sets `addGeneratedScheme: false`, in which case use the established registered scheme or resolve that missing value. Expo may print status lines before the JSON document; parse that document.
- If the command fails (for example it needs environment variables) or either value is missing, use already established assignment facts or ask only for the missing bundle identifier/dev-client scheme. Never invent environment variables or values.

## 3. Config

If `.qaren/config.yaml` exists, compare it privately with the detected values and preserve it. If `appId` or `devClientScheme` differs, stop the affected setup until the owner resolves the mismatch; change existing config only within explicit authority. Otherwise write exactly:

```yaml
appId: <bundle identifier>
devClientScheme: exp+<slug>
```

The keys and their validation are owned by the CLI's [`config.rs`](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/src/config.rs).

## 4. Device

Honor an already assigned device and custody first. Otherwise read the simulator inventory; never boot, shut down or erase a simulator yourself:

```sh
xcrun simctl list devices booted -j
```

- One booted simulator: pass no device flag.
- None booted: choose the newest available iPhone from `xcrun simctl list devices available -j` and pass `--boot-device --device <udid>`; qaren boots it under its device lease.
- Several booted without an assigned target: resolve which one, then pass `--device <udid>`.

## 5. Smoke and ready-route plans

Read the app's launch path in source (its root navigator and any auth gate) and pick one static text the user sees on the screen the app opens on; the `✓` check reads visible text, so never use a `testID` there. Never assume the signed-out screen: when a saved sign-in decides where the app opens, an earlier install's session on that simulator survives this run, so pick a text shown on launch both signed in and signed out, or use supported run evidence to establish the current screen; ask only when that fact remains unresolved. Write `.qaren/plans/smoke.md`, quoted targets only:

```markdown
## QA

### First screen

1. Wait for "<text>" to appear
✓ "<text>"
```

This plan needs no `TYPESAFE_API_KEY`. It proves admission only. Inventory any assigned feature criteria and inspect existing actions/full plans. Derive the observable usable-state criterion and actual launch-to-ready route, including authorized login, onboarding, custom flows and animation/loading pages, using the shared workflow. Prepare a full ready-route plan when the current state is known; use an absolute owner-private plan path for sensitive literals. Refresh guidance before each plan and invocation.

## 6. Run

The first run builds and installs the app; a cold native build can take longer than 10 minutes, and Claude Code stops both foreground and background commands at that limit. Start the check detached from the host, with `sh` staying resident as its parent: qaren cancels a run whose calling process exits, so never background `qaren` itself with `&` or `nohup`.

First create the output directory and note the path it prints as `<dir>`:

```sh
mktemp -d "${TMPDIR:-/tmp}/qaren-setup.XXXXXX"
```

Then start the check; this command returns at once:

```sh
nohup sh -c '<qaren path from step 1> check --plan-file .qaren/plans/smoke.md [device flags from step 4] --json > <dir>/receipt.json 2> <dir>/progress.log; echo $? > <dir>/exit' < /dev/null > /dev/null 2>&1 &
```

Within a minute `<dir>/progress.log` contains `▸ watch live: qaren watch <run-id>`; tell the user they can follow the run live with `qaren watch <run-id>` in their own terminal. If `<dir>/exit` appears first, the check refused before its run started, so go to the receipt, or to `<dir>/progress.log` when the receipt is empty. Otherwise follow the run in short calls that each end well within the host's limit, repeating until `<dir>/exit` exists:

```sh
for i in $(seq 20); do [ -s <dir>/exit ] && break; sleep 5; done; tail -n 3 <dir>/progress.log
```

Stopping a poll never affects the run. If `<dir>/exit` never appears, `<qaren path> status <run-id> --json` reports the run's state and its next action.

Once `<dir>/exit` exists, read `<dir>/receipt.json`; if empty, retain the exit code and diagnostic from `<dir>/progress.log` as a missing-result gap. Otherwise report the receipt's `result`, `run_id` and `next_action`; for non-pass, preserve `failure.code` and `failure.next_action` verbatim if present. Handle cleanup through the existing ownership rules, within assigned authority. A refusal remains a boundary, not an invitation to bypass it.

After smoke, execute the ready-route plan using the same supervised run pattern and private output handling. Preserve failures, then replan only from new supported evidence within the assignment's budget. Inspect actual save outcomes and prove eligible routes by safe clean replay as the shared workflow requires. Report smoke, observed ready state, saved/not-saved status and clean replay separately. If readiness or replay is unavailable, name its exact gap; continue independent rows. Carry any existing feature assignment into `using-qaren` through all criteria rather than ending at smoke. Record guide digests, coverage, private evidence custody and cleanup in the task report.
