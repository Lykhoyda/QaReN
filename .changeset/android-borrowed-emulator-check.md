---
"qaren": minor
---

Let `qaren check` and `qaren pr` run on Android by borrowing one booted emulator on the host's running adb server, building the debug APK with Gradle (prebuilding an absent `android/`) and installing it by serial.
