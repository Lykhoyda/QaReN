---
'qaren': patch
---

iOS teardown now asks the XCUITest runner to shut down before falling back to signals, and checks record matching SpringBoard crash reports as lane-health notes without changing the run result.
