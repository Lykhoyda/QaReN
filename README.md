# QaReN

**A QA engineer for your coding agent.** Claude Code, Codex or Cursor writes the React
Native change; QaReN tries it in your app on an iOS simulator and comes back with PASS or FAIL,
and the evidence behind it.

[![CI](https://github.com/Lykhoyda/QaReN/actions/workflows/ci.yml/badge.svg)](https://github.com/Lykhoyda/QaReN/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-lykhoyda.github.io%2FQaReN-blue)](https://lykhoyda.github.io/QaReN/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A coding agent checks its work with types, lint and unit tests. It does not tap through
the app, so a screen that never appears or a flow that breaks halfway reaches review, or
your users. QaReN is the QA engineer on your agent's team: ask your agent to QA a change,
it writes a short plan of what to check, and QaReN runs that plan in the real app.

- **A verdict, not a summary.** Every run ends in PASS, FAIL or a refusal with a typed
  reason and the next action, as JSON for your agent and an exit code for your scripts.
- **Evidence you can open.** Each run keeps a step-by-step ledger and a readable report.
  A pull request run adds a screen recording when one can be captured and can post the
  result as a comment.
- **It tests what you changed.** QaReN builds your working tree or a pull request's head,
  and a change to the code during the walk can never pass.
- **Faster on every run.** Eligible passing blocks are saved and replayed next time by
  the exact elements they used.

Read the [docs](https://lykhoyda.github.io/QaReN/), or [set it up](#set-up-qaren) in your
agent.

## How it works

Under the hood, QaReN is the `qaren` command-line tool and a plugin that teaches Claude
Code, Codex and Cursor to drive it. `qaren check` borrows a booted iOS simulator, builds and
installs the app from your working tree, starts Metro, walks a plan on the device, writes
evidence at the artifact paths in its receipt and tears down what it started. `qaren pr` does
the same for a pull request's head and tries to record the screen; `qaren publish`
comments the result on the pull request and can push saved blocks to its branch. Eligible
passing blocks are saved under `.qaren/actions/` and replayed on later runs.

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
- Node 24 or newer, with Corepack, and `pnpm` on `PATH` (see [launcher compatibility](packages/qaren-cli/README.md#doctor)).
- An Expo app that uses `expo-dev-client` and pnpm, with a `pnpm-lock.yaml`.

## Set up QaReN

Choose one of three installation options. QaReN 2.0 supports iOS simulators on Apple silicon.

### Ask your agent to install (recommended)

Open Claude Code, Codex or Cursor in your app and paste this prompt. The
[getting started page](https://lykhoyda.github.io/QaReN/getting-started/#ask-your-agent-to-install-recommended)
has a copy button for the same prompt.

```text
Set up QaReN in this app, from the app root, for my current host
(Claude Code, Codex or Cursor).

Check that this is an Apple silicon Mac and a pnpm Expo app using
expo-dev-client with pnpm-lock.yaml. Install missing Node 24 or newer,
Corepack and pnpm using user-writable locations. Check that full Xcode
and an iOS simulator runtime are installed and ready. If a prerequisite
needs administrator access, a license agreement or a manual download,
stop and tell me the exact step I need to complete. Do not use sudo.

Install the QaReN plugin for my host using the per-host instructions at
https://github.com/Lykhoyda/QaReN#install-the-plugin-yourself
If the host needs a plugin UI step or a session restart, tell me what to
do and resume setup once the plugin is available.

Run /qaren:setup; if slash commands are unavailable, load and follow the
plugin's setup skill. It owns installing the matching qaren CLI, running
qaren doctor, configuring this app and selecting the iOS simulator.
Follow its source-install fallback only if the release is unavailable.
Use the matching binary path it resolves; preserve any existing qaren
command on PATH and keep the default QaReN home and installer options.

Follow setup through writing .qaren/plans/smoke.md and running the first
smoke check. Read the receipt and report result, run_id and next_action.
If setup or the check stops, report the exact reason and fix; do not
claim success before a passing receipt.
```

### Install the plugin yourself

If the prerequisites above are already installed, use your host's commands:

```sh
# Claude Code
claude plugin marketplace add Lykhoyda/QaReN
claude plugin install qaren@qaren
# Codex
codex plugin marketplace add Lykhoyda/QaReN
codex plugin add qaren@qaren
# Cursor: add the marketplace, then install qaren from /plugin > Marketplace in
# cursor-agent, or from Customize > Plugins in the editor
cursor-agent plugin marketplace add https://github.com/Lykhoyda/QaReN
```

Then, from your app's root, run `/qaren:setup` (in Codex or Cursor, ask it to set up
QaReN). Setup
installs the `qaren` CLI when the matching GitHub release asset is available,
verifying the tarball against the plugin's
[runner manifest](packages/qaren-plugin/runner-manifest.json), runs
`qaren doctor`, writes `.qaren/config.yaml` and a smoke plan, picks a simulator and runs
the first check. The [setup skill](packages/qaren-plugin/skills/setup/SKILL.md) owns
the details. If the installed plugin has no QaReN tarball yet, use the
[source installation](#install-from-source) below.

### Install from source

To run an unreleased build, install from a checkout's root (needs Rust/Cargo as well):

```sh
bash scripts/install-qaren-from-source.sh
```

The build is versioned `<plugin version>-dev.<commit>`, so it installs beside a released
`qaren` instead of replacing it, builds its runners from source and never relinks a
release's `qaren` with the default installer options. Use the binary path the installer
prints and keep the default QaReN home; see [release and source builds side by side](packages/qaren-cli/README.md#release-and-source-builds-side-by-side).

Load that checkout's plugin with
`claude --plugin-dir /absolute/path/to/checkout/packages/qaren-plugin`. The
[installation contract](packages/qaren-cli/README.md#plugin-runtime-installation) covers
PATH linking and existing-command protection.

## Ask your agent

Once setup has passed, ask your agent in plain words:

- "QA this feature": it picks a saved plan or writes one from the feature's screens in
  source, then runs it on your working tree.
- "QA PR #12": it runs the plan at the pull request's head, and posts the result to the
  pull request only when you ask, after you confirm the plan and recording may be posted.
- "Follow the run": it follows the latest run live.
- "Report a QaReN bug": it drafts a sanitized GitHub issue about QaReN, shows it in full,
  and files it only after you confirm.

What comes back: a verdict (PASS, FAIL, or a refusal that says what to fix); a report with
one line per step and screenshots when available; on a pull request, a comment with the
verdict, the tested commit, the plan lines and the video when it can be published.

The `using-qaren` skill writes plans for a feature and runs them.

## Keep it working

Ask your agent to run QaReN's doctor and to update QaReN; the commands are in the reference below.

To update a released install, update the plugin in your host. Claude Code's next session
prints the command that installs the matching `qaren`; running setup again installs it
too.

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
`runtime/runners/<plugin-version>/ios/` in the [QaReN home](packages/qaren-cli/README.md#release-and-source-builds-side-by-side) before checking the one-rebuild-per-version
budget. With that marker present, later starts select the local runner without reusing or
downloading that version's prebuilt, including after a process restart; cached products
remain intact and other versions are unaffected. A spent rebuild budget still refuses
the current start. Authority mismatches and stale local runners do not mark the prebuilt.
If the marker cannot be written, the rebuild budget still applies, but persistent
rejection is not guaranteed.

## The `qaren` CLI (reference)

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

Run `qaren doctor` to diagnose the host, the install and rn-dev-agent 1.x leftovers; see
[Doctor](packages/qaren-cli/README.md#doctor). A source
install updates with `qaren update` from the checkout root, which fast-forwards,
rebuilds and reinstalls, and refuses a checkout with local changes.

The [CLI guide](packages/qaren-cli/README.md) covers
[plans and receipts](packages/qaren-cli/README.md#check-a-plan),
[saved blocks](packages/qaren-cli/README.md#saved-blocks),
[pull requests](packages/qaren-cli/README.md#test-a-pull-request) and
[watching a run](packages/qaren-cli/README.md#watch-a-run).

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

For screenshot and video privacy modes, defaults and limits, see [Video publication](packages/qaren-cli/README.md#video-publication).
