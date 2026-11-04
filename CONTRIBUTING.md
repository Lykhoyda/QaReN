# Contributing to QaReN

Thanks for helping. This page covers how to report a problem, set up a checkout,
check a change and open a pull request. The [README](README.md) explains what QaReN
does; the [repository guide](AGENTS.md) has the full package map and validation list.

## Report a bug or ask for a feature

Open an issue with the [bug report](https://github.com/Lykhoyda/QaReN/issues/new?template=bug_report.yml)
or [feature request](https://github.com/Lykhoyda/QaReN/issues/new?template=feature_request.yml)
form. Inside your agent, `/qaren:feedback` drafts the same report for you and files it
only after you confirm it.

A good bug report has:

- what you ran and what you expected;
- what happened instead, including the `result`, `run_id`, `failure.code` and
  `failure.next_action` fields from the receipt `qaren check` or `qaren pr` printed;
- the output of `qaren --version`, `sw_vers -productVersion`, `xcodebuild -version`
  and `node --version`, writing "missing" for any command that fails.

Do not attach screenshots, videos, plan text with typed values, or values from
`.qaren/config.yaml` unless you have checked they hold no private data.

Report security problems privately, as described in [SECURITY.md](SECURITY.md), never in
a public issue.

For a larger change, open an issue first so the approach can be agreed before you write
the code.

## Set up a checkout

You need:

- Node 24 or newer, with Corepack. The repository pins its Yarn version in
  `package.json`; run Yarn through `corepack yarn` rather than a global install.
- Rust and Cargo, for the `qaren` CLI.
- An Apple silicon Mac with Xcode, only for work that runs on an iOS simulator.

From the repository root:

```sh
corepack yarn install --immutable
corepack yarn build:core
cargo build --manifest-path packages/qaren-cli/Cargo.toml --locked
```

The development binary is `packages/qaren-cli/target/debug/qaren`. To install a build of
your checkout beside a released `qaren`, follow
[Install from source](README.md#install-from-source).

Follow the [editing rules](AGENTS.md#editing-rules) for source languages and files that
must stay out of commits; use the [repository map](AGENTS.md#repository-map) to find the
package to edit.

## Check your change

Run the checks that match what you touched, from the repository root:

```sh
corepack yarn format:check
corepack yarn lint
bash scripts/check-typescript-only.sh
corepack yarn build && corepack yarn test
cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked
```

The commands above need no simulator. For a docs site change, run
`corepack yarn build:docs` (needs [Bun](https://bun.sh)). For an Android runner
change, run `corepack yarn test:native:android` (needs a JDK and the Android SDK); the iOS
runner's tests need a simulator, as the [repository guide](AGENTS.md#validation-commands)
describes.

If your change affects what happens on a device, say in the
pull request whether you tried it on a simulator, and how.

## Add a changeset

A pull request that changes `packages/qaren-core/src/`, `packages/qaren-cli/src/`, or the
plugin's `commands/`, `skills/`, `hooks/` or `scripts/` needs a changeset in the same pull
request. Add one with `corepack yarn changeset`, or write `.changeset/<short-name>.md`:

```md
---
"qaren": patch
---

One plain sentence a user would understand, saying what changed for them.
```

The package name is always `qaren`. Use `patch` for fixes and `minor` for new behaviour.
Docs, tests and CI changes need no changeset.

## Open a pull request

1. Fork the repository and branch from `develop`.
2. Keep the pull request to one change. Split unrelated fixes.
3. Open it against `develop`, not `main`. `main` is the release branch.
4. Title it in the form `type(scope): summary`, for example
   `fix(qaren-cli): keep the lease when cleanup fails`. Common types are `fix`, `feat`,
   `docs` and `chore`; the scope is the package or area, such as `qaren-core`,
   `qaren-cli`, `qaren-plugin` or `docs-site`, and can be left out.
5. Fill in the template in plain language: what changed and why, the evidence that it
   works, and anything a reviewer should watch for. Write for someone who has not seen
   the issue.

CI runs the checks defined in [ci.yml](.github/workflows/ci.yml); keep them green before
requesting a merge.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
