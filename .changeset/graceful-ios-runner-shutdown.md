---
'qaren': patch
---

iOS teardown now asks the XCUITest runner to shut down before signalling it, and a check notes a SpringBoard crash on the simulator within 60 seconds of the walk without changing its result.
