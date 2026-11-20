---
"qaren": minor
---

A default iOS `qaren check` or `qaren pr` run now says when it finds a non-development build of the app installed. After simulator admission and before any fresh-install reset, build or install, the run looks the app up once; when the installed bundle contains a regular `main.jsbundle` file, the receipt records the outcome `non_development_app_installed` and stderr prints the same notice, naming `qaren check --installed-app` as the way to test the installed build as it is. The run still replaces the installed app with QaReN's development build, and the notice stands whether or not the build, install or walk succeeds. A missing file, a directory of that name, or a failed or timed-out lookup produces no notice. `qaren check --installed-app` and `qaren prepare` do not run the lookup.
