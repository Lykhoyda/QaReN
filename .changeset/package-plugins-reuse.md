---
"qaren": patch
---

Warm runs can reuse a cached native build again when app.json names package plugins or local plugins import packages: those are bound by the lockfile and the resolved package version.
