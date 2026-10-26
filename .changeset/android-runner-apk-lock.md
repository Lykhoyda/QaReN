---
qaren: patch
---

Serialize Android runner APK refresh, hash comparison and installation with stale-retry invalidation within each worktree. Concurrent starts on different devices wait for the same outputs, with a bounded `ANDROID_RUNNER_APK_LOCK_TIMEOUT` refusal, while the rebuild budget and cleanup transitions remain unchanged.

Record Android APK fence ownership by process birth and group. Cancellation stops owned build/install children before release; follow-up starts reclaim only proven-dead owners with no surviving group. Live-owner waits disclose owner and fence, and unprovable liveness refuses immediately with recovery steps.
