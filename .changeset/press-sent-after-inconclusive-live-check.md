---
"qaren": patch
---

An ordinary iOS tap whose live hit check gives no answer is still sent as before, and is now recorded. The tap reply names why the check was unavailable, the ledger row counts such presses per reason in `inconclusivePresses` and counts authorised taps whose outcome stayed unknown in `pressOutcomeUnknown`, and the receipt summary, `report.md` and the published comment list them without changing the verdict.
