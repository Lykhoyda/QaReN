---
"qaren": patch
---

On Android, `qaren check` now waits for the JS reload that turning Fast Refresh off triggers, and re-proves the reloaded bundle before step 1, so the first step no longer reads the dev client's loading screen. Dev-menu recovery on Android no longer turns Fast Refresh off again mid-walk.
