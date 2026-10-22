---
"qaren": patch
---

A slow or failing Expo dev-client floating-button preferences call is retried, and on iOS a call that keeps failing is then proven hidden from the screen, so `qaren check` refuses `DEV_MENU_HIDE_UNVERIFIED` there only when the button is still visible.
