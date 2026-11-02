---
"qaren": patch
---

A plain `Scroll down` or `Scroll up` that leaves the screen unchanged after two clean scrolls now passes with the typed reason `SCROLL_NO_VISIBLE_CHANGE` instead of failing the run, so plans no longer depend on how much content an account has. Scrolls that error, may have mutated, or bring another front still fail, now with a typed cause and an inspection `next_action`; `Scroll down until "<text>"` still fails when its target never appears.
