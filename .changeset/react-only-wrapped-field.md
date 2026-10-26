---
"qaren": patch
---

A fill whose field is wrapped by components that forward its testID, and that have no native input, now resolves to that one field instead of refusing as ambiguous, and ambiguity refusals say which candidates are native, React-only or proven wrappers.
