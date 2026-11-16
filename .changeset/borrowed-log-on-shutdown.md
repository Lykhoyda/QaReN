---
"qaren": patch
---

With `--shutdown-device-on-exit`, a `check` or `pr` on an iOS simulator QaReN did not create now also removes that simulator's system log store, which holds typed field text and the log entries of every app on it, after the proven shutdown, retrying at the next `qaren cleanup` if the removal fails, while borrowed simulators without the flag keep their log as before.
