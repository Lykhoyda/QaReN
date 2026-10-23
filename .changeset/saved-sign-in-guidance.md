---
"qaren": patch
---

Runs and `qaren doctor` now point out a likely saved login block with the exact `loginBlock`/`loginMarker` lines to confirm, and warn when the configured marker or inputs cannot replay it, when it signs out first, or when saved blocks stay in a throwaway worktree.
