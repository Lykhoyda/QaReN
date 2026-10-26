# QaReN

QA a React Native app on a simulator from a Markdown plan, and read back PASS or FAIL
with evidence.

[![CI](https://github.com/Lykhoyda/QaReN/actions/workflows/ci.yml/badge.svg)](https://github.com/Lykhoyda/QaReN/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-lykhoyda.github.io%2FQaReN-blue)](https://lykhoyda.github.io/QaReN/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

QaReN is the `qaren` command-line tool and a plugin for Claude Code and Codex.
`qaren check` borrows a booted iOS simulator, builds and installs the app from your
working tree, starts Metro, walks a plan on the device, writes evidence under
`~/.qaren/runs/<run-id>/` and tears down what it started. `qaren pr` does the same for a
pull request's head and tries to record the screen; `qaren publish` comments the result on the
pull request and can push saved blocks to its branch. Eligible passing blocks are saved under `.qaren/actions/` and replayed on later
runs.

A plan names what to do and what to check:

```md
## QA

### Skip onboarding

1. Tap "onboarding-skip"
2. Wait for "Welcome" to appear
✓ "Welcome"
```

## Requirements

- An Apple silicon Mac with Xcode.
- Node 24 or newer, with Corepack, and `pnpm` on `PATH`.
- An Expo app that uses `expo-dev-client` and pnpm, with a `pnpm-lock.yaml`.

## Set up QaReN

Install the plugin:

```sh
# Claude Code
claude plugin marketplace add Lykhoyda/QaReN
claude plugin install qaren@qaren
# Codex
codex plugin marketplace add Lykhoyda/QaReN
codex plugin add qaren@qaren
```

Then, from your app's root, run `/qaren:setup` (in Codex, ask it to set up QaReN). Setup
installs the `qaren` CLI when the matching GitHub release asset is available,
verifying the tarball against the plugin's
[runner manifest](packages/qaren-plugin/runner-manifest.json), runs
`qaren doctor`, writes `.qaren/config.yaml` and a smoke plan, picks a simulator and runs
the first check. The [setup skill](packages/qaren-plugin/skills/setup/SKILL.md) owns
the details. If the installed plugin has no QaReN tarball yet, use the
[source installation](#install-from-source) below.

Setup prepares an iOS simulator. `qaren check` and `qaren pr` can also borrow a booted
Android emulator with `--platform android`, given the Android SDK and a running adb
server; see [Check a plan](packages/qaren-cli/README.md#check-a-plan).

### Install from source

To run an unreleased build, install from a checkout's root (needs Rust/Cargo as well):

```sh
bash scripts/install-qaren-from-source.sh
```

Load that checkout's plugin with
`claude --plugin-dir /absolute/path/to/checkout/packages/qaren-plugin`. The
[installation contract](packages/qaren-cli/README.md#plugin-runtime-installation) covers
PATH linking and existing-command protection.

## Use it

```sh
qaren check --plan-file plan.md --json      # check the working tree
qaren watch --latest                        # follow a run from a second terminal
qaren pr <number|url> --plan-file plan.md --json
qaren publish <run-id> --json
```

`qaren publish` needs an authenticated `gh`. Read
[Test a pull request](packages/qaren-cli/README.md#test-a-pull-request) before running
it: it comments on the pull request, can push saved blocks to its branch and can remove the
`needs-qa` label, and its redaction does not make private material safe to post.

The `using-qaren` skill writes plans for a feature and runs them. The
[CLI guide](packages/qaren-cli/README.md) covers
[plans and receipts](packages/qaren-cli/README.md#check-a-plan),
[saved blocks](packages/qaren-cli/README.md#saved-blocks),
[pull requests](packages/qaren-cli/README.md#test-a-pull-request) and
[watching a run](packages/qaren-cli/README.md#watch-a-run).

## Keep it working

Run `qaren doctor` to diagnose the host, the install and rn-dev-agent 1.x leftovers; see
[Doctor](packages/qaren-cli/README.md#doctor).

To update a released install, update the plugin in your host. Claude Code's next session
prints the command that installs the matching `qaren`; running setup again installs it
too. A source
install updates with `qaren update` from the checkout root, which fast-forwards,
rebuilds and reinstalls, and refuses a checkout with local changes.

<a id="prebuilt-runners"></a>

**Prebuilt iOS runner:** QaReN accepts only artifacts for its exact runtime version,
including the prerelease suffix, downloaded from that version's release tag and matching the
manifest's SHA-256. A matching manifest that names another release's archive refuses with
`RUNNER_VERSION_MISMATCH`. Legacy 1.x release versions always select the shipped source, so an
unreleased QaReN build that still reports a 1.x version cannot download or reuse a published 1.x
runner. A manifest for another version, offline downloads, checksum failures and checkouts
without a runner manifest fall back to building locally. Force local builds with `RN_RUNNER_BUILD=local`.

When an iOS runner launched from a prebuilt lacks required capabilities or commands,
startup attempts to persist a `stale` marker under
`~/.qaren/runtime/runners/<plugin-version>/ios/` before checking the one-rebuild-per-version
budget. With that marker present, later starts select the local runner without reusing or
downloading that version's prebuilt, including after a process restart; cached products
remain intact and other versions are unaffected. A spent rebuild budget still refuses
the current start. Authority mismatches and stale local runners do not mark the prebuilt.
If the marker cannot be written, the rebuild budget still applies, but persistent
rejection is not guaranteed.

## Upgrading from rn-dev-agent 1.x

QaReN 2.0 replaces the rn-dev-agent 1.x plugin and its MCP server, with no compatibility
layer: it does not read 1.x configuration, caches or learned actions. Remove 1.x first,
then install 2.0 as a new product; follow
[Upgrading from rn-dev-agent 1.x](packages/qaren-cli/README.md#upgrading-from-rn-dev-agent-1x-1014-to-20).
The 1.x source stays on the
[`rn-dev-agent-1.0`](https://github.com/Lykhoyda/QaReN/tree/rn-dev-agent-1.0) branch.

## Development

See the [CLI build instructions](packages/qaren-cli/README.md#build) and the
[repository guide](AGENTS.md) for package ownership, validation commands and changesets.
Report bugs in [GitHub Issues](https://github.com/Lykhoyda/QaReN/issues) or with
`/qaren:feedback`; see [SECURITY.md](SECURITY.md) for vulnerabilities.

QaReN is released under the [MIT License](LICENSE).
