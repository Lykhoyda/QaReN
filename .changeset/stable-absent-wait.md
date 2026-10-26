---
'qaren': patch
---

A literal wait whose target stays absent on an unchanged screen until its deadline now fails with "did not appear" instead of `VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED`.
