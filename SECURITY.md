# QaReN security

**QaReN** is a local React Native / Expo QA CLI with a host plugin, a TypeScript screen child and native runners. See the [README](README.md) for installation and usage.

Run it only against development apps you control, without real user data. It builds and executes app code on the operator's machine and inspects the app runtime; treat it like a developer with shell access. Follow the [capture and privacy contract](packages/qaren-cli/README.md#check-a-plan) and review evidence before publishing it.

## Report scope

**In scope:** vulnerabilities in the CLI, host plugin, `qaren-core`, packaged native runners, and local Observe UI as shipped from this repo.

**Out of scope:** a cloud backend (this repo has none) and operator-driven use of these local tools against an app the operator chose. For the legacy MCP plugin's operator limits, see [1.x security guidance](https://github.com/Lykhoyda/rn-dev-agent/blob/rn-dev-agent-1.0/README.md#security).

## Support

Security updates ship only on the latest QaReN version advertised on `main`. Published-but-not-advertised GitHub tags and earlier versions are unsupported.

## Reporting

Submit with GitHub [private vulnerability reporting](https://github.com/Lykhoyda/QaReN/security/advisories/new) only. Do not open a public issue.
