---
qaren: patch
---

Serialize Android runner APK refresh, hash comparison and installation with stale-retry invalidation within each worktree. Concurrent starts on different devices wait for the same outputs, with a bounded `ANDROID_RUNNER_APK_LOCK_TIMEOUT` refusal, while the rebuild budget and cleanup transitions remain unchanged.
