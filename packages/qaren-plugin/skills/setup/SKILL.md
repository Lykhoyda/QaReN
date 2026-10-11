---
name: setup
description: "Set up QaReN in this app: install the qaren CLI onto PATH, write .qaren/config.yaml, pick the simulator and run a first smoke check. Use for /qaren:setup, first use in an app, or when qaren is not found."
---

# Set up QaReN

Run these steps in order from the app's root directory. Each step names when to stop; when you stop, tell the user the one reason and the fix.

QaReN 2.0 needs an Apple silicon Mac with Xcode, Node 24 or newer, pnpm, and an Expo app that uses `expo-dev-client`. iOS simulators only.

## 1. CLI

If `command -v qaren` finds it and `qaren --version` succeeds, skip to step 2.

Otherwise run the plugin's installer. The plugin root is two directories above this skill's base directory:

```sh
bash <this skill's directory>/../../scripts/ensure-qaren.sh --install
```

- It prints the installed binary path and links `~/.local/bin/qaren` to it.
- If it says `~/.local/bin` is not on PATH, use the printed absolute path for every `qaren` command in this session, and pass the user the `export PATH=…` line it printed.
- If it refuses because this plugin version carries no qaren tarball, QaReN is not released yet. Tell the user the one line to run from a `develop` checkout of `Lykhoyda/rn-dev-agent`, and offer to run it for them if they give the checkout path:

  ```sh
  bash scripts/install-qaren-from-source.sh
  ```

  It needs Rust (https://rustup.rs) as well, and prints the binary path the same way.
- Any other refusal: stop and quote the installer's message.

## 2. App

- `package.json` must list `expo` and `expo-dev-client`, and `pnpm-lock.yaml` must exist. Otherwise stop: "QaReN supports pnpm Expo dev-client apps."
- If `node_modules` is absent, ask before running `pnpm install`.
- Run `pnpm exec expo config --type public --json`. Take `appId` from `ios.bundleIdentifier` and set `devClientScheme` to `exp+<slug>`, where `<slug>` is the config's `slug`.
- If the command fails (for example it needs environment variables), ask the user for the bundle identifier and the dev-client scheme. Never invent environment variables or values.

## 3. Config

If `.qaren/config.yaml` exists, show it next to the detected values and change nothing without the user's consent. Otherwise write exactly:

```yaml
appId: <bundle identifier>
devClientScheme: exp+<slug>
```

The keys and their validation are owned by the CLI's [`config.rs`](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/src/config.rs).

## 4. Device

Read the simulator inventory; never boot, shut down or erase a simulator yourself:

```sh
xcrun simctl list devices booted -j
```

- One booted simulator: pass no device flag.
- None booted: choose the newest available iPhone from `xcrun simctl list devices available -j` and pass `--boot-device --device <udid>`; qaren boots it under its device lease.
- Several booted: ask the user which one, then pass `--device <udid>`.

## 5. Smoke plan

Read the app's first screen in source and pick one static text the user sees there, or a `testID`. Write `.qaren/plans/smoke.md`, quoted targets only:

```markdown
## QA

### First screen

1. Wait for "<text>" to appear
✓ "<text>"
```

This plan needs no `TYPESAFE_API_KEY`.

## 6. Run

```sh
qaren check --plan-file .qaren/plans/smoke.md [device flags from step 4] --json
```

The first run builds and installs the app, so it takes minutes. Report the receipt's `result` and `run_id`. On anything but `PASS`, quote `failure.code` and `failure.next_action` verbatim and stop. On `PASS`, QaReN is set up: next, the `using-qaren` skill writes a plan for a feature.
