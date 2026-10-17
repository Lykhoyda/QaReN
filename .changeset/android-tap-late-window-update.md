---
"qaren": patch
---

Verify an Android tap whose screen draws after the first window check: when the hierarchy still looks unchanged, wait once more for a window update inside the remaining settle budget before reporting that the tap had no effect.
