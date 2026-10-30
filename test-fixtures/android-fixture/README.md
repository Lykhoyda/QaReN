# Android contract fixture

Tiny `android.widget` app (no androidx) the nightly device smoke
(`npm run smoke:android`) drives through the real bridge — a *contract*
fixture, not a demo app (Story 06 Phase B, #387).

| Element | android:id | Golden-set role |
|---|---|---|
| Increment button | `fixture_button` | tap → observable state change (`textAllCaps=false` keeps the visible text "Increment" for exact `device_find`) |
| Count label | `fixture_count` | assert increment after `device_press` |
| Text field | `fixture_input` | `device_fill` + read-back verify |
| 100-row list | `fixture_list` | `device_scroll` / `device_scrollintoview` — rows are matched by visible text `row <n>`; the `contentDescription = "fixture_row_<n>"` is informational (rows already carry `android:id/text1` from `simple_list_item_1`) |
| Bottom bar field + button | `fixture_bottom_input`, `fixture_bottom_button` | keyboard-occlusion scenario (#370) |

`android:windowSoftInputMode="adjustNothing"` is load-bearing: the layout does
NOT resize when the keyboard opens, so the bottom bar stays genuinely occluded.

## Build / install

Reuses qaren-android-runner's Gradle wrapper (no second wrapper jar in the repo):

```bash
packages/qaren-android-runner/gradlew -p test-fixtures/android-fixture :app:assembleDebug
adb shell settings put secure show_ime_with_hard_keyboard 1
adb install -r test-fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk
```

The `show_ime_with_hard_keyboard` setting forces the soft IME even though
emulators expose a hardware keyboard — without it the keyboard-guard step
reports `no_keyboard`.
