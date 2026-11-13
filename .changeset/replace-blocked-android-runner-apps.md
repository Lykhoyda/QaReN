---
"qaren": patch
---

Android: when QaReN's own runner apps on the device come from another host or a newer version, `qaren check` now replaces them once by itself instead of refusing as runner-down, and if that fails it refuses `DEVICE_UNAVAILABLE` with `subreason: runner-install-blocked`, adb's reason and the next step.
