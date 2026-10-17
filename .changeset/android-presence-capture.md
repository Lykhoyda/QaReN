---
"qaren": patch
---

Android QA snapshots now carry a validated native presence capture: the runner observes each element under the display density and refuses what it cannot prove, scrolled-out elements read as off screen, and elements under the keyboard read as covered, not scrolled out. Android phrase steps still refuse until touchability is proven in a later change.
