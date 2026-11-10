---
"qaren": patch
---

Borrowed Android emulator cleanup now retries timed-out reverse removal and absence reads with bounded larger budgets while the device answers a 40 s liveness check, gives the runner-process dump the same budget instead of dumpsys's own 10 s and treats its timeout banner as a timeout, retaining the lease if cleanup remains unproven and reporting timeout attempts, device responsiveness and the retry allowance used.
