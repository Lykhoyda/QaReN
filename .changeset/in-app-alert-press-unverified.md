---
"qaren": patch
---

A press on an in-app alert or action sheet button that only closes it, with nothing behind it or outside the keyboard changing or nothing behind it captured while it was open, now passes as `UNVERIFIED_PRESS` and is listed in the receipt's `ledger.unverified_presses` instead of reading as a verified pass.
