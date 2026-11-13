---
"qaren": patch
---

`qaren doctor` names attached physical Android devices that cannot be used (`no permissions`, `unauthorized`, `offline`, or held by the adb server on port 5037) with the cause and the fix, read from the running adb server without running adb, counts a wireless adb connection separately and never uses it, and `qaren doctor --device <android-serial>` fails unless that device is a ready USB phone; `qaren prepare` now refuses an `android_usb.serial` that names a wireless adb connection, which it accepted until now.
