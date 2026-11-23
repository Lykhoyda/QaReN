---
"qaren": patch
---

Failures that used to quote the last 25 lines of a Metro, build, tunnel or adb log now record where that log is instead: `failure.log.file`, with `failure.log.bytes` when the file's size could be read. The log's lines no longer reach the receipt, `run.json` or `qaren status`, and a run record saved by an earlier version no longer shows a stored log tail. The failure's detail, next step, limit facts and recovery are unchanged.
