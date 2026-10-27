---
'qaren': patch
---

Runtime inputs now follow SECRET, TEST-PII and PUBLIC tiers: TEST-PII Fill readback, failure screen text and core.log are redacted by declared values while subprocess logs and media stay withheld, secure fields promote inputs to SECRET, and SECRET refusals report only value-free mismatch facts.
