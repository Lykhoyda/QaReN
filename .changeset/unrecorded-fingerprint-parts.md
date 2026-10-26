---
"qaren": patch
---

A build plan after an incomplete cached run no longer reports fingerprint parts the recorded build never captured, such as the toolchain, as changed native inputs; it names them as unrecorded instead.
