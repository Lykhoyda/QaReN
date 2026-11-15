---
"qaren": patch
---

When an iOS run's Metro answers only on `[::1]`, QaReN now restarts it once on all network interfaces within the same build deadline and says so in the receipt and report, instead of refusing the run.
