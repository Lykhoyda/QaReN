---
"qaren": patch
---

On Android, a quoted Fill whose field is not yet a usable text field on the first read now looks once more after half a second before failing, so a field that finishes appearing a moment later is filled instead of failing with `TARGET_NOT_FOUND`. When a Fill's target is on screen but is not a text field, the failure now says to quote the text field's own testID or move the testID onto the field.
