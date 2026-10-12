# Lykhoyda/rn-dev-agent security

**QaReN** is a CLI and host plugin for local React Native / Expo QA. It is not a hosted SaaS and not a generic Node library.

Follow [Set up QaReN](README.md#set-up-qaren). It runs on the operator's machine: the CLI owns the run and managed Metro, while the screen child and native runners drive the selected device.

## Report scope

**In scope:** vulnerabilities in the CLI, host plugin, `qaren-core`, the packaged native runners, and the local Observe UI as shipped from this repo.

**Out of scope:** a cloud backend (this repo has none) and operator-driven use of these local tools against an app the operator chose. Operator limits for runtime introspection are in [README Security](README.md#security).

## Support

Security updates ship only on the latest 1.0.x plugin/core version advertised on `main`. Published-but-not-advertised GitHub tags, earlier 1.0.x, and all 0.x are unsupported.

## Reporting

Submit with GitHub [private vulnerability reporting](https://github.com/Lykhoyda/rn-dev-agent/security/advisories/new) only. Do not open a public issue.
