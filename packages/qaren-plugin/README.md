# QaReN plugin

QaReN teaches Claude Code, Codex and Cursor to check React Native changes with the
`qaren` CLI. Ask your agent to QA a feature or a pull request; it writes or selects a
Markdown plan and runs it in your app. QaReN checks the plan you run, rather than
automatically testing every change. A run returns PASS, FAIL or a typed refusal;
a pull request run includes video when it can be captured and safely published.

Start with the [installation guide](../../README.md#install-the-plugin-yourself),
then use the [setup skill](skills/setup/SKILL.md) and
[using-qaren skill](skills/using-qaren/SKILL.md). Guided setup prepares an iOS simulator
on an Apple silicon Mac. The [CLI command reference](../qaren-cli/README.md#check-a-plan)
also supports checks on a booted Android emulator.

## Network

These are the network calls used by the plugin and CLI on the paths below. This is
not an exhaustive audit of dependency installers, build tools or your app's own
traffic; those depend on your project and toolchain.

- **Installation from GitHub.** The setup skill runs `scripts/ensure-qaren.sh --install`,
  which downloads the matching `qaren` tarball from
  `https://github.com/Lykhoyda/QaReN/releases/download/` over HTTPS using `curl`.
  Before installation, it verifies the archive's SHA-256 and byte length against
  the plugin's [runner manifest](runner-manifest.json). On iOS, `qaren check` and
  `qaren pr` can also download the matching `qaren-ios-runner-<version>-sim.zip`
  from the same releases URL when no valid runner is cached, verifying its
  SHA-256 against the manifest before use. Set `RN_RUNNER_BUILD=local` to build
  the shipped runner source instead. The SessionStart hook only
  runs `--print-bin` to verify the installed binary and print its path or an install
  instruction; it never downloads. See the
  [installation contract](../qaren-cli/README.md#plugin-runtime-installation).
- **npm packages.** If Corepack has not downloaded the required pnpm version,
  prerequisite setup needs one network-enabled pnpm bootstrap. Installing your
  app's dependencies with pnpm can also contact the npm registry
  (`https://registry.npmjs.org`) or the package registries configured by your app.
  Dependency and native build downloads depend on your app and toolchain. See
  [Doctor](../qaren-cli/README.md#doctor) for the bootstrap prerequisite.
- **Pull requests and publication on GitHub.** `qaren pr` reads the pull request
  through GitHub and fetches its head from the repository's `origin`, verifying
  that the fetched commit matches the head GitHub reports. GitHub commands use
  `GH_TOKEN`, `GITHUB_TOKEN` or your `gh auth login` credentials. `qaren publish`
  uploads the publishable video and posts the verdict and evidence in a pull
  request comment. When enabled, it can update the pull request description,
  remove the `needs-qa` label and push a saved block to the pull request branch.
  Review the plan, recording and publication policy before publishing. See
  [Test a pull request](../qaren-cli/README.md#test-a-pull-request).
- **Feedback on GitHub.** The [feedback skill](skills/feedback/SKILL.md) drafts a
  sanitized issue locally, shows the complete draft, and files it in
  `Lykhoyda/QaReN` only after you explicitly confirm that draft.
- **Optional Jev help at api.typesafe.ai.** Jev calls go to
  `https://api.typesafe.ai/v1/systemone` only with your own `TYPESAFE_API_KEY`, sent
  as a bearer credential. The JSON request contains the pinned model, screen-state
  evidence and the questions needed to interpret the plan. Plans with only quoted
  targets and literal checks need no key; phrase targets and checks require one
  and run a readiness probe. With a key present, interruption recovery may ask Jev
  for a safety veto even on a literal-only plan. Model-facing evidence uses
  known-value masking: an unknown pre-filled secret echoed as ordinary text can
  still reach the judge. Use test data and read the
  [plan and screen-evidence contract](../qaren-cli/README.md#plan-checks-and-screen-evidence)
  and [input-value masking limits](../qaren-cli/README.md#input-value-masking).

Metro-only Expo starts default to `EXPO_OFFLINE=1` to avoid Expo account lookups;
`EXPO_OFFLINE=0` opts into online account features. Fresh Android preparation via
`expo run:android` retains its inherited Expo environment. See
[iOS simulator lifecycle](../qaren-cli/README.md#ios-simulator-lifecycle).

QaReN's `logs/events.jsonl` stream stays local. Its events are never uploaded or
included by `qaren publish`; see the [CLI guide](../qaren-cli/README.md).
