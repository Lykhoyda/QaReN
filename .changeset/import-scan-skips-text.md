---
"qaren": patch
---

Native build reuse ignores confidently identified non-code text in config plugins, including Objective-C `#import` lines in template strings, while preserving conservative scanning for ambiguous syntax and computed keys.
