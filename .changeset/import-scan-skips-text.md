---
"qaren": patch
---

Native build reuse no longer refuses a config plugin just because the words `require`, `import` or `process` appear inside a comment, a quoted string or template text (for example Objective-C `#import` lines in a template string), while a file the scanner cannot read for certain, such as one with a regular expression, a division sign, JSX or a `<`, is scanned as before.
