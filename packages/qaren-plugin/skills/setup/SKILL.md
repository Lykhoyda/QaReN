---
name: setup
description: "Set up QaReN in this app: install the qaren CLI onto PATH, write .qaren/config.yaml, pick the simulator and run a first smoke check. Use for /qaren:setup, first use in an app, or when qaren is not found."
---

# Set up QaReN

Run these steps in order from the app's root directory. Each step names when to stop; when you stop, tell the user the one reason and the fix.

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

Run `<qaren path> doctor` before setup continues. Stop on a `FAIL` and give its fix.
Present `host-memory`, `host-devices`, `simulator-service` and `host-load` warnings
with their next steps before the smoke run; use the conservative lane recommendation
in the [host budget](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#host-budget).
If memory or CPU is constrained, recommend fewer concurrent lanes and closing
unneeded apps. Ask the owner to shut down an affected borrowed device; restarting
CoreSimulatorService stops every simulator on the machine. Setup never performs
either action. A warning permits setup to continue; an unknown probe is not a healthy host.

## 2. App

- `package.json` must list `expo` and `expo-dev-client`, and `pnpm-lock.yaml` must exist. Otherwise stop: "QaReN supports pnpm Expo dev-client apps."
- If `node_modules` is absent, ask before running `pnpm install`.
- Run `pnpm exec expo config --type public --json`. Take `appId` from `ios.bundleIdentifier` and set `devClientScheme` to `exp+<slug>`, where `<slug>` is the config's `slug`; `expo-dev-client` registers that scheme unless its config plugin sets `addGeneratedScheme: false`, in which case ask. Expo may print status lines before the JSON document; parse that document.
- If the command fails (for example it needs environment variables) or either value is missing, ask the user for the bundle identifier and the dev-client scheme. Never invent environment variables or values.

## 3. Config

If `.qaren/config.yaml` exists, show it next to the detected values and change nothing without the user's consent; if its `appId` or `devClientScheme` differs from the detected values, stop until the user resolves it. Otherwise write exactly:

```yaml
appId: <bundle identifier>
devClientScheme: exp+<slug>
```

The keys and their validation are owned by the CLI's [`config.rs`](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/src/config.rs).

If the operator supplies custom registry credential environment names, optionally
add `registryAuthEnv: [PRIVATE_REGISTRY_TOKEN]` using names only, never values.
Keep the default configuration above minimal; obtain names from the operator
rather than reading auth stores to detect them. The list exposes inherited
variables to install/prebuild descendants and withholds their output; follow the
[CLI registry-auth policy](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#check-a-plan), including reserved names and the prewarm-fetch exclusion.

## 4. Device

Read the simulator inventory; never boot, shut down or erase a simulator yourself:

```sh
xcrun simctl list devices booted -j
```

- One booted simulator: pass no device flag.
- None booted: choose the newest available iPhone from `xcrun simctl list devices available -j` and pass `--boot-device --device <udid>`; qaren boots it under its device lease.
- Several booted: ask the user which one, then pass `--device <udid>`.

## 5. Smoke plan

Read the app's launch path in source (its root navigator and any auth gate) and pick one static text the user sees on the screen the app opens on; the `✓` check reads visible text, so never use a `testID` there. Never assume the signed-out screen: when a saved sign-in decides where the app opens, an earlier install's session on that simulator survives this run, so pick a text shown on launch both signed in and signed out, or ask the user which screen the app opens on now. Write `.qaren/plans/smoke.md`, quoted targets only:

```markdown
## QA

### First screen

1. Wait for "<text>" to appear
✓ "<text>"
```

This plan needs no `TYPESAFE_API_KEY`.

## 6. Run

The first run builds and installs the app; a cold iOS build needs about 10 GiB free on the home and app volumes (`check` refuses `DISK_BUDGET_EXCEEDED` with less) and can take longer than 10 minutes, and Claude Code stops both foreground and background commands at that limit. Start the check detached from the host, with `sh` staying resident as its parent: qaren cancels a run whose calling process exits, so never background `qaren` itself with `&` or `nohup`.

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

Once `<dir>/exit` exists, read `<dir>/receipt.json`; if it is empty, report the exit code and the diagnostic from `<dir>/progress.log` and stop. Otherwise report the receipt's `result`, `run_id` and `next_action`. When `result` is not `pass`, quote `failure.code` and `failure.next_action` verbatim if present and stop. When a `pass` receipt's `next_action` is a `qaren cleanup` command, teardown was incomplete: offer to run it. On `pass`, continue to step 7.


## 7. Sign-in (optional)

If the launch path read in step 5 has no auth gate, setup is complete; use `using-qaren` for a feature plan. Otherwise offer to save a reusable sign-in block. Start it on the sign-in screen; put any sign-out steps in their own block above it. Use visible labels when the app has no testIDs. Write a `### Sign in` block using names only:

```markdown
### Sign in

1. Fill "<username field>" with input USERNAME
2. Fill "<password field>" with input PASSWORD
3. Tap "<sign-in button>"
✓ "<signed-in text>"
```

When the app echoes an input, add a numbered `Expect input USERNAME on screen` step before the fill. Ask the user to export `QAREN_INPUT_USERNAME` and `QAREN_INPUT_PASSWORD` from their password manager in their own shell; keep values out of plans, messages and tool output. Ensure the check inherits that shell's inputs. Use the same app configuration and device flags as step 6; for a label-only app, follow the README's [runtime-input prerequisites](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#runtime-inputs).

Run this plan once using step 6's run-and-wait procedure. Read the receipt's `hints` and stderr: when `LOGIN_BLOCK_CANDIDATE` prints `loginBlock` and `loginMarker`, show those lines and paste them into `.qaren/config.yaml` only with the user's consent, as in step 3. If `LOGIN_BLOCK_SIGNS_OUT` appears, split out the sign-out steps and re-save the sign-in block before configuring it. Follow `CORPUS_NOT_SHARED` when working in a linked worktree. If no block was saved, read `blocks_not_saved` and resolve its reason; do not invent a marker or login configuration.

Confirm `<qaren path> doctor` reports the saved login for the selected platform. Every later run needs the configured login block's `QAREN_INPUT_<NAME>` variables. The [worked example](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#reusable-sign-in-example) covers setup, replay and worktrees. QaReN is now set up; use `using-qaren` for a feature plan.
