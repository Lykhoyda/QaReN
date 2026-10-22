---
"qaren": patch
---

Reap and relaunch the iOS reader when a platform-presence capture hits the runner's main-thread timeout, so later reads are not refused by a runner that has wedged itself.
