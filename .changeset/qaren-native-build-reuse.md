---
"qaren": minor
---

qaren reuses a verified native build from a machine-wide store under `~/.qaren/native-cache`, keyed by the native fingerprint plus the Xcode version, so a fresh clone or `qaren pr` worktree with unchanged native inputs installs it instead of rebuilding.
