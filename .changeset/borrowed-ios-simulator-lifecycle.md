---
"qaren": patch
---

Add explicit `--restart-device` and `--shutdown-device-on-exit` options for borrowed iOS simulators on `qaren check` and `qaren pr`, gated by an exact `--device <UUID>`, strict foreign-driver admission, verified `Shutdown`/`Booted` readbacks, and lease-held teardown and recovery.
