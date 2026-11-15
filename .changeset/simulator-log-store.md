---
"qaren": patch
---

Remove a pooled iOS simulator's system log store, which records typed field text including private Fill values, before it is reused and after its cleanup shutdown; report a `simulator_log` cleanup leg for every run on a pooled or borrowed simulator; and add the `ios-simulator-log` doctor policy row and, with `--device`, an `ios-lane-log` row with the command that clears a borrowed simulator's log.
