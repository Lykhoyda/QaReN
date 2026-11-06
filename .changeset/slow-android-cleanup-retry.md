---
"qaren": patch
---

Android cleanup now retries a slow device's adb reads with a larger budget while the device still answers, so a busy emulator no longer leaves the run's lease retained; a refusal names every attempt and whether the device was slow or unresponsive.
