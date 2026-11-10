---
"qaren": patch
---

When interruption recovery's own read is refused as NATIVE_SNAPSHOT_INCOMPLETE, the refusal now also names the step's first reason as `step-reason=<word>` and, for an unpaired placeholder field, `placeholder-pairing=<unknown|incomplete>`.
