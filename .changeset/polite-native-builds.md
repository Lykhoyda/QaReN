---
"qaren": patch
---

Run native builds at lower CPU priority with a worker cap sized from the machine, also on the default `expo run:ios` path, and compile iOS simulator builds for arm64 only on Apple silicon, overridable through `build.jobs`, `build.priority` and `build.arch` in `.qaren/config.yaml` and recorded per build in the receipt.
