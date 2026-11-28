---
'qaren': patch
---

Strict admission no longer gives up after one process scan that timed out while its 30-second deadline still has room for another scan. On iOS and Android the scan runs again after a short pause with a wait of up to 4, 8 and then 16 seconds, as far as the deadline allows. This applies wherever strict admission runs: `qaren check` and `qaren pr` with `--fresh-install` or the iOS device lifecycle flags, `qaren prepare` on a borrowed simulator, and `qaren cleanup` before it stops one. When no further scan fits, the refusal in `check`, `pr` and `prepare` receipts says what ran out of time and lists the attempts, each scan's wait and the host's 1-minute load when it can be read. Its code, advice and recovery are unchanged.
