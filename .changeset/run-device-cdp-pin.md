---
'qaren': patch
---

An iOS check now attaches only to its own simulator's runtime, so another booted simulator running the same app on the shared Metro port can no longer satisfy the bundle proof while the run's app is still loading.
