---
"qaren": patch
---

When an iOS `check` walk fails or returns a target refusal after the app was admitted, QaReN now keeps Metro, the simulator and the device lease at that screen until `qaren cleanup <run-id>` or the next run on that device; `--no-hold` keeps the previous teardown, and so do `CI`, a `## Cleanup` plan section, `--shutdown-device-on-exit` or `QAREN_HOLD_ON_FAIL=0` unless `--hold` is given.
