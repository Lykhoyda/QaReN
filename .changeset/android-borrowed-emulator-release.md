---
"qaren": patch
---

Leave a borrowed Android emulator as it was found: teardown and `qaren cleanup` remove the run's Metro reverse and its runner while the run holds the device lease, `adb reverse` never rebinds an existing mapping and a run cancelled before its reverse leaves the port alone, `--remove-app` refuses on a borrowed emulator, and `qaren status` probes it through the borrowed adb server.
