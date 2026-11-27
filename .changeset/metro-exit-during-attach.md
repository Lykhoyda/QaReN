---
"qaren": patch
---

When the core's connection to QaReN's own Metro port is refused before admission and QaReN then finds its Metro launcher exited and the port refusing, the run refuses `BUNDLE_LOAD_FAILED` with a pointer to the kept Metro log and, unless cleanup needs attention first, cause `metro_exited` and the next step `inspect_metro_exit`, instead of `CORE_REFUSED` with `CDP_NOT_CONNECTED` in its detail. QaReN restarts nothing in response and does not watch Metro while the core runs: an exit in a stage that makes no Metro request can first be named on a later refused read. Metro's exit status is not reported.
