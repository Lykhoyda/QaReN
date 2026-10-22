---
"qaren": patch
---

The iOS runner no longer stops answering when XCTest records a UI automation issue during a command, such as reading a field that vanished after an auto-submitting fill, and a tap, press, drag or typing gesture that raises one now fails with `GESTURE_ISSUE_RAISED` and mutation `possible` instead of reporting success.
