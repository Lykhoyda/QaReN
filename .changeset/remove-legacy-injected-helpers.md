---
qaren: patch
---

Remove the unused navigation-graph, navigate, store, component-state, dispatch, console, error, readiness and app-info injected helpers, stop installing console, error-handler and promise-rejection tracking, and empty and disable recording into legacy buffers while leaving previously installed wrappers and hooks in place in a running app.
