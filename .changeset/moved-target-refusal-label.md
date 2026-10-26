---
'qaren': patch
---

A tap or fill the device runner refuses because its target moved, and attests it changed nothing, now fails as `TARGET_MOVED_BEFORE_DISPATCH` instead of `ACTION_OUTCOME_UNCERTAIN`, still without retry or fallback.
