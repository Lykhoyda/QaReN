---
"qaren": patch
---

Runs and `qaren doctor` now point out a likely saved login block with the exact `loginBlock`/`loginMarker` lines to confirm, and warn when the configured marker differs from its first screen, it fills no inputs, it signs out first, or saved blocks stay only in a throwaway worktree or PR run.
