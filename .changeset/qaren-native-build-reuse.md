---
"qaren": minor
---

qaren reuses a verified iOS native build from a per-user machine store, keyed by the native fingerprint plus the Xcode version, so a fresh clone or `qaren pr` worktree with unchanged native inputs installs it instead of rebuilding.
