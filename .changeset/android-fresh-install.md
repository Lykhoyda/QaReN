---
"qaren": patch
---

Let `--fresh-install` run on Android in `qaren check` and `qaren pr`: the CLI first proves no other UI driver (UIAutomator, Maestro or another instrumentation) is running on the borrowed emulator, refusing when the process scan is busy or unreadable, then uninstalls the app with its data and proves it absent before the walk continues.
