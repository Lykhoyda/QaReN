---
"qaren": patch
---

A press on an in-app alert button that only closes the alert, with nothing behind it or outside the keyboard changing, now passes as `UNVERIFIED_PRESS` and is listed in the receipt's `ledger.unverified_presses` instead of reading as a verified pass.
