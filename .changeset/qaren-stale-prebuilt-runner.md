---
"qaren": patch
---

An iOS prebuilt runner that reported missing required capabilities is no longer reselected after the local rebuild, so later checks use the rebuilt runner instead of refusing `RN_FAST_RUNNER_STALE`.
