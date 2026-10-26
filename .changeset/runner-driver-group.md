---
'qaren': patch
---

The iOS runner's `xcodebuild` driver now runs in its own recorded process group, so `qaren cleanup` reclaims it by identity after its qaren owner is killed instead of refusing `OWNERSHIP_UNPROVEN`.
