---
"qaren": patch
---

`qaren doctor` names attached physical Android devices that cannot be used (`no permissions`, `unauthorized`, `offline`, or held by the adb server on port 5037) with the cause and the fix, read from the running adb server without running adb, and `qaren doctor --device <android-serial>` fails unless that device is ready.
