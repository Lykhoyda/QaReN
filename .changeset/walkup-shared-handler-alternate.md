---
"qaren": patch
---

React-tree walk-up presses treat nested components that forward one testID and one press handler as one control even when their ancestry passes through React fiber alternates, instead of refusing them as ambiguous.
