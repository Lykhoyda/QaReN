---
"qaren": patch
---

`--shutdown-device-on-exit` now also removes the system log store of a simulator QaReN did not create, after the proven shutdown, so text typed during the run does not stay in that simulator's log. The store holds the log entries of every app on the simulator. A removal that fails keeps the stop pending for the next `qaren cleanup`; runs without the flag, and pending stops recorded by an older QaReN, keep the log as before. `qaren doctor`, the receipt note and the usage text say so.
