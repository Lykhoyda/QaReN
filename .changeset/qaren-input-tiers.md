---
'qaren': patch
---

Runtime inputs now follow SECRET, TEST-PII and PUBLIC tiers: `(test-pii)` Fills are read back and their runs' logs and failure screen text come back redacted by the declared values, while SECRET refusals report only value-free length facts.
