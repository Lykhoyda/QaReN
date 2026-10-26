---
"qaren": patch
---

The iOS runner names toolbars `Toolbar` instead of a text input and keeps nested same-origin containers apart in snapshots, and core now requires its `SNAPSHOT_FIDELITY_V1` capability so an older runner is rebuilt instead of reused.
