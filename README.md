# QaReN

This checkout develops **QaReN**, a CLI that checks Markdown QA plans, replays
saved blocks and persists passing walks. For current build and usage instructions,
read the [QaReN CLI guide](packages/qaren-cli/README.md).

## Set up QaReN

Until a QaReN release asset is published, install from this checkout's root:

```sh
bash scripts/install-qaren-from-source.sh
```

The source installer requires an Apple silicon Mac, Node 24 or newer, Corepack
and Rust/Cargo. It builds and verifies the runtime; see the
[installation contract](packages/qaren-cli/README.md#plugin-runtime-installation)
for PATH linking, the fallback export and existing-command protection.

From your app's root, load the checkout's plugin in Claude Code:

```sh
claude --plugin-dir /absolute/path/to/rn-dev-agent/packages/qaren-plugin
```

Then run `/qaren:setup`. The [setup skill](packages/qaren-plugin/skills/setup/SKILL.md)
owns app requirements and onboarding: it writes `.qaren/config.yaml` and a smoke
plan, selects a simulator and runs the first check. The
[using-qaren skill](packages/qaren-plugin/skills/using-qaren/SKILL.md) writes
subsequent feature plans. For manual runs, see [Check a plan](packages/qaren-cli/README.md#check-a-plan).

## Watch a QaReN run

Watch test stages in a second terminal:

```sh
qaren watch --latest
```

See the [watch guide](packages/qaren-cli/README.md#watch-a-run) for selecting a
run, SSH usage, output modes, privacy, stage semantics and exit codes.

## Plugin

See the [plugin guide](apps/docs-site/src/content/docs/plugin.mdx) for the
shipped skills, host loading rules and feedback workflow.

## Security

Use QaReN only against local development apps where you trust the agent's prompts.
Do not use production builds, store-signed apps or apps holding real user data.
The screen child reads the app's runtime through CDP; treat the agent like a
developer with shell access, able to read or mutate runtime state.

Runs retain evidence locally. Review the [capture and privacy contract](packages/qaren-cli/README.md#check-a-plan)
before using private inputs and the [publication contract](packages/qaren-cli/README.md#video-publication)
before posting a run. Report vulnerabilities through [private vulnerability reporting](SECURITY.md#reporting).

## Development

See the [CLI build instructions](packages/qaren-cli/README.md#build) and
[repository guide](AGENTS.md) for package ownership and contribution checks.

MIT licensed; see [LICENSE](LICENSE).
