---
"qaren": patch
---

Default iOS `qaren prepare` now reuses a free QaReN-created simulator from a per-home pool capped by `ios.max_devices`, and `--new` keeps the previous fresh temporary simulator.
