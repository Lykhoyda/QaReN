# Lykhoyda/rn-dev-agent security

**rn-dev-agent** is the Claude Code, Codex, and Cursor plugin (`rn-dev-agent-plugin` / `rn-dev-agent-core`) for local React Native / Expo development. It is not a hosted SaaS and not a generic Node library.

Install it from the Claude Code, Codex, or Cursor marketplace. It runs on the operator's machine: the MCP supervisor, managed Metro, and packaged iOS/Android runners drive a local simulator, emulator, or a bound physical device.

## Report scope

**In scope:** vulnerabilities in this plugin, `rn-dev-agent-core`, the packaged native runners, and the local Observe UI as shipped from this repo.

**Out of scope:** a cloud backend (this repo has none) and operator-driven use of these local tools against an app the operator chose. Operator limits such as `cdp_evaluate` are in [README Security](README.md#security).

## Support

Security updates ship only on the latest 1.0.x plugin/core version advertised on `main`. Published-but-not-advertised GitHub tags, earlier 1.0.x, and all 0.x are unsupported.

## Reporting

Submit with GitHub [private vulnerability reporting](https://github.com/Lykhoyda/rn-dev-agent/security/advisories/new) only. Do not open a public issue.
