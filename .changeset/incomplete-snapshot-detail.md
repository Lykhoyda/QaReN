---
"qaren": patch
---

When `qaren check` refuses with `NATIVE_SNAPSHOT_INCOMPLETE`, the detail now names the read it took (ordinary or presence) and ends with how many native reads the capture made and its elapsed time. The run ledger files the refusal under its own `native-snapshot` key, and the next step asks you to report the run id with the snapshot detail instead of suggesting a re-run.
