---
"qaren": patch
---

Give the native build its own clock, so waiting for the build lock no longer uses up build time, a build that keeps producing output goes on past its limit (up to three times it, at most 7200 s), a cut names the limit, the time, the last output and the next limit, and the next run's limit learns from this machine's earlier builds.
