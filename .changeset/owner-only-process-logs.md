---
"qaren": patch
---

New subprocess capture files in a run's `logs/` folder are created owner-only (mode `0600`) on Unix. Receipts for a run with a `logs/` folder carry `outcomes.raw_logs`, and `qaren doctor` gains a `raw-logs` row, both saying those logs may contain private app or tool output and that the run folder should stay on this machine.
