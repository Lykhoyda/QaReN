---
"qaren": patch
---

Give the native build its own clock, so waiting for the build lock no longer uses up build time and a build that keeps producing output goes on past `deadlines.build_seconds` (up to three times it, at most 7200 s) while a cut names the limit, the time, the last output and the next limit.
