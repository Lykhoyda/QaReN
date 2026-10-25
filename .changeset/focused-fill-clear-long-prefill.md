---
"qaren": patch
---

Clear a prefilled iOS input during focused Fill through the app's own change handler, so a value wider than the field (including a private runtime input left over from an earlier session) is replaced instead of refused.
