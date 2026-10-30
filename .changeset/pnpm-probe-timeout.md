---
"qaren": patch
---

Retry a timed-out pnpm process-group probe with a doubled bound inside the dependency-install budget, and refuse a persistent timeout as `PNPM_PROBE_TIMED_OUT` instead of reporting a supported pnpm as unsupported.
