# qaren-ios-runner — Import Notes

This directory contains a Swift XCTest-based iOS automation runner imported
once (2026-05-15) from an MIT-licensed source. After import we renamed all
identifiers and dropped 3 modules we don't use. We treat this code as ours
going forward — no upstream-sync relationship is maintained.

## Imported

9 Swift source files providing:
- HTTP `POST /command` dispatcher
- Snapshot (XCUI accessibility tree → JSON)
- Interaction (tap, swipe, type, keyboardDismiss — the iOS wire verb (#418), back, scroll)
- Lifecycle (activate, terminate, state queries)
- System modal handling (alerts/permission dialogs)
- Transport (embedded FlyingFox HTTP server)

## Renamed at import time

All upstream identifiers (the project name, app/test targets, scheme, Swift
class names, bundle id, and splash text) were rewritten to the `QarenIosRunner*`
namespace as a single import-time sweep. Final names:

| Concern | Value |
|---------|-------|
| Xcode project | `QarenIosRunner.xcodeproj` |
| App target | `QarenIosRunner` |
| UI test target | `QarenIosRunnerUITests` |
| Swift test class | `QarenIosRunnerTests` (with command/snapshot/etc. extensions) |
| Bundle id | `dev.lykhoyda.rndevagent.fastrunner` |
| Splash text | `QaReN` / `iOS runner` |

The simulator shows `QaReN` (host) and `QaReN-Runner` (test runner).
The splash title carries the stable `runner-splash-title` accessibility
identifier that launch-contract tests key on.

## Dropped at import time

- `RunnerTests+ScreenRecorder.swift` — our `device_record` uses `xcrun simctl io recordVideo` directly
- `RunnerTests+TvRemote.swift` — no Apple TV support in this plugin
- `RecordingScripts/` — supports ScreenRecorder, coupled
- Plus the dependency files under `XCTest/` that supported the dropped modules: `XCTest/EventRecord.swift`, `XCTest/PointerEventPath.swift`, `XCTest/RunnerDaemonProxy.swift`

The remaining call sites for the dropped modules were repaired post-import
(see commit history): `recordStart`/`recordStop` cases were removed from the
wire protocol, and the tvOS helpers (`pressTvRemote`, `tvRemoteButton`,
`selectFocusedTvElement`, `longSelectFocusedTvElement`,
`resolveTvRemoteDoublePressDelay`, the `TvRemoteButton` enum, and the
`RunnerInteractionOutcome` enum) live as stubs at the top of
`QarenIosRunnerTests+Interaction.swift`, always returning the "unsupported"
answer so iOS code paths remain functional without touching the imported
logic.

## License

See `LICENSE` for the MIT attribution required for the imported code.

## Third-party: ThirdParty/FBQuiescence (added 2026-07-02, GH #384)

`QarenIosRunnerUITests/ThirdParty/FBQuiescence/` vendors an adapted quiescence
bypass:

- `RNQuiescence.{h,m}` — adapted from mobile-dev-inc/maestro (Apache-2.0),
  `maestro-ios-xctest-runner/maestro-driver-iosUITests/Categories/XCUIApplicationProcess+FBQuiescence.m`,
  which itself derives from facebookarchive/WebDriverAgent (BSD-3-Clause,
  Copyright (c) 2015-present, Facebook, Inc.).
- `XCUIApplicationProcess.h` — trimmed from the class-dump private header
  vendored by the same projects.

Adaptation differences: process-wide `RN_QUIESCENCE_BYPASS` env toggle
(default ON) replaces `FBConfiguration.waitForIdleTimeout` + the per-app
`fb_shouldWaitForQuiescence` associated object; the non-bypass path calls the
original implementation unmodified (no `_XCTSetApplicationStateTimeout`
bounding); `FBLogger` dropped in favor of Swift-side startup markers.
No upstream-sync relationship is maintained.

## Imported 2026-09: synthesized text entry

`QarenIosRunnerUITests/ThirdParty/SynthesizedTextEntry/` holds four MIT-licensed
files imported once:

- `RunnerXCTestEventBridge.h`
- `RunnerXCTestEventBridge.m`
- `RunnerSynthesizedTextEntry.h`
- `RunnerSynthesizedTextEntry.m`

See `LICENSE` for the required attribution. Event records use project-specific
names; see the [focused fill contract](../qaren-cli/README.md#fill-verification-and-keyboard-fallback)
for replacement behavior.
No upstream-sync relationship is maintained.
