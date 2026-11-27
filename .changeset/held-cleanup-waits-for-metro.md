---
"qaren": patch
---

When `qaren cleanup` of a held iOS check, or the next run's reclaim, finds at its TERM or KILL step that Metro's launcher is gone while Metro is still stopping, it no longer gives up at once: it sends no further signal, waits up to a 20 s polling budget for Metro to exit by itself, and attempts the device lease release once that and the other legs that gate the lease pass. A Metro that outlasts the wait is still reported unresolved and keeps the lease. A qaren command stopped by SIGTERM, SIGINT or SIGHUP now prints one line on stderr (for `check` and `pr` after their cancellation handler, only on a second signal), a qaren that cannot install those handlers stops at once with one line, empty `qaren plans` and `qaren actions list` print one line, and plain, `--version`, receipt or `watch` output that cannot be written is reported with a next step.
