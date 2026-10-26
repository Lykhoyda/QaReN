---
"qaren": patch
---

Record each Fill's ladder rung (`keyboard`, `clear-type` or `set-handler`) and, when typing cannot be verified on iOS, set the value once through the input's change handler, counting that pass as proof only for steps labelled `(any method)`.
