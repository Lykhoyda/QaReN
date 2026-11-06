---
"qaren": patch
---

Borrowed Android emulator cleanup now retries timed-out reverse removal and absence reads with bounded larger budgets while the device answers, retaining the lease if cleanup remains unproven and reporting timeout attempts and device responsiveness.
