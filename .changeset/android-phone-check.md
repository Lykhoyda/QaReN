---
"qaren": minor
---

`qaren check` and `qaren pr` run on a physical USB Android phone borrowed on the host's adb server, refuse an unusable or locked phone with the cause and the fix (one cause, the adb server on port 5037, when that server has the phone), never use a wireless adb connection, and start the adb server once, saying so in the receipt, when none answers.
