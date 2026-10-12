---
"qaren": patch
---

Keep typed values out of Android device logs: the Android runner's exact fill writes through the bound field's accessibility node, its key-event fallback injects keys without logging their codes, and its device-tool snapshot reads the windows itself so off-screen text is never logged; the snapshot's output is unchanged. A cleared Android field that is empty and shows no hint now reads back as empty, so a plain clear verifies as exact.
