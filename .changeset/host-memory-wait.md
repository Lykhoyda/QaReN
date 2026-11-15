---
"qaren": patch
---

Use a bounded host memory wait before a native build, rechecked at most every 5 s while the build is queued and shown in `qaren watch`, and refuse `HOST_UNDER_PRESSURE` with load, available memory, pressure and swap only when the final complete reading is critical.
