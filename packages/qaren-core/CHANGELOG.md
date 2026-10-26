# rn-dev-agent-core

## 1.0.12

### Patch Changes

- fd4f88a: `device_fill` gains `focused: true`, which types into the already focused iOS field through a synthesized text event and confirms the value through the React tree only when that named field is the focused responder, returning `typed: true, verified: false` when it cannot.
- e0a5803: Doctor reports learned-action compatibility as its own read-only row — missing or low enginePin, regex text selectors, and unreadable actions — so a pinned-ok runner can no longer hide replay refusals behind ENGINE_PIN_MISMATCH.
- 466b3f5: The React-tree replay refusal `frontmost proof cannot cover every mounted renderer` now carries `meta.coverage` with its reasons and renderer ids.
- 466b3f5: The React-tree replay refusal's `meta.coverage` now names the phase and message of each scan error, and the frontmost prover reads style keys directly so styles it cannot enumerate no longer abort the scan.
- bc219d9: Ship one committed bundled runtime with host-neutral `rn-dev-agent-core` metadata from `packages/claude-plugin`, which both the Claude and Codex marketplaces now install (Codex selects its generated `.codex-plugin/plugin.json`, `codex.mcp.json`, `bin/` launchers and `codex-*` adapters from the same directory), so a Codex local registration must point at `packages/claude-plugin` instead of the removed `packages/codex-plugin` runtime (GH #892).
- 466b3f5: Expand TextInput designation scans to 20,000 fibers.
- 466b3f5: Raise React-tree `typeText` and input read-back to a shared 500,000-work-unit limit (a measured diagnostic, not a performance recommendation) and make TextInput designation recognize React alternates.

## 1.0.11

### Patch Changes

- 087d5b5: Pin an iOS simulator dev client with the same initial-URL launch the managed build uses instead of an openurl confirmation.
- 087d5b5: Record recognized authority refusals as one code-and-platform group across emission shapes, persist an explicit non-membership verdict, and retain runner traces for every failed replay and for recognized authority refusals without treating successful diagnostic calls as verified recovery. Stored symptoms and submitted feedback now redact UUID-shaped device identifiers. Dispose the previous CDP client before an Android managed relaunch or re-prove so Metro's inspector proxy sees one debugger per page.

## 1.0.10

### Patch Changes

- ce181d2: Add first-class Cursor Plugin manifests and `${CURSOR_PLUGIN_ROOT}` spawn on the Claude package, keep the process lock on Claude and Cursor spawns, make the lock-conflict message host-neutral without kill, lock-delete, or `--no-lock` advice, and resolve reused Claude command/skill helper paths through a host-neutral plugin-root fallback that includes `CURSOR_PLUGIN_ROOT` (GH #1038, #872).

## 1.0.9

### Patch Changes

- c3fc818: Managed dev-client launches and relaunches now keep the Expo dev-menu onboarding tutorial and launch-time sheet from auto-opening over a native segment or after a reload on a fresh install, on by default and configurable per target class with `autoHideDevMenu` in `.rn-agent/config.json` (GH #1004).
- 814337d: Document the one-source-owner-per-worktree and one-exact-device-target-per-session authority bounds in the workflow skill, with pointers from the CLAUDE.md template and other workflow skills (GH #1026). Source ownership is the worktree/checkout, not only the app package root: a sibling app root in the same checkout is also blocked, and separate linked worktrees are independent copies. A session holds one `(platform, deviceId, appId)` target at a time and replaces it after runner, proof, any explicitly started Observe, and any active recorder are released and no incompatible install receipt is bound. Authoritative cross-target `cross_platform_verify` is currently unsupported.
- 5c10049: Fix saved-action tab presses by resolving wrappers around a single native host and proving visibility from the owning route scope with navigator controls bound to their enclosing navigator and transparent destination providers, while preserving refusals for ambiguous controls and inactive content (HELPERS_VERSION bumped to 70 so connected sessions re-inject).
- 7ab6ae4: Normalize native recordings to 30 fps H.264 at their captured resolution through the authenticated stop boundary while preserving captured timing, stage the conversion inside the private runtime directory, refuse symlinked PR-body destinations, and embed proof screenshots and demo GIFs at 400px width in the generated PR body.
- 2085479: `rn_session` status and `cdp_status` now report the running product on the envelope: `product.coreVersion` is the core package the live session process loaded, and `product.pluginVersion` is included when the host plugin manifest differs (GH #1025).

## 1.0.8

### Patch Changes

- f1d414e: Print snapshot and find element refs as `@eN`, matching the pinned form the current frame authorises for press, and accept a copied bare `eN` at the argv boundary (GH #979).
- fa2cd21: Refuse managed-dev-client replay of flows that clear app state, and make login-path refusals name the actual next step.

## 1.0.7

### Patch Changes

- b352043: Report the managed-Metro readiness failure from the pre-kill launcher state and log tail, and raise the budget to a 90 s default configurable via `.rn-agent/config.json` → `metro.readinessTimeoutMs` (GH #992).

## 1.0.6

### Patch Changes

- 8517ebc: Admit the canonical `expo-updates` runtime-version CLI and the verified developer `git` it shells out to in the Darwin managed-Metro sandbox profile, so Expo dev-client manifests under a `fingerprint` runtime-version policy stop failing with `spawn EPERM`.

## 1.0.5

### Patch Changes

- 6d6dc39: Allow the managed-Metro Darwin sandbox to write the resolved, run-owned `react-native-css-interop/.cache` directory while preserving all other sandbox restrictions and enforcement checks.
- 6d6dc39: Accept the renamed Apple platform code-signing leaf authority during managed-Metro sandbox verification while preserving the trusted Apple chain, identity, and rejection requirements.
- 5008fd6: Discover deeply nested Redux and React Query stores and dispatch Redux actions through their Provider when an app bridge has no registered store.
- 6d6dc39: Record private per-attempt managed-Metro enforcement diagnostics with preparation outcomes, fixed-schema flags, timings, exits and predefined error categories without retaining arbitrary stderr text or changing permissions, timeouts or fallback behavior.
- 6d6dc39: Deliver the attested command snapshot to the managed-Metro sandbox preflight shim before signaling admission, so a shell-shim command no longer intermittently sources an empty snapshot and degrades enforcement to reported-v1.
- 6d6dc39: Detect a wildcard-bound Metro listener in the managed-Metro sandbox preflight by probing every local address shape, so a real Expo server that listens on all interfaces no longer reads as unoccupied and falls back to reported-v1.
- cc992e6: Omit automatic hook state from component trees while preserving existing explicit component-state inspection.
- e0d25c8: Retain a bounded closed-vocabulary projection of runner failure evidence on `maestro_run` results and `cdp_run_action` RunRecords before the temporary report tree is deleted, withholding text, images, terminal output and original artifacts.
- 6d6dc39: Allow the managed-Metro Darwin sandbox to look up the FSEvents service so Metro's native file watcher works on app-scale trees under enforcement instead of exhausting descriptors, without adding any executable, file, or network permission.
- e0d25c8: Recognize the rn-dev-agent instruction block in CLAUDE.local.md during workflow preflight without modifying either Claude instruction file or hiding read errors.

## 1.0.4

### Patch Changes

- abd7562: Report managed-Metro cleanup obligations with missing stop-proof evidence as unrecoverable in-band while preserving the obligation and authority fence.
- 4047a2e: Resolve the Observe Device pane's live frame through the same authority-fenced device target as the mirror, so a parked runner or stale CDP no longer leaves the pane blank after `cdp_run_action`.
- fa85d1f: Expose observed replay runtime-state writes with exact sidecar paths—session-private when fenced and project-local under `.rn-agent/state` for unfenced compatibility—and document the current fresh-session action history.

## 1.0.3

### Patch Changes

- 7652515: Walk up to the nearest pressable ancestor for React-tree replay taps whose exact target is not a designatable TextInput, keeping input designation first and reporting type-path eligibility refusals as `INTERACTION_NOT_ACTUATED` with the helper's reason, with pointer-event eligibility read on host views only and inherited root-to-leaf.

## 1.0.2

### Patch Changes

- f76cd30: Allow React-tree replay taps to designate an exact editable TextInput for only the adjacent inputText step without dispatching press or focus callbacks, and resolve a stock TextInput whose composite and host fibers share one onChangeText as a single typeText target instead of refusing it as ambiguous.

## 1.0.1

### Patch Changes

- 7911ebd: Recognize a modal-hosted testID as frontmost when its React return chain threads through the modal host fiber's alternate, instead of refusing it as behind the active modal.
- 7911ebd: Re-prove the exact CDP session target before completing a partitioned native segment's deferred origin, so a passing native prefix survives the runner park/resume handoff into the React-tree suffix instead of failing with an empty before-first-step envelope.
- 7911ebd: Resume id-based iOS action waits through the React tree with Maestro-compatible timed visibility semantics.
- d30f866: Reuse completed WebDriverAgent builds across maestro-runner spawns through a toolchain-fingerprinted persistent store with atomic publication, removing the ~75 s per-invocation WDA rebuild while keeping per-spawn cache isolation, corruption fallback, and cold-build behavior.

## 1.0.0

### Major Changes

- 52f183f: Require Node 24 or newer and authenticate both Node calling conventions for managed-Metro descendant spawns so supported runtimes bind Metro without weakening strict proof.

### Patch Changes

- 4c417dc: Report unreadable process births as unavailable while preserving genuine authority identity-mismatch refusals.

## 0.72.7

### Patch Changes

- 18b95ca: maestro_run now emits a canonical per-attempt run ledger and attaches a ledger-derived `trailingVerification` qualifier block (`trailingVerificationOnly: true`, existing failureKind unchanged) to a still-failed flow whose mutating commands all provably completed while only a trailing wait/assert timed out, and cdp_run_action consumes it to refuse selector auto-repair and swap the simulator-reboot advice for verify-first guidance (final goal state stays unproven; genuine wedges keep the existing reboot hint).

## 0.72.6

### Patch Changes

- 9f6c1d0: Route iOS exact-testID actions through the authoritative React-tree prover, reconnect that exact runtime after native segments, refuse evidenced blind native WDA surfaces, and bound runner parking cleanup by the replay deadline.
- 7d70570: Surface the exact Expo Developer Menu dismissal tool and arguments in authoritative snapshots and always-loaded guidance while cleaning the exact advanced operation generation when recoverable admission later fails.
- 9dbb2c9: Consolidate Metro origin and session authority at the signed initial-bundle handshake while keeping launch endpoint checks diagnostic-only.
- b121a18: Delete the login prologue authority latch so `cdp_login_prologue` runs the exact `user-login` action and passes or fails like any other replay, and no tool is disabled because of the login result.

## 0.72.5

### Patch Changes

- c3a202e: Resolve wrapped React text handlers exactly while keeping native fills single-shot and verified.

## 0.72.4

### Patch Changes

- 8616624: Bound the system-dialog fallback presence probe to a 15-second default (explicit caller timeouts through 120000ms remain accepted) so Android and session-less iOS calls with no dialog return typed DIALOG_NOT_FOUND promptly instead of appearing hung for two minutes, and teach the tool-docs generator to parse prettier-wrapped .describe() calls and wrapped zod chains so parameters such as timeoutMs and device_find.index are no longer published as undocumented unknowns.
- 37c65e3: Keep inherited learned-action inventory bounded and refuse inventory or replay if its operation-scoped corpus snapshot changes.
- 804aefb: Fix Observe HTTP request-body handling by preserving multi-byte UTF-8 code points split across TCP chunks and draining oversized bodies while returning parseable JSON 413 responses over usable keep-alive connections.
- 017ad96: Settle SQLite supervisor relaunch spawn failures on error or exit once, with a diagnostic and no hanging promise.

## 0.72.3

### Patch Changes

- 744c313: Scope writable WDA cache provisioning to iOS, keep permission regressions portable under root, and hash action IDs in feedback-safe runner diagnostics.

## 0.72.2

### Patch Changes

- a5feed4: Make maestro-runner pin installation idempotent with independently verified temporary stages and atomic publication so concurrent or interrupted installers cannot block the cache.
- 53ffc53: Keep valid action inventory entries available around corrupt files with typed warnings and avoid allocating Maestro report directories before preflight passes.
- 663441e: Carry the session-allocated Android Metro endpoint through Expo launch, wait, native configuration, and adapter connection.
- de5350f: Keep verified runner snapshots immutable while provisioning a lifecycle-bound writable WDA cache and attaching bounded sanitized runner diagnostics to feedback.
- 067c6ff: Route auto-login through the exact bound device and refuse unbound ambient device selection with an executable authority remedy.
- 6e69ea5: The login prologue remains a fail-stop navigation helper that requires a fresh user-login RunRecord, terminally blocks credential fallbacks, and coexists with exact locked e2e login proof without serving as PR proof.

## 0.72.1

### Patch Changes

- 6c12426: Update packaged engineering-document references to their canonical owners.
- 48018f4: Honor the allowlisted linked-worktree `.rn-agent/actions` corpus in inventory and exact-ID replay, while still refusing dangling, foreign, whole-directory, and replaced links.
- d847b3b: Add verified cross-platform Expo Developer Menu dismissal with Android parity, typed readiness outcomes, and default attaching-agent surface preflight guidance.

## 0.72.0

### Minor Changes

- b89ff50: Require pin-cache maestro-runner `>= 1.1.24`, keep SHA256 attestation for the 1.1.24 artifact this package installs as the default known-good, accept learned-action `enginePin` values at that floor or newer, and refuse PATH, ambient Maestro CLI, older runners, and unattested binaries without a Maestro CLI fallback.

### Patch Changes

- 2dd53a6: Preserve arbitrary Unicode text in Android runner commands by declaring the JSON request body as UTF-8 before NanoHTTPD decodes it.
- 6889910: An incomplete renderer-root scan (missing or malformed DevTools `renderers` registry plus the empty-ID early-exit) is no longer treated as proof the app is still mounting, so a live root on a sparse renderer ID above 5 keeps the legacy no-navigation result instead of `mounting: true`.
- ae0097e: An explicitly present but empty M7 `# mutates:` or `# produces:` field is now treated as invalid (`?` / `metaInvalid`) instead of omitted (`-`), so inventory rendering matches the GH #525 present-vs-absent legend.
- 800252f: A recorded owner pid that the OS has recycled into a process this user cannot inspect now counts as proven dead instead of unprovable, so startup cleanup releases the stale ownership rather than wedging the source root forever; a proven-live owner and a genuinely unreadable identity still refuse with no force-steal, abandoned blocked contenders that never held a claim are discarded at startup, every affected refusal names a concrete remedy for interactive and headless clients, and the packaged `session-doctor` command reports and repairs a wedged root from a `claude -p` session that cannot run `/mcp`.
- b89ff50: Close remaining Maestro 1.1.24 contract gaps: refuse complete regex selector syntax, migrate `.yml` without writing through inherited action symlinks, and route replay/recovery/helpers through pin-cache tools instead of ambient runner or manual login.
- b89ff50: Ignore AppleDouble, `._*`, and PaxHeader archive members when attesting the pin-cache payload so a checksum-matching maestro-runner 1.1.24 can spawn on Darwin extract layouts.
- b89ff50: Keep execute permission on the copied pin-cache `.runner-exec` helper so `cdp_run_action` can spawn the attested runner.
- 25348eb: Keep reconnect detection-only for legacy linked-worktree root links and provide an explicit locked repair that restores per-worktree integration and local state while sharing only the learned-actions corpus.

## 0.71.7

### Patch Changes

- 02b2713: Make `cdp_navigation_state` report truthful mid-mount retry guidance instead of questioning the router install right after a reload (bundled-framework evidence now comes from Metro's module registry and the dev-shell allowlist matches only exact LogBox names), add an opt-in bounded `walkUp` pressable-ancestor press to `cdp_interact` documented as a boolean in the generated tool docs, render learned-action metadata absence as `-`/`pre-M7` with `?` for any parse failure including partially malformed `produces` maps, and keep the packaged sending-feedback skill host-neutral with collector resolution owned by each host's workflow.
- 2a36f7d: Add `rn_session` action `bind_source` so linked git worktrees can rebind the session source root explicitly: the successor session mints on the declared same-repo worktree instead of the harness startup cwd, source-consuming actions accept a `projectRoot` fence that refuses divergent roots with the new typed `SOURCE_ROOT_DIVERGENCE` naming both paths, the release hint now names the root the successor will actually bind, install-artifact content reads get a 180s budget (was 30s) so hashing a large APK over a tunneled remote-farm adb transport no longer times out, and an autostarted Observe binding yields the device axis on the first `bind_device` (GH #776).
- f127182: Prove the platform of custom-named devices ("rn-qa"-style simulators) against the live device inventory — booted simctl simulator names plus, only for a session-bound Android serial, that one device's adb model (ambient adb devices are never queried) — so `cdp_connect` binds the sole healthy exact-device Metro target instead of failing with a false "found 0", and name the true failing stage in exact-connect refusals.
- abcd72a: Fence `adb` reads for exact-connect device/platform inference whenever an authority session is present, so an available authority with no device binding, a registry lookup that throws, or an unavailable runtime whose code is not `SESSION_NOT_INITIALIZED` (`SESSION_OWNER_LOST`, `PROCESS_BIRTH_UNAVAILABLE`, `AUTHORITY_STORE_UNAVAILABLE`) no longer falls back to ambient `adb devices`; only a runtime that was never initialized keeps the legacy ambient read, and raw `device_*` tools are unaffected.
- fb1eea9: Observe now renders an explicit blocked device state with a typed recovery hint when session authority is unbound, bounds frameless mirror pipelines with a first-frame watchdog instead of an indefinite blank stream, and shows device-mirror readiness as its own header pill so event-stream transport liveness can never masquerade as a live mirror.

## 0.71.6

### Patch Changes

- 7eff66a: Bound dead-Metro `cdp_status` to the discovery scan budget by skipping runner-spawning picker probes when no Metro is up, and absorb the fresh-simulator first-start rn-fast-runner transient with one bounded internal retry after the failed first spawn provably exits.
- 83798d9: Resolve the Observe actions/e2e project root from the bound session's declared app root (falling back to RN_PROJECT_ROOT, then heuristic discovery) and refuse truthfully on foreign, missing, ambiguous, or non-project roots instead of showing another checkout's actions or a silently empty panel.
- d046940: Admit a fresh MCP transport when the blocking claim epoch is already gone instead of rebinding the leftover blocked session.

## 0.71.5

### Patch Changes

- a43ee7d: Allow canonical detect-libc Linux getconf/ldd module-load probes through managed Metro's descendant fence without opening arbitrary descendant execution.

## 0.71.4

### Patch Changes

- d90e0ed: Fix the three linked iOS session-recovery defects from GH #750: extend the iOS exact-target readiness deadline to the Android 120s bound so the sole exact-device bridgeless target that re-registers slowly after the managed terminate+relaunch is admitted and B binds atomically (accepting an advisory `targetId` while B is unbound instead of refusing every id), reprofile `cdp_dismiss_dev_client_picker` to run without the A/B authority it exists to restore and prove A/B through the managed-origin lifecycle after a successful dismissal, and refuse maestro-runner replays on a drifted engine pin when the flow (including runFlow-nested steps) uses regex text selectors that drifted runners mistranslate into impossible WDA CONTAINS predicates.
- d56efe1: Fix `cdp_navigate`/`cdp_navigation_state`/`cdp_nav_graph` nav-ref discovery failing with "Navigation ref not found" on multi-renderer bridgeless apps: the fiber walk now resolves NavigationContainer names through React Navigation 7's forwardRef wrapper (`fiber.type.render`) on every registered renderer.
- de8d516: The legacy ambient connect handler exported by `rn-dev-agent-core` no longer dead-ends an explicit force reconnect while a supervised reconnect is in flight (it now supersedes it, with a new `CONNECT_IN_FLIGHT` refusal code for non-force callers); the registered `cdp_connect` tool was already safe and is unchanged.
- 9475fe5: Reconnects now persist a pinned target's device and bundle identity so shared-Metro multi-simulator sessions re-bind the exact pinned device and fail closed with candidates listed instead of silently attaching to a sibling simulator.
- 9c2fc53: maestro_test_all now commits the proof-carrying install-receipt re-issue after a clearState corpus flow reinstalls the app and resolves the iOS app container from the authority-bound simulator UDID instead of generic `booted`, so a corpus containing clearState flows no longer breaks install identity for every subsequent flow and tool call.
- 992dafb: If the iOS idb live mirror stays alive without a first frame, Observe now fails that stream and falls back to the simctl screenshot loop on the same device instead of leaving a blank 0x0 image, with the bounded first-frame wait configurable via `observe.mirror.firstFrameTimeoutMs` (default 30000).
- bbe8791: Pin device sessions to their Metro origin: record the expected Metro port on the device binding and refuse cdp*connect and device*\* tools with METRO_ORIGIN_MISMATCH when the bound device's app is proven to be served by a sibling Metro (dev-client fallback), while unprovable origin evidence keeps the existing optional-origin behavior.
- e5a92d0: Preserve the signed install receipt's buildGeneration across an authenticated managed-Metro restart when the installed artifact re-proves byte-identical on-device, so `rn_session pin_dev_client force=true` recovers coherent authority without a ceremonial full rebuild while changed, missing, foreign, stale, or unattestable installs still fall back to the bumped generation and refuse fail-closed.

## 0.71.3

### Patch Changes

- 64b29b2: Refuse maestro-runner action replay on Android below API 26 with a truthful capability diagnosis instead of an opaque install error, and point RUNNER_OWNERSHIP_MISMATCH refusals at the device_snapshot re-open repair instead of a status read that repairs nothing.
- 89ee7f4: Separate exact native device control from managed source-origin evidence so raw snapshot, screenshot, press, fill, batch, and equivalent runner operations use exact controller/source/install/device/runner authority, explicitly report `originAuthority`, and keep origin-unproven captures out of strict proof, cross-platform verdicts, and learned-action evidence.

## 0.71.2

### Patch Changes

- 390567b: Recover plugin-owned Android UiAutomation wedges on the exact bound device, while refusing unscoped cleanup and surfacing release warnings.
- 6142e32: Make `device_fill` truthful: bind exactly one input (direct ref/testID or unique `${name}-pressable` wrapper mapping) before any mutation, resolve/focus/type in one exact native operation that never substitutes an ambient-focused field or blind-types app-wide, verify every attempt (JS, native, retype, Maestro, timeout recovery, `device_batch`) through a new required secret-free `verifyInput` read-back so `filled:true` always means a stable exact value, and hard-fail unverifiable outcomes as `NO_TEXT_INPUT_TARGET`/`TEXT_ENTRY_UNVERIFIED` with mutation dispositions instead of soft-accepting them.
- 639dd05: Scope Android element matching to the owned app by default, refuse covered exact accessibility targets before actuation, and report uncertain Android effects without automatically dispatching the interaction a second time.
- 115fdf9: Establish and safely clean exact physical Android Metro reverse forwards, and keep integrated builds on the session's resolved authority state home.
- d0c08e0: Make `DEVICE_BUSY` refusals report sanitized live-holder and bounded heartbeat diagnostics with ownership-safe close, dedicated-device, and stale-recovery guidance.

## 0.71.1

### Patch Changes

- f538146: Fold the initial stale-device transfer into `bind_device` with `confirmed: true`: a proven-dead device owner is released inline through the same journaled cleanup engine with death re-proven from durable state and no capability token minted, an interrupted journal resumes token-lessly via a bare `bind_device` of the same target, and `release_stale_device` stays as a token-less compatibility alias that accepts `confirmed: true` (or a previously minted legacy handle) while live, unproven, split, foreign-worker, and mismatched-journal cases keep refusing without mutation.
- 95efdf1: Launch iOS Expo dev clients through the session's authority-bound Metro when no explicit dev-client deep link was bound.

## 0.71.0

### Minor Changes

- 7419435: Replace the text-entry fallback ladder with exact fiber/native owners that mutate once and require stable exact read-back.

### Patch Changes

- e4465e5: Enforce Android exact-target readiness as one absolute 120-second wall-clock deadline, staging the exact client off-global until live proof and an atomic authority commit succeed while preserving ambient state on failure and iOS behavior.
- 26d41da: Capture sanitized local failure and recovery patterns through the existing tool observer, deduplicate and bound the evidence store, and add a read-only trend report command.
- 6c1533f: Report an installed-but-crashing fb-idb client as an interpreter incompatibility instead of looping on an "install idb" hint that reinstalls the same broken combination (#578).
- 2d4b44f: Let a Maestro flow containing a mid-flow `launchApp` relaunch run to completion by re-proving the managed native origin once at flow end — reconnect-only, with no second cold start — instead of aborting between stages when the relaunched dev-client has not re-registered yet, so the flow's own post-launch steps can drive it back to the managed origin while a genuine authority mismatch still fails the run.
- b2c8cc8: Redact `device_fill` text from stored Observe timeline events while retaining the target, text length, status, and other diagnostic metadata.
- 722349e: Let `cdp_restart hardReset=true` complete the cold start it promises from a runner-bound session by classifying a terminated-but-unreaped process as absent rather than as an unreadable identity, and by escalating the bound runner's stop to SIGKILL after its SIGTERM grace once the pid is re-proven to carry that binding's exact birth token.
- 8a7510b: Recover the session after a plugin-initiated byte-identical reinstall (for example a runner-respawn recovery) by retrying a refused install-identity preflight once behind the existing artifact-digest proof, except while a strict proof run is bound where the reinstall stays a hard stop and status projects the new install_identity_reissue_blocked state naming proof_capture discard as the way out, so rn_session status and cdp_status always report a truthful installIdentity verdict instead of claiming ready while gated tools refuse.

## 0.70.3

### Patch Changes

- 3563b3c: Report a stale-device release that already committed as a success naming the lost fence, instead of failing the whole call with `AUTHORITY_LOST_DURING_OPERATION` when the authority generation moves on after the commit.

## 0.70.2

### Patch Changes

- 661979e: Capture navigation-initiating taps on controls mounted before recording starts without duplicating app handler calls, so saved open/close actions begin with the initiating tap instead of an unreachable visibility assertion.

## 0.70.1

### Patch Changes

- 9a3d901: Derive every gated-tool `SESSION_AUTHORITY_REQUIRED` refusal from the session's own measured `recoveryRequirement` instead of naming unreachable `accept_handoff`/`adopt_stale` actions, retain and project a refused proven-dead startup cleanup as a `startupCleanupBlocked` carrying its typed code and truthful remedy rather than promising that another transport restart converges — redacting the refusal at the outcome boundary so no producer diagnostic, serial, PID, or path is ever logged, journaled, or projected — and propagate the ownership-recovery contract into the replay, readiness, and discovery workflow surfaces.

## 0.70.0

### Minor Changes

- cafb36d: Add the `rn-workflow` skill and `/rn-dev-agent:run-workflow` command that sequence the proven operating chain before a real device journey — declared package-manager install, read-only inventory, typed `rn_session` recovery with status as the sole classifier, one exclusive device, managed integration and Metro, replay only via `cdp_run_action` after readiness proof, and reverse-order cleanup verified by the new deterministic `workflow-check` CLI.

### Patch Changes

- 7cb0d40: Re-issue the install receipt after a Maestro `clearState` reinstall of the session's own artifact — proven by re-hashing the installed bytes against the bound artifact digest, with any other or unattestable artifact still refused as `APP_INSTALL_IDENTITY_CHANGED` — and accept an `appFile` on `cdp_run_action` that otherwise resolves from that same receipt.

## 0.69.6

### Patch Changes

- f20c90f: Resolve a fresh session for the next worker when the current one is released or proven stale, so `rn_session action=release` is no longer a `SESSION_OWNER_LOST` dead end and released or proven-stale rows never trigger a spurious `SESSION_AUTHORITY_REQUIRED: multiple live sessions`.
- b219094: Name the exact non-Git declaration remedy — `RN_DEV_AGENT_DECLARED_ROOT` for the exact existing application root and `RN_DEV_AGENT_DECLARED_MANIFESTS` for the required existing manifest files — in `NON_GIT_MANIFEST_REQUIRED` refusals, unavailable session status, and the canonical session-authority, setup, and readiness-workflow documentation, while keeping refusal and mutation behavior, Git-worktree identity, implicit-directory distrust, symlink containment, and the never-generated declaration unchanged.
- 6716c15: Refuse orphaned integrated builds with exit code 2 and the supported `restore_integration` repair instead of starting an unmanaged bundler, and bound every stdio-capturing session-CLI wait so wedged CLIs fail typed; projects integrated by an earlier version must re-apply integration to refresh their on-disk adapter.

## 0.69.5

### Patch Changes

- d7a814f: Return a successful `release_stale_device` envelope only after its authenticated, device-scoped cleanup commit atomically advances the contender's fenced authority generation while preserving stale-owner death proof, exact claim epochs and handles, resumable runner/recorder cleanup, and neighboring source, Metro, install, package-integration, and port authority.

## 0.69.4

### Patch Changes

- 03603da: Replace default stale-owner adoption for new `grouped-v1` sessions with automatic verified-dead startup cleanup: a restarting supervisor journals obligations on the proven-dead same-root session's row before any side effect, stops its recorded children by exact identity, restores package integration only from the SHA-256-verified manifest, releases claims only after every obligation is durably complete, and mints no adoption or handoff-recipient handles, while a live or unproven owner keeps refusing and legacy sessions retain the adoption surface for drain.

## 0.69.3

### Patch Changes

- c070bf0: Give Android exact Dev Client pinning a bounded cold-start readiness window so a target that passes its initial CDP probe but stalls during setup can be disconnected and re-listed once it becomes responsive, while preserving exact Metro, app, and device filtering and the existing iOS timeout.
- c070bf0: Keep the adb serial as Android authority while translating it to Expo's uniquely verified model or AVD display name only at the Expo CLI boundary, refusing missing, unauthorized, duplicate, foreign, or drifted mappings before Expo starts, pinning Expo's adb work with `ANDROID_SERIAL`, and preserving serial-bound build completion and abort behavior.

## 0.69.2

### Patch Changes

- e4bf0c2: Make runner unbind release its exclusive claim and clear the runner binding in one atomic registry transaction, so an interrupted device close or reacquire can no longer leave a divergent store whose dead session permanently vetoes `adopt_stale` with `RUNNER_OWNERSHIP_MISMATCH` (GH #692).

## 0.69.1

### Patch Changes

- 9cccec7: Regroup authority-profile bookkeeping around the four ownership groups (Session, Target, Runtime, Automation) with every tool's resolved facet set, live probes, and error codes unchanged, and verify profile exhaustiveness at worker startup so an unprofiled registered tool fails at boot instead of at first call.

## 0.69.0

### Minor Changes

- 5e37f16: Project strict proof as an explicit opt-in `proofOverlay` (`active` only while a run is in flight between `begin_rehearsal` and `finalize`/`discard`) outside the grouped `session`/`target`/`runtime`/`automation` sub-objects, keeping the existing `proof` child flag and all redaction rules unchanged.

### Patch Changes

- c8b03c1: Reset an exact Android CDP connection after an advertised inspector handshakes but fails the mandatory runtime probe, serially re-list only the session's allocated Metro for the same app and serial/model association, and retain the actionable probe-timeout leaf when bounded re-registration expires.

## 0.68.0

### Minor Changes

- 5365f82: Make Observe a read-only child of the session: `observe start` and `restart` now require only the live session (matching autostart's degraded mode) instead of the full device/Metro/bundle/runner authority chain, while the observe-port claim, capability and instance request authentication, fenced stop/cleanup chain, and the full authority gates on the E2E run and action panels all stay exactly as before.

## 0.67.0

### Minor Changes

- e953f49: Add an additive grouped projection to session status — a happy-path `phase` (`selected`/`building`/`running`/`closing`), the internal state in `detail`, `session`/`target`/`runtime`/`automation` sub-objects, and `observe`/`proof` child flags — alongside every existing field, with unchanged redaction.

## 0.66.8

### Patch Changes

- 76a6045: Stop a second supervisor for the same app root from misreading the live owner as a reused PID and stealing its single-instance lock, keep blocked contenders from opening operational children, rotate expired adoption handles so `status` never advertises a capability `adopt_stale` refuses, add a bounded capability-authenticated release for a proven-dead device or runner owner discovered after startup that transfers only the exact device cleanup obligations, and report whether recovery needs a transport restart, an attach, or an adoption.

## 0.66.7

### Patch Changes

- 3ee229d: Keep managed Metro descendants strict by default while allowing only Expo's canonical runtime-version manifest utility without session capability and requiring exact managed launch provenance.

## 0.66.6

### Patch Changes

- 5b0a93f: Keep `.rn-agent` real and worktree-local by inheriting only `.rn-agent/actions` through consented setup and repository-local post-checkout integration, keeping SessionStart report-only, and migrating recognized legacy root links without copying mutable integration or session state.

## 0.66.5

### Patch Changes

- e7c04dc: Keep session-bound Dev Client discovery and reconnect, reload, and restart recovery on the exact managed Metro port, and recognize modern Bridgeless Hermes targets whose inspector metadata omits the legacy `vm` field, while continuing to require the signed runtime marker before authority becomes ready.

## 0.66.4

### Patch Changes

- 89bdf7a: Classify maestro-runner 1.1.x ID-wait misses as SELECTOR_NOT_FOUND, surface bounded head+tail failure evidence with the exact selector on every terminal path, resume reactive CDP/JS replay at the failed selector instead of redispatching executed mutations, and refuse launchApp keys the CDP transport cannot honor.

## 0.66.3

### Patch Changes

- 8cd1ea2: Fix inline Maestro cold-start timeouts and authority transitions, bridge-lifetime cleanup refusal, optional learned-action bundle gating, truthful date-picker failures, and sanitized exact-device iOS screenshots with relative-path support.

## 0.66.2

### Patch Changes

- 802efa2: Allow runner-verified exact iOS keyboard targets to activate once while removing corruption-prone automatic keyboard swipes and rejecting stale runner artifacts.

## 0.66.1

### Patch Changes

- 7937883: Coalesce helper setup and reinjection per execution world, require the exact helper version, and report bounded truthful helper-health evidence.

## 0.66.0

### Minor Changes

- 784c880: Add fail-closed fenced worktree sessions with exact build, Metro, device, runner, Observe, and strict-proof authority.

### Patch Changes

- 784c880: Store the package-integration restoration manifest durably inside the session binding, let on-disk manifest bytes authorize only the current owner's restore_integration, and make stale adoption, handoff acceptance, and resumed cleanup validate their capability non-mutatingly — resumed handoff cleanup now re-proves the exact consumed handoff and its original token against a durable cleanup binding pinned to the accepting target session and claim epoch, so a stale-adoption transfer revokes the old handoff capability in favor of the adoption handle — and refuse before any transfer or mutation unless the binding itself carries a SHA-256-verified restoration manifest, reporting file-state diagnostics and the supported recovery step instead of auto-reconciling.
- 784c880: Launch Expo session builds with a command shape the installed Expo CLI accepts and release pending build authority through an authenticated abort when the native command fails before completion.
- 784c880: Give authenticated managed-Metro descendants an open stdin so Tailwind-backed transforms cannot stall, and fail typed instead of hanging when a child's first authenticated exchange never completes.
- 784c880: Guarantee single-emission signed Metro startup with gate-composed strict-proof input handling, pre-helper error evidence, allocated-port exact-device reconnects, and authoritative migration, runner, and stale-Metro recovery.

## 0.65.8

### Patch Changes

- ef084e4: Add native Codex parity for all fifteen workflows, deterministic read-only plugin health and restart guidance, Codex-native AGENTS.md setup, and complete packaged helpers. Disable best-effort command migration and publish a usable `proof_capture` action schema while retaining strict branch validation.

## 0.65.7

### Patch Changes

- 0e36a39: Classify WDA bootstrap failures from full structured replay evidence without adding preparation side effects.
- 0e36a39: Close final issue #588 validation gaps by failing closed when iOS runner authority is lost after typing, reaching Bridgeless keyboard blur, honoring exact active-session lifecycle identity, accepting the packaged Codex supervisor as candidate authority, and exposing per-call blind-probe compatibility control.
- 0e36a39: Close issue #588 live-validation gaps with exactly-once keyboard recovery, propagated iOS fault controls, non-rewriting action telemetry, explicit replay evidence, and device/app-scoped native logs.
- 0e36a39: Bind Maestro replays to the exact active device, reject mismatched direct runner or WDA provenance, and persist RunRecord device identity from execution evidence instead of requested metadata.
- 0e36a39: Guard taps with versioned fresh keyboard geometry and dismiss visible keyboards before unknown-geometry interactions.
- 0e36a39: Let each iOS XCTest runner request an OS-assigned listener port so parallel simulators cannot collide on port 22088, and make listener startup failures fail XCTest instead of producing a misleading passing result.
- 0e36a39: Launch exact Android sessions on keyless AVDs and report app-launch failures separately from runner startup failures.
- 0e36a39: Allow successful action replays to append runtime telemetry when only the tracked YAML mtime baseline is stale, while retaining sidecar CAS conflict detection and strict guards for every YAML-mutating promotion or repair.
- 0e36a39: Prove Bridgeless app identity from canonical Metro metadata and prevent agent prompt text from impersonating foreign iOS runners.
- 0e36a39: Accept exact, unambiguous maestro-runner device identity from its pinned-device log and structured report, and scope Android app lifecycle to the active session's exact adb serial, while continuing to reject missing, contradictory, shared, or multi-device evidence.
- 0e36a39: Refuse explicit and session-derived CDP platform mismatches while retaining warned best-available filterless discovery.
- 0e36a39: Restore actionable component-state truncation and tree scan-budget diagnostics without expanding tool schemas.
- 0e36a39: Scope iOS attach-only app liveness checks to the resolved simulator UDID instead of the ambiguous `booted` alias, and refuse when exact device identity is unavailable.
- 0e36a39: Bind strict cross-repository proof receipts to both the app fixture and the exact packaged plugin runtime.
- 0e36a39: Require exact independent readback for iOS type-timeout recovery and poison and reap the wedged runner.

## 0.65.6

### Patch Changes

- e3986d3: Make Android learned-action failures, device affinity, launch accessibility readiness, restart recovery, and batched input ordering deterministic and explicit.

## 0.65.5

### Patch Changes

- 2bf6d4f: Discover React Navigation refs and state across every renderer ID registered with the React DevTools hook, while preserving the bounded numeric renderer probe so partial registries keep legacy coverage.

## 0.65.4

### Patch Changes

- f66eb3f: Isolate the empty-Metro lifecycle integration tests from live default-port Hermes targets (#577): CDP discovery's default port list (8081/8082/19000/19006 + `RN_METRO_PORT`) is now resolved lazily per call, and a new `RN_CDP_DISCOVERY_PORTS` override replaces it entirely — so the integration suite owns its whole discovery surface and stays deterministic while a real React Native app is running on the host. Production discovery is unchanged when the variable is unset.

## 0.65.3

### Patch Changes

- 61f136e: Fix observe UI Route/Store/Tree panels staying empty while the device mirror shows the running app (#579): the panels now auto-read live state through a new `GET /api/state/(route|store|tree)` endpoint that resolves the CDP client at call time — so they populate on a healthy connection without the agent having run the introspection tools and recover after a reload/reconnect — plus a manual "read live" refresh button in each panel.

## 0.65.2

### Patch Changes

- 619c5fe: Accept a visually matched final proof screenshot when iOS video metadata ends up to two seconds before the assertion timestamp.

## 0.65.1

### Patch Changes

- fdfa8bb: Make strict proof portable, TypeScript-native, and tolerant of clean recordings up to five seconds beyond the adaptive target.

## 0.65.0

### Minor Changes

- 4e9bf7e: Add strict storyboard-gated video and screenshot proof receipts for unattended feature delivery.

## 0.64.0

### Minor Changes

- 9359723: Story 10 (GH #391) — text-input reliability recipes. iOS: the runner's `type` handler now waits (≤1 s, best-effort) for the keyboard before the first keystroke and types in Maestro's two-burst shape (first character, 500 ms pause, remainder), killing the dropped-first-keystrokes flake class; typing telemetry (`typingBurst`, `keyboardWaitMs`) surfaces in the response and threads into `device_fill`'s `meta.typing`. Android: the runner's `type` classifies its `ACTION_SET_TEXT` read-back (accepted / transformed / rejected), falls back to per-char keyevents at Maestro's 75 ms pacing when the set was ignored, and reports `SET_TEXT_REJECTED` when both tiers fail. Bridge: `device_fill`'s Android unsafe-char/length short-circuit to chunked `adb input text` is removed — emoji and long text now reach the runner's full-Unicode `setText` primary, with chunked adb demoted to a genuine last resort and `SET_TEXT_REJECTED` descending the ladder without wasted re-taps.

## 0.63.1

### Patch Changes

- 53c3fb3: Auto-heal `KEYBOARD_OCCLUDED` tap refusals JS-first (GH #379): when the iOS keyboard guard refuses a `device_press`/`device_longpress` because the tap point is under an iPhone QWERTY keyboard with no dismiss control, the bridge now dismisses via the new injected `__RN_AGENT.dismissKeyboard()` helper (RN `Keyboard.dismiss()`, falling back to blurring the focused TextInput host instance), refreshes the snapshot (targets relayout when the keyboard lifts), and retries the tap exactly once — surfaced as `meta.keyboardGuard: "js_dismissed"` + `meta.keyboardAutoHeal`. The retried tap re-runs the native guard, so a dismissal that didn't take effect re-refuses instead of tapping through. Also ships the #370 review follow-ups: the iOS refusal now carries a structured `code: "KEYBOARD_OCCLUDED"`, both runners report the guard step's native duration (lifted to `meta.timings_ms.keyboardGuard`), and `surfaceKeyboardGuard` hardens its never-throws contract against non-object JSON envelopes.

## 0.63.0

### Minor Changes

- de8f1c1: Story 14 (#407): runner transport recovery — every /command carries a commandId; on an ambiguous post-send failure the client issues one short status probe against the runner's outcome journal before invalidating. Recovered results return with meta.transportRecovery; mutating verbs are never auto-resent, eliminating double-fired taps; read-only verbs may be resent once. Unresolvable probes fall through to the existing invalidation path unchanged. Both native runners (iOS rn-fast-runner, Android rn-android-runner) gained a bounded command-outcome journal (32 entries, 8 KB UTF-8 body cap, snapshot/screenshot recorded state-only, error outcomes journaled) and the read-only `status` verb that replays a prior command's retained outcome.

## 0.62.3

### Patch Changes

- dc5a87b: Harden observe-recorder screenshot ingestion (GH #429): the recorder now only reads screenshot files the capture pipeline itself just wrote (single-use trust grants registered by `device_screenshot`), instead of any absolute image path named in a tool observation — closing an arbitrary local-file read surface on the observe server. The read itself is now TOCTOU-safe: one descriptor for the size check and the read, `O_NOFOLLOW` (no symlink following), and a hard byte cap enforced on the bytes actually read.

## 0.62.2

### Patch Changes

- dba5eb7: Observe UI test confidence (#438, audit P1-A): the web SPA and the
  observability server now share one wire-types module, the UI carries stable
  `data-testid` selectors, and a Playwright e2e suite exercises the real server
  against the committed bundle on every PR.

  - `src/observability/wire-types.ts` (pure types, zero Node imports) is the
    single source for `AgentEvent`/`AgentEventFamily`, the e2e run shapes
    (`E2eFlowResult`, `E2eRunRecord`, `E2eRunIndexEntry`, verdict/classification
    unions), `ActionSummary`, and the action-run result. The server modules
    re-export it and `web/src/types.ts` re-exports it too — the hand-copied
    twins are gone, and the web-bundle CI gate now runs `tsc --noEmit` on the
    SPA so server↔UI drift is a compile error (previously `vite build` only
    transpiled, so nothing checked).
  - 27 `data-testid` attributes across Header, FilterBar, Timeline, DevicePane,
    StatePane, ActionsPanel, and E2ePanel.
  - 10 Playwright specs (headless chromium) boot the real `ObservabilityServer`
    with a seeded `Recorder` + stub e2e deps on an ephemeral port: timeline
    render + family/errors/search filters, event detail, device hero
    screenshot, SSE live update, regression history + drill-down, and the
    CSRF-guarded suite/action run round-trips (including a 403 negative).
  - Server hardening from review: oversized `POST /api/e2e/*` bodies now return
    a bounded 413 instead of becoming an unhandled rejection, and the CSRF
    token is injected via `JSON.stringify` + `<` escaping so it can never
    break out of the inline bootstrap script.

## 0.62.1

### Patch Changes

- 78700be: Golden wire-contract tests from captured runner payloads + named CI gate (#437, audit P0-B).

  The biggest escaped-bug cluster (#396, #353, #418) was host↔runner wire-contract
  drift where hand-written fixtures encoded the wrong shape, so green tests
  certified broken behavior. This closes that hole:

  - `test/contract/capture-goldens.ts` records REAL `/health`, raw
    `POST /command snapshot`, error-envelope, and bridge `device_snapshot`
    payloads from live rn-fast-runner / rn-android-runner sessions into committed
    fixtures under `test/fixtures/goldens/<platform>/`, each stamped with capture
    provenance (device, OS, runner version, date). Goldens are captured, never
    hand-written.
  - `gh-437-golden-contract.test.ts` pins the TS parsing layer
    (`classifyRunnerCompatibility`, `findRefByTestID`, the ref-map oracle +
    snapshot verdict) against those captured payloads for both platforms, and
    pins the captured `v` stamp to `RUNNER_PROTOCOL_VERSION` — a protocol bump
    fails CI until goldens are re-captured against the new runner (refresh
    cadence, enforced).
  - New named CI step "Runner wire-contract gate" runs the #418 tri-surface
    command-enum sync, the #383 protocol-version sync, and the golden contract
    tests via `yarn workspace rn-dev-agent-core test:contract`, so wire-contract
    drift fails a visible gate instead of hiding in the unit blob.

## 0.62.0

### Minor Changes

- 3b27e7d: Story 16 (#409) — snapshot quality verdicts: degraded captures must say so.

  Every tree/snapshot capture now carries a structured quality verdict computed
  once at capture time, so a sparse or empty result caused by a degraded walk is
  no longer indistinguishable from a legitimately empty screen:

  - `cdp_component_tree` returns `meta.treeVerdict` (`state: ok|degraded|failed`,
    `path`, `reasons`, `rootsSeeded`, `scannedNodes`, `effectiveDepth`,
    `droppedSubtrees`, `collapsedChildLists`, `rendererErrors`,
    `unscannedRendererIds`). Previously-silent drop classes are now counted:
    per-renderer exception swallows, registered-but-unscanned renderers (the #126
    early-exit class), depth-cap subtree drops, scan-budget/wall-clock
    exhaustion, and output truncation. Requires injected helpers v34 — a stale
    bundle simply omits the verdict.
  - `device_snapshot` (iOS + Android runners) returns `meta.snapshotVerdict`
    (`state`, `source`, `nodeCount`, `refMapUpdated`, `reasons`).
  - Sparse captures never overwrite the last-known-good @ref map: a zero-node
    snapshot leaves refs bound to the last verified capture
    (`meta.snapshotVerdict.refMapUpdated: false`, reason `empty-capture`) instead
    of wiping the map self-healing taps depend on.
  - Interactive consumers fail closed: `device_find` (exact + fuzzy) and
    `device_focus_next` refuse a zero-node capture with `SNAPSHOT_DEGRADED`
    rather than asserting NOT_FOUND / "nothing on screen" on evidence that
    cannot support it.

## 0.61.9

### Patch Changes

- 2cc8c82: fix(device-system-dialog): make SpringBoard-owned iOS dialogs reachable (#545). `device_accept_system_dialog`/`device_dismiss_system_dialog` were Maestro-only, and Maestro's iOS driver only sees the app under test — the deeplink "Open in <app>?" confirmation and other SpringBoard dialogs timed out on every label probe (DIALOG_NOT_FOUND while the dialog sat on screen), and the `idb ui tap` escape hatch crashes upstream ("no current event loop"). With an open iOS session the tools now route through rn-fast-runner first: its snapshot returns a blocking SpringBoard modal exclusively as an Alert-rooted payload, and press resolves to a coordinate tap that lands on whatever owns the pixels. When the modal is up but no probed label matches, the tool returns the dialog's actual buttons (`DIALOG_BUTTON_NOT_FOUND` + `availableButtons`) instead of burning N×4s Maestro probes that can never match. `device_deeplink` on iOS now best-effort auto-accepts the "Open" confirmation before its picker check and annotates `meta.openDialogTapped`; the iOS DIALOG_NOT_FOUND hint documents the last-resort SpringBoard restart recovery (`launchctl kickstart -k system/com.apple.SpringBoard`). Maestro stays as the fallback for Android, in-app alerts, and session-less iOS calls. (The issue's third finding — picker dismiss being Android-only — already shipped in #523/#531.)

## 0.61.8

### Patch Changes

- 6be3bca: fix(rn-android-runner): align Android `hittable` semantics with iOS (#520). Both Android sources now route through a single shared predicate implementing the #395 definition — "enabled AND visibly on-screen": the snapshot path (window-hierarchy XML) was reporting bare `visible-to-user` (a DISABLED but visible control counted as hittable), and the find path (`UiObject2`) was reporting bare `isEnabled` (an enabled element with an empty visible region counted as hittable). Divergent semantics meant platform-dependent `device_find` ranking (+1000 hittable boost) and `device_batch` dead-control annotation for identical screens. The new `HittableSemantics` object lives in the main sourceset so the JVM CI lane pins it deterministically; a TS grep-sync test pins the dispatcher wiring (gh-397/gh-418 style). The Android runner's `/health` now advertises `HONEST_HITTABLE` like iOS. Device-verified on a Pixel 9 Pro emulator: snapshot distribution non-uniform (62/63 hittable; the fixture's new deliberately-disabled button reports `hittable=false`, which the old path reported `true`), and `findText` discriminates enabled ("Increment" → true) vs disabled ("Disabled" → false). No wire-shape change (capability list is additive, no protocol bump); existing runner artifacts pick the semantics up on their next rebuild/upgrade.

## 0.61.7

### Patch Changes

- 41924c4: Refresh the committed package-lock.json and major-cap the security-floor `overrides` (GH #441). Marketplace installs stopped consuming this lock when the dependency-free bundled host runtime shipped (`ensure-cdp-deps.sh` early-exits), but the lock remains a committed artifact: CI's packaged-artifact smoke installs against it, and any future npm resolve inherits the overrides. The stale v0.38-era resolution is refreshed with in-range updates (ws 8.21, yaml 2.9, hono 4.12.29, @hono/node-server 1.19.14, fast-uri 3.1.3), and the open-ended `>=` override floors are capped at each dependent's declared major — `>=1.19.13` alone resolved @hono/node-server 2.x against the MCP SDK's `^1.19.9` on a fresh regen. Re-staleness tripwires: a gh-441 unit test plus a sync-versions.sh check (CI) and `--fix` (release version bumps) keeping the lock's version fields tracking package.json.

## 0.61.6

### Patch Changes

- 74da26f: Fix #523: break the expensive iOS recovery chain. (1) `cdp_reload` that ends with zero targets now auto-chains `simctl terminate + launch` and reconnects instead of returning RECONNECT_TIMEOUT (`recovered_via: terminate_launch` in meta). (2) The last-connected bundleId is persisted per platform in `.rn-agent/state/last-bundle-ids.json`, so `cdp_restart hardReset:true` can relaunch even after a bridge worker restart wiped the in-memory cache. (3) `cdp_dismiss_dev_client_picker` now works on iOS (snapshot/press route through rn-fast-runner — the legacy-daemon guard was obsolete), also clears the stale-server "Error loading app" dialog, prefers the picker row matching the project's Metro port, and deprioritizes stale link-local (169.254.x) entries; `device_deeplink` auto-dismisses the picker on iOS too.

## 0.61.5

### Patch Changes

- 15def1d: fix(rn-fast-runner): honest `hittable` in iOS snapshots (#395). `hittable` now means "enabled and its center is on-screen" (plausibly tappable, half-open viewport bounds). The old occlusion heuristic counted trailing transparent full-screen containers (gesture-handler roots, portal hosts) as occluders and marked every node `hittable=false` on real RN screens — poisoning `device_find` candidate ranking, `device_batch`'s dead-control annotation, and starving the hittable-first screen-rect union (PR #517) into its all-nodes fallback. Real modal occlusion was never representable anyway: RN modals get their own UIWindow, so occluded content is absent from the XCUI tree entirely. Snapshot filtering (compact/interactiveOnly) is now explicitly hittable-independent, so snapshot sizes must not grow (small decreases expected: trailing contentless overlay wrappers the old algorithm marked hittable are no longer included). Intentional behavior change: a contentless, non-interactive-typed control rendered LAST in the tree (e.g. an identifier-less icon-only Image) was previously included by position-dependent luck (no later siblings → old hittable=true → included via the hittable escape hatch) and is now consistently excluded — give such controls a testID. Consumer-side calibration for the honest flag: `device_find` ranking now uses type priority first with hittable as a same-type tiebreak, the settle hash no longer includes hittable (it is derived from enabled + rect, both hashed, and its unquantized edge bit defeated the 4px jitter absorption), the screen-rect union is capped by Application/Window extents on iOS (center-on-screen elements can legitimately straddle the edge), and a healthy runner artifact missing the new compiled-in `HONEST_HITTABLE` capability queues a one-shot `meta.note` advisory that its hittable values are stale. The refusal half of the original #395 report ("no longer hittable" errors on modal screens) was a stale-ref message fixed by #396. No wire-shape change; new plugin releases pick this up via their per-version runner artifact. Dev checkouts: delete `packages/rn-fast-runner/build/DerivedData` to rebuild.

## 0.61.4

### Patch Changes

- f5beabb: Story 06 Phase C.2 (#387): the LLM-behavior evals now run on headless Claude Code (`claude -p`) funded by a Claude subscription — locally via the logged-in CLI, in CI via a `CLAUDE_CODE_OAUTH_TOKEN` secret. The `mcp-server-tester` dependency (and its judge-model patch) is retired; fixtures, baseline semantics, and the compare-baseline gate are unchanged.

## 0.61.3

### Patch Changes

- 1f07b3f: Post-merge review fixes for the Phase B device-smoke surface (two independent reviewers, findings cross-validated): (1) the screen rect used by direction device_scroll/device_swipe and scrollintoview's viewport check is now a hittable-first union — off-screen mounted content (RN FlatList windowing keeps rows past the fold in the tree with real coords, marked hittable:false) can no longer inflate the viewport and push gestures off the physical screen; all-nodes union remains as fallback for snapshots without hittable data. (2) The three direct fastSwipe call sites fall back to resolveBundleId('ios') when a legacy session lacks appId, closing the reopened host-app-drag gap. (3) The nightly integrity lane captures zip listings before grepping (grep -q + pipefail could SIGPIPE-false-fail a successful match). (4) The smoke's counter assertion is anchored (/^count: 1$/) and the screenshot check documents its encoding-only scope.

## 0.61.2

### Patch Changes

- abf974f: B269 (remaining half): treat idb client health, not PATH presence, as the source of truth. fb-idb installed under an incompatible Python (e.g. 3.14) crashes on every invocation; previously it counted as "present" everywhere, so the auto-installer never repaired it and the observe mirror selected the doomed idb tier and died ("idb video-stream keeps exiting", B263) instead of using the working simctl fallback.

  - `detectIdb()` (mirror tier selection) now probes a real `idb --help` invocation — ENOENT, a crash, or a hang all resolve to the simctl tier.
  - `ensure-idb.sh`'s foreground check health-probes the client and flags a present-but-broken one; the background worker replaces it (uninstall → reinstall → re-probe) and, if the reinstalled client still crashes, **uninstalls it and marks the attempt failed** — a crash-on-invocation client is never left on PATH, and the 24h backoff retries when a fixed fb-idb release ships.
  - `/doctor`'s idb row now scores the client by the health probe instead of PATH presence.

## 0.61.1

### Patch Changes

- e4cdf48: Fix idb-companion installation on current Homebrew: brew now refuses formulas from untrusted taps, so `brew tap facebook/fb && brew install idb-companion` fails with "Refusing to load formula … from untrusted tap" — the plugin's auto-installers (`ensure-idb.sh`, `ensure-idb-companion.sh`) silently failed every session while pipx still installed the (Python-3.14-broken) client, leaving the worst combination: broken client on PATH, no companion (B269). The install commands now run `brew trust facebook/fb` first (tolerant no-op on older Homebrew without the `trust` subcommand), and all ~10 user-facing hint surfaces (doctor, rn-setup skill, mirror hints in `sources.ts`, SessionStart warning, physical-device probe) show the trusted three-step command.

## 0.61.0

### Minor Changes

- 272c113: Add Codex plugin metadata and Yarn workspace package boundaries alongside the existing Claude Code plugin surface so rn-dev-agent can be used from both agents.

## 0.60.2

### Patch Changes

- 8c18951: Observe UI: surface the idb install hint as a banner under the device pane header while mirroring runs on the ~6fps simctl fallback, instead of an ellipsized footer line that truncated the brew command. Error hints stay in the footer. The idb install command is corrected everywhere to include the required tap (`brew tap facebook/fb && brew install idb-companion`) — including the executed installs in `ensure-idb.sh` / `ensure-idb-companion.sh`, which previously failed on untapped machines. `/rn-dev-agent:setup` now diffs an already-injected CLAUDE.md template block against the plugin's current CLAUDE-MD-TEMPLATE.md and offers an in-place refresh when stale (new `<!-- rn-dev-agent:template-end -->` sentinel delimits the block; legacy blocks are upgraded on refresh).

## 0.60.1

### Patch Changes

- f74b5b7: Observe UI: make the right state pane fit its width, and slim the timeline
  column.

  The right pane is a fixed ~26% column (~340-450px), but the actions tab
  rendered a 5-column table and the e2e tab 3- and 4-column tables. Tables
  cannot shrink below their column content, so at typical window widths the
  Status/Params/Run columns were clipped clean off the pane — the Run button
  was unreachable — and action ids line-wrapped mid-word. Both tabs now render
  stacked rows designed for a narrow column:

  - **Actions**: one item per action — id (truncating, full value on hover) +
    status badge + Run on the first line, intent wrapped below (2-line clamp),
    param inputs flex-wrapping to the available width instead of fixed 110px
    columns, result/output underneath.
  - **E2E**: suite results and run history as one-line rows — pass/fail mark,
    truncating test/run id, duration, classification badge or `2✓ 1✗` totals +
    verdict — with error excerpts wrapping below and the expanded run detail
    reusing the same row layout.
  - Pane guards: `.pane.right` gets `min-width: 340px`, tabs wrap instead of
    overflowing, long live routes break instead of pushing the pane wide.
  - Layout rebalance: the left timeline column drops from 40% to 33%
    (`min-width: 380px`; summaries already ellipsize), and the device pane no
    longer greedily takes all remaining width — the mirror is a portrait phone
    screen capped at ~100vh, so the pane is capped at 400px and the state pane
    absorbs the surplus instead.

## 0.60.0

### Minor Changes

- 24842f8: Story 13 (#397) Phases 1–2: maestro-runner engine pinning and a proactive blind-probe. The installer now installs the tested pin (`1.0.9`) exactly, verifies its checksum fail-closed on fresh downloads, and warns on local drift; `cdp_status.replayEngine` + `/doctor` report engine, version-vs-pin, and known quirks; `maestro_run` carries `enginePin` meta and warns once on drift (opt-in hard enforcement: `RN_ENGINE_PIN_STRICT=1`). `cdp_run_action` on at-risk iOS runtimes (>= 26, or a recent device-matched `TRANSPORT_BLIND` with clean-pass reset) probes the CDP tree first and, when the action's anchor is visible, skips the doomed ~40s WDA attempt and replays via CDP/JS directly — `RunRecord` gains additive `deviceId`/`blindProbe`, probe-routed failures classify as `FALLBACK_REPLAY_FAILED` (never false `TRANSPORT_BLIND`), probe-routed passes never auto-promote, and the DB mirror persists the new fields. Opt out with `RN_BLIND_PROBE=0`.

## 0.59.2

### Patch Changes

- d041bac: Harden the Android **raw** screenshot capture path (`device_screenshot`, GH #428),
  mirroring the iOS hardening from #427:

  - **Truncate-before-success**: raw capture now stages `adb exec-out screencap`
    bytes in a unique sibling temp file and `renameSync`s onto the caller's path
    only after both the write stream drains and adb exits 0. A failed or timed-out
    capture can no longer truncate-then-delete an existing file the tool never
    created.
  - **Multi-emulator first-pick**: with several emulators booted and no session
    binding, resolution now refuses (exactly-one-or-null via `resolveAndroidEmu`)
    instead of silently grabbing the first emulator — matching iOS
    exactly-one-or-refuse. Sessions still bind to their device id.
  - **adb child leak on stream error**: a write-stream error (ENOSPC/EACCES) now
    unpipes and kills the `adb` child before settling, instead of leaving it
    running blocked on stdout.

## 0.59.1

### Patch Changes

- f583249: `cdp_dev_settings` gains a `hideDevMenu` action that dismisses the iOS
  expo-dev-client dev menu bottom sheet over CDP via `ExpoDevMenu.hideMenu()`
  (#335). Because it runs through `client.evaluate` instead of a coordinate
  tap/swipe, it never triggers the touch-induced Hermes detach the issue
  describes — the JS thread stays attached and the in-memory store survives.
  `cdp_reload` now also best-effort auto-dismisses the menu on iOS after
  reconnect, so the agent lands on the app instead of behind the sheet. The
  dismiss resolves the `ExpoDevMenu` native module through a multi-tier chain
  (`globalThis.expo.modules` → `NativeModules` → TurboModule proxies) and is a
  silent no-op on non-expo builds.

## 0.59.0

### Minor Changes

- d6f72f7: Story 05 (#386) self-healing taps: stale `@ref` taps re-resolve inline by identity signature (unique-match only; ambiguous/absent STALE_REF now lists candidates), swallowed taps retry exactly once via settle-hash change detection (`meta.reResolved` / `meta.tapRetried` / `meta.noUiChange`), 3 consecutive no-change taps on distinct targets surface a wedged-runtime hint, and `device_batch` testID resolution refuses ambiguous matches (`AMBIGUOUS_TESTID`). Opt-outs: `retryIfNoChange: false` per call, `RN_SELF_HEAL=0` global.

## 0.58.0

### Minor Changes

- dabe8cc: Prebuilt runner artifacts (Story 01, #382): the iOS rn-fast-runner and Android
  rn-android-runner now resolve from a verified prebuilt artifact — a SHA-256-checked
  local cache, then a download of the release asset for the exact plugin version —
  before falling back to the on-machine build. This removes the multi-minute cold
  `xcodebuild` / Gradle build from the first `device_snapshot action=open` once a
  release ships the artifacts. Resolution is fail-open: any missing manifest, offline
  state, 404, checksum mismatch, or unsafe archive falls back to the local build with a
  one-line `meta.note`, never a hard failure. `RN_RUNNER_BUILD=local` forces the local
  build. `cdp_status` / `/doctor` now report runner provenance (`prebuilt v<X>` vs
  `local-built`). Until a release ships the artifacts, builds resolve to `local` by
  design.

## 0.57.0

### Minor Changes

- 8740f75: Observe UI: single-page layout — the Live/Regression view split is gone. The right column now has five tabs (route | store | tree | actions | e2e): learned actions run from the main page next to the live mirror, and E2E suite runs + history live in the e2e tab. The mirror status/hint moved to a slim footer so the device pane keeps its full height.

## 0.56.0

### Minor Changes

- a33f19d: Observe UI: continuous live mirroring of the simulator/emulator screen (Maestro-style MJPEG). New `GET /api/device/mirror` stream — idb (20–30fps) or simctl loop (~6fps) on iOS, adb screenrecord+ffmpeg on Android emulators and physical devices. Zero capture cost with no tab open; per-tool-call screenshots are skipped while the mirror streams. Config: `observe.mirror.enabled` / `observe.mirror.fps`, env `RN_AGENT_OBSERVE_MIRROR=0` to disable.

## 0.55.1

### Patch Changes

- 396e862: rn-android-runner `findText` refuses missing/blank `text` with a typed
  `INVALID_ARGUMENT` error (#444). Previously `optString("text")` silently
  defaulted to `""`, falling through to `By.textContains("")` — which matches an
  arbitrary node — so a malformed request reported `found: true` for whatever
  element UIAutomator visited first instead of surfacing an argument error. The
  guard runs in the dispatch when-branch before any selector is constructed;
  a source-sync test (gh-418 style) enforces it in CI without an emulator.

## 0.55.0

### Minor Changes

- 683a132: Story 04 (#385): shared two-tier settle engine. Every mutating device\_\* verb now waits for the UI to actually stabilize instead of relying on fixed sleeps: Android gates on a new `isWindowUpdating` runner probe (capability `WINDOW_UPDATE`) then falls back to snapshot-hash equality polling; iOS polls a new on-runner `isScreenStatic` SHA-256 screenshot compare (capability `SCREEN_STATIC`, Maestro's 3s screen-settle budget) with the same snapshot-hash fallback. Results surface `meta.settle: {method, settled}` + `meta.timings_ms.settle`. `device_fill` drops its fixed 150ms focus delay when settle ran and pins its target coordinates once up front (`--at-x/--at-y`) so the settle's ref-map refresh can never retarget the fill mid-call; its corrective retypes skip settle (their stability check is the CDP read-back). `device_batch` settles between steps by default at a batch-scoped 2500ms budget (per-step `settle: false` escape hatch) and its blanket 300ms inter-step delay defaults to 0 while settle is on. Legacy runner artifacts (no new capabilities) transparently degrade to snapshot polling — no rebuild required, the new verbs are deliberately NOT in the required-command gate. Opt out globally with `RN_SETTLE=0` or per batch step with `settle: false`; tune the per-call budget with `settleTimeoutMs` (a budget knob, not a disable switch). A perpetually-animating screen settles via hierarchy stability or returns `method: 'timeout'` at budget — bounded, never hanging.

## 0.54.1

### Patch Changes

- c15bc52: iOS `device_screenshot` honors the caller's `path` (#422): iOS pixels now route
  to `xcrun simctl io screenshot` even with an rn-fast-runner session open — the
  runner's screenshot verb writes inside its own sandbox and returns a relative
  `tmp/…` path the host can never serve, which blanked the observe UI panel and
  broke `sips` resizing (`meta.resize.reason: no-dimensions`). simctl was already
  the flow-active and runner-down backend; it is now the sole iOS pixel path
  ("pixels → simctl", D1249). Android is unchanged (its runner honors `outPath`
  host-side). Defense-in-depth: the observe recorder rejects relative screenshot
  paths instead of resolving them against the bridge cwd.
- c15bc52: `cdp_run_action` no longer dead-ends in an opaque UNKNOWN when WDA dies at
  launch (#423). Root cause chain from the field failure: the #317 CDP/JS replay
  fallback covers this exact case, but its single tree probe ran while CDP was
  mid-reconnect (the failed flow had just relaunched the app), was silently
  swallowed, and the fallback never engaged. The probe now retries (bounded,
  default 3×1.5s) until the probe testID is actually present — tolerating both a
  reconnecting CDP and a still-mounting app — and every skip is surfaced as
  `meta.cdpJsFallback: { attempted: false, reason }`
  (`no-replay-deps | no-probe-testid | cdp-unreachable | testid-not-in-tree`).
  A `cdp-unreachable` skip appends actionable guidance (check `cdp_status`,
  reconnect, stop foreign XCUITest automation) instead of a bare
  "failure not auto-repairable". Also (#422 hardening): the simctl UDID parsers
  now only consider iOS runtimes (a booted paired watchOS/tvOS simulator can
  neither win the screenshot UDID pick nor make the single iPhone look ambiguous
  to `resolveIosUdid`), and raw captures bind to the open device session's UDID
  when platforms match instead of picking the first booted device.
- c15bc52: iOS cold start persists a reusable `.xctestrun` (#424): `startFastRunner()` now
  runs `xcodebuild build-for-testing` first when no test product exists and then
  launches via the same `test-without-building` path as every warm start, instead
  of a single bare `xcodebuild test` — which never writes a `.xctestrun`, so
  self-built runners were permanently "not prebuilt" and every runner death cost
  another multi-minute cold build. The build phase keeps the 360s cold timeout;
  the launch phase uses the standard 30s ready window. The #418 stale-artifact
  rebuild tier funnels through the same path, so it also leaves a reusable
  artifact now.

## 0.54.0

### Minor Changes

- 8a21532: Command-surface gate (#418, B235): both native runners enumerate their supported
  commands in `/health.commands` (iOS derives it from `CommandType.allCases`, Android
  from a sync-tested `SUPPORTED_COMMANDS` list) and the liveness gate classifies a
  runner missing any bridge-required verb as stale (`missing-commands`). Remediation
  is tiered: `device_snapshot action=open` auto-invalidates the stale artifact and
  rebuilds — iOS deletes DerivedData and cold-builds (once per plugin version, behind a
  checkout-scoped build lock), Android deletes the runner APKs so self-install
  Gradle-rebuilds; mid-flow device tools refuse fast with `RUNNER_COMMANDS_STALE`
  instead of silently building. An unknown verb reaching the iOS runner now returns a
  typed `UNSUPPORTED_COMMAND` error instead of a raw Swift decode failure. Root cause
  of B235 fixed: the explicit iOS keyboard-dismiss path posted `dismissKeyboard`,
  which no Swift artifact ever accepted — the wire verb is now `keyboardDismiss`.
  `cdp_status` surfaces `deviceSession.runnerProtocol.missingCommands`. Hardening
  from per-edit review: the iOS runner validates client-supplied Content-Length
  (400 on invalid instead of crash/hang) and Android foregrounds alias verbs
  (press/fill/scroll) before dispatch.

## 0.53.0

### Minor Changes

- d5acd6b: Observe web UI overhaul: session header (connection, app, route, duration, call/error stats),
  filterable + searchable timeline with follow/pause autoscroll, device-screenshot hero pane with
  route chip, guided empty states, inline param inputs for learned actions (server now honors
  UI-provided params), expandable action output, and E2E run-history drill-down with per-flow
  error excerpts. The SPA is split from one 670-line file into focused modules.

## 0.52.0

### Minor Changes

- d12f18f: feat(rn-fast-runner): quiescence bypass — make XCTest's private quiescence wait a no-op inside the iOS runner (#384, Story 03). RN apps with Reanimated worklets/looping animations never report idle, so XCTest queries and snapshots stalled until per-symptom patches (runner-timeout shim, HID-synthesis scroll, 35s budgets) caught them; the bypass removes the idle-wait at the root — the same WebDriverAgent-lineage approach Maestro uses. Probes both private selector variants (`waitForQuiescenceIncludingAnimationsIdle:` and the Xcode-16 `:isPreEvent:` form), swizzles exactly one (classic preferred), and degrades loudly (`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`) when Apple drifts the API — the runner keeps working without the bypass. Default ON; opt out with `RN_QUIESCENCE_BYPASS=0` (resolved at runner spawn; threaded as `TEST_RUNNER_RN_QUIESCENCE_BYPASS` because xcodebuild only forwards `TEST_RUNNER_`-prefixed vars). Note: `XCUIElement.typeText` runs its own internal sync, so the type-timeout shim remains as a safety net. Auditable via `meta.quiescenceBypass` on the first command after boot, `QUIESCENCE_BYPASS` in `/health.capabilities`, and `cdp_status.deviceSession.runnerCapabilities`.
- 0cfa78a: The observe web UI now autostarts when the MCP worker boots in an RN project, listening on a
  stable default port (7333, `http://127.0.0.1:7333`) with an ephemeral fallback on collision.
  New `.rn-agent/config.json` block `{ "observe": { "autoStart": boolean, "port": number } }`
  plus `RN_AGENT_OBSERVE_AUTOSTART` env override (precedence env > config > default, matching
  `cdp.autoConnect`). The `observe` tool gains a `restart` action; `stop` is session-scoped.
  The live URL is recorded in a per-project state file and announced at SessionStart.

## 0.51.1

### Patch Changes

- 3cf6787: fix(device_batch): testID steps failed with a misleading STALE_REF on the in-tree runners (#396). `findRefByTestID` passed the envelope's ref through verbatim; the in-tree iOS/Android runners emit `@`-prefixed refs (`@e68`), so the testID branches of `device_batch` (find+tap / press / fill) composed `@@e68`, which missed the ref-map (`lookupRef` strips exactly one `@`) and surfaced as `Element at ref @@e68 no longer hittable — UI re-rendered since snapshot` even though the snapshot was taken fresh that same step. `findRefByTestID` now returns the canonical bare id in both the flat-nodes and nested-tree envelope shapes, restoring the documented "re-resolve at execution time" contract; the GH #114 producer-consumer contract tests are updated to pin the bare-id contract for the in-tree producers.

## 0.51.0

### Minor Changes

- 694a57d: feat(protocol): version the native runner /command wire protocol + move runner state out of /tmp (#383). Both runners' `GET /health` now reports `{protocolVersion, runnerVersion, capabilities}` and every response carries a `"v"` stamp; the bridge classifies a reachable runner with a missing/older/newer protocol or a skewed `runnerVersion` as stale and transparently reaps + reinstalls it (the first device tool call after upgrading from a pre-protocol plugin pays one runner restart — `meta.note: "runner upgraded (protocol/version mismatch)"`). Only a mismatch that survives reinstall surfaces the new typed error `RUNNER_PROTOCOL_MISMATCH` with exact rebuild commands. Runner state files move from fixed shared `/tmp` paths to per-device hardened files (0600, symlink-refusing, atomic) under the app-support state dir (`runner-state/ios-<udid>.json`, `android-<serial>.json`; Android persists only under a resolved serial) via a shared `util/secure-state-file.ts` also adopted by the session file; a live pre-upgrade runner pointed at by the legacy `/tmp` state is adopted once, reaped, and relaunched before the `/tmp` files are deleted, and a grep-enforced test keeps `/tmp` out of the runner clients. `cdp_status` → `deviceSession.runnerProtocol` surfaces the handshake.

## 0.50.4

### Patch Changes

- b1e0ad6: feat(keyboard-guard): in-runner keyboard-occlusion guard for live `device_press`/`device_longpress` taps on iOS + Android (#370). Before a guarded tap, the runner probes for a visible software keyboard whose frame contains the tap point (containment on a sane rect — non-empty, min height 120pt iOS / 150px Android, so accessory bars don't false-trigger) and auto-dismisses first when occluded. Android dismissal is `pressBack` + a bounded `waitForIdle(1500)` (≈3.6s measured incl. bounded idle), gated on a TYPE_INPUT_METHOD window with sane bounds so it never navigates back otherwise — requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`, now enabled at dispatcher init. iOS is verify-or-refuse: only the safe dismiss-control tap ("Hide keyboard"/"Dismiss keyboard"/"Done") is used, then re-verified; on iPhone standard QWERTY, which has no such control, the runner REFUSES the tap with `KEYBOARD_OCCLUDED … keyboardGuard=dismiss_failed` instead of tapping the keyboard, because XCTest's `swipeDown` on the keyboard triggers QuickPath slide-typing and corrupts the focused field (device-proven). Every guarded gesture returns `meta.keyboardGuard`: `"off" | "no_keyboard" | "not_occluded" | "dismissed"` (plus `dismiss_failed` inside the iOS refusal error). Opt out with `RN_KEYBOARD_GUARD=0`/`false`, resolved TS-side per command (`guardKeyboard` on the wire; absent → guard stays ON, so older clients keep guarding). Scope is command-handler tap/longPress only — `tapSeries`, by-text taps, element-center taps, the focus-tap inside type/fill, swipes/scrolls/drags, and `doubleTap` are explicitly unguarded. Follow-up #379 tracks a JS-first (`Keyboard.dismiss()`) auto-heal for the iOS refusal case; #378 tracks a pre-existing Android `foreground()` pre-flight stall surfaced (not fixed) during verification.

## 0.50.3

### Patch Changes

- a6112e6: fix(record): `device_record stop` no longer crashes on macOS with `adb_args[@]: unbound variable` (#374). In `record_proof.sh` the Android stop branch expanded an empty `adb_args` array unguarded (`"${adb_args[@]}"`); under `set -euo pipefail` on bash 3.2 (the macOS default `/bin/bash`) that is an unbound-variable error, aborting the stop before the pull/convert — so recording finalize (and, via a leftover Android `.pid`, even iOS stops) failed. All three expansions now use the `+`-default guard already present elsewhere in the file. Regression-guarded by a static invariant test (effective on bash 5.x CI) plus a behavioral reproduction gated to bash < 4.4.

## 0.50.2

### Patch Changes

- 0a9a732: fix(interact): cdp_interact no longer corrupts react-hook-form Controller-wrapped inputs (#336). `setFieldValue` keeps a string a string for string-typed fields (a digit-string injected as a number is coerced back to string only when the field currently holds a string — number/boolean fields are untouched). `press` gains an optional `value`: when provided, `onPress` receives the value instead of a synthetic event, so radio/chip-style controls whose onPress sets a form value select correctly. HELPERS_VERSION bumped to 33.

## 0.50.1

### Patch Changes

- d61985f: fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows, and route Android hideKeyboard replays to the official Maestro CLI (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Device verification surfaced that maestro-runner v1.0.9 silently no-ops `hideKeyboard` on Android (B223), so `maestro_run` now prefers the official Maestro CLI for Android flows containing `hideKeyboard` (verified to dismiss the keyboard on-device), warning when the CLI is unavailable; iOS is unaffected (maestro-runner honors hideKeyboard there). Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.

## 0.50.0

### Minor Changes

- 98d3fb7: Add an RNTL-style discovery resolver to the injected helpers. `resolveLadder` finds elements by `byRole(+name)` / `byText` / `byPlaceholder` — ported from React Native Testing Library (matcher + normalizer, accessible-name, role, hidden, host-kind) — with fail-closed truncation and fail-closed multiplicity (never silently picks the wrong element), hidden-element exclusion by default, and a selector bundle (`testID` / `text` / `accessibleName` / `role` / `placeholder` / `anchors`). `interact()` routes `role`/`name`/`text`/`placeholder` selectors through the ladder. Includes RNTL `matchDeepestOnly` so a composite+host fiber pair (e.g. `Text`+`RCTText`) resolves to a single on-device element instead of fail-closing as ambiguous.

## 0.49.0

### Minor Changes

- 5fe66c9: Action corpus run/repair history now persists in a derived, gitignored node:sqlite store (.rn-agent/state/actions.db) alongside the per-action JSON sidecars (Phase 1 dual-write: sidecars stay authoritative, the DB is a rebuildable mirror), with graceful degradation to sidecar-only when node:sqlite is unavailable. The worker enables node:sqlite via a version-gated --experimental-sqlite flag (Node 22.5–23.5); the engines floor stays >=22. cdp_status now reports the active backend as `actionStore`. The learned-actions inventory script is migrated from JavaScript to TypeScript (compiled to dist/).

## 0.48.0

### Minor Changes

- d3be838: #317 Phase 2: when an action fails on iOS 26.x because WebDriverAgent is blind (empty accessibility tree), `cdp_run_action` now replays the action's id-based steps through the CDP/JS transport and returns a real pass/fail verdict — restoring action replay (and the observe Regression Run button) on iOS 26.x. The fallback fires on both observed blind failure modes — `SELECTOR_NOT_FOUND` (probe = the failed selector) and `UNKNOWN`/WDA-died-at-launch (probe = the action's first testID) — guarded by an exact-match CDP-tree oracle so genuine drift still routes to repair. Fallback verdicts are labeled `transport:'cdp-js'` (handler-level semantics) and failed replays record `failureCode:'TRANSPORT_BLIND'`; unsupported step types (e.g. text-based selectors) fail loudly rather than passing silently.

## 0.47.2

### Patch Changes

- 8cf8d4e: Fix the observe Regression tab's per-action **Run** button doing nothing. The observe `runAction` wiring resolved the correct project root for `loadAction` but then called the inner `runActionHandler` (`cdp_run_action`) without passing `projectRoot`, so the runner re-derived it from `process.cwd()` (the plugin repo) and failed instantly with `NO_PROJECT_ROOT` before ever reaching the device. The resolved root is now threaded into `runActionHandler`, so a clicked action runs its Maestro flow on the connected app's project. (Follow-up to #348, which fixed the same root-resolution family for the actions list and suite.)

## 0.47.1

### Patch Changes

- 6dc02a8: Fix the observe Regression tab showing an empty actions list and "Run E2E Suite" always reporting PASS. The observe e2e surface now resolves the project root of the _connected_ app by its bundleId (`findProjectRoot({ bundleId })`), so a stray sibling React Native repo can no longer hijack the heuristic filesystem scan and point the actions list / locked-test discovery at the wrong project. A suite that discovers zero locked tests now reports a distinct `empty` verdict ("NO TESTS") instead of a false-green pass.

## 0.47.0

### Minor Changes

- 33db4be: feat(e2e): Actions panel in the observe page — list the project's actions and run any one (repairable `cdp_run_action`) with params resolved from `.rn-agent/e2e.config.json`, via `GET /api/e2e/actions` + `POST /api/e2e/actions/run`.
- 042280b: feat(e2e): params source — `.rn-agent/e2e.config.json` supplies per-test param values (with shared `defaults` + secret redaction) so parameterized actions can be locked and run as e2e tests. `cdp_lock_e2e_test` now accepts a param-needing action when the config covers all its params (else `MISSING_PARAMS` listing the gaps); `cdp_run_e2e_suite` runs param tests with their resolved values (else skips with a clear reason). Secret param values (names in `secretParams`) are redacted to `***` in failure output and run records, and only an action's declared params are passed to Maestro (unrelated defaults never leak).
- 33db4be: feat(e2e): observe Regression page + CSRF-guarded control endpoint — a top-level Live|Regression toggle with a Run button, live progress, verdict badge, per-test table, and run history, backed by `POST /api/e2e/run` + `GET /api/e2e/runs[/:id]` (host + Sec-Fetch + CSRF + method/content-type guarded; one flow lease).

## 0.46.0

### Minor Changes

- 8f0b7ff: feat(e2e): regression runner engine — `cdp_lock_e2e_test` promotes a verified (param-free) action into a frozen, executable locked e2e test, and `cdp_run_e2e_suite` runs all locked tests strict (no auto-repair) on the booted sim, persisting a suite-run report with verdict, per-test classification (regression vs infra, params skipped), and a newly-failing-since-last-green diff. Engine only; observe page + CSRF HTTP trigger land in a follow-up.

## 0.45.8

### Patch Changes

- 7731024: chore: adopt oxlint + oxfmt as the lint/format layer, format the codebase (code only — prose docs excluded), and add a blocking CI lint-format gate.

## 0.45.7

### Patch Changes

- 8305bbd: `maestro_run` now returns structured per-step results and partial progress on timeout (GH #211).

  The result gains `steps[]` (`{index,name,verb,status,durationMs}`), `failedStep`, `reason` (sanitized `{kind,selector}` — never the raw runner log), `lastStep` (progress marker), `timedOut`, and `outputTruncated`. On timeout the partial steps are returned instead of a bare failure, and the failure headline names the failing/last step. Parsed from maestro-runner stdout (the JVM Maestro CLI fallback degrades fail-open to empty steps); `tapOn` latencies for #263 now derive from the shared parser. Additive — `output` is preserved for `run-action` consumers.

## 0.45.6

### Patch Changes

- 16f0a0d: `maestro_run` now flags a wedged simulator runtime (GH #263).

  When a flow fails AND the median latency of its successful `tapOn` steps exceeds a floor (default 1500ms, `RN_RUNTIME_DEGRADED_FLOOR_MS`), the result gains a `RUNTIME_DEGRADED` hint and `meta.runtimeDegraded` — "the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown/boot), relaunch, and retry." This replaces the misleading "Element not found" that previously sent the agent chasing app code when the real cause was a degraded simulator (taps reported success but `onPress` never fired). Detection is purely additive — it never changes a pass/fail verdict, never fires on a passing run, and only counts successful taps (a failed tap's duration is the step timeout, which would otherwise false-positive an ordinary element-not-found failure). Fail-open: unparseable output → no hint.

## 0.45.5

### Patch Changes

- 6c77108: `/observe` device panels now refresh live (GH #206).

  The observability layer was a passive recorder of tool observations — the screenshot only updated on `device_screenshot` calls and the route only on navigation-family tools, so driving the app with `cdp_interact`/`cdp_navigate` left both panels stale. A fire-and-forget hook now captures a fresh screenshot (simctl/adb, OS-level) + route (CDP nav-state) after each state-mutating tool and delivers them via a dedicated live SSE channel (`{type:'live'}` + `/api/live-screenshot`), so the timeline stays clean. Platform resolves from the active device session or the connected CDP target (so a purely CDP-driven flow with no agent-device session still refreshes). Gated on a connected `/observe` tab, skipped during Maestro flows, single-flight trailing-coalesce, opt-out with `RN_OBSERVE_LIVE=0`.

## 0.45.4

### Patch Changes

- 64531c8: Bump esbuild to 0.28.1 across the build toolchains to clear the HIGH Dependabot advisory (GHSA-gv7w-rqvm-qjhr).

  The advisory is in esbuild's Deno installer (binary-integrity RCE via `NPM_CONFIG_REGISTRY`) — a code path this repo never executes (esbuild is consumed as an npm transitive dep via Vite/Astro, not Deno), so it was never exploitable here. Still, both the observability web UI (`scripts/cdp-bridge/src/observability/web/`) and the docs site carried the vulnerable transitive esbuild, so both now pin it to the patched 0.28.1 via an npm `overrides`. The observability Vite build also sets `build.target: 'esnext'` (it's an internal localhost-only dev tool viewed in a modern browser) to sidestep an esbuild 0.28 regression that refused to downlevel destructuring to Vite's default old-browser baseline; the single-file bundle was rebuilt. `npm audit` is clean in both subtrees.

## 0.45.3

### Patch Changes

- a88d139: `cdp_network_log` no longer returns two entries per request (GH #214).

  Root cause: setup sends `Network.enable` (mode `cdp`), then `probeNetworkDomain` fires a probe fetch and watches the buffer. On RN ≥ 0.83 the CDP Network domain _does_ deliver events, but when they don't flush within the probe window — a false negative documented after platform switches / reloads (GH #59 #9) — the probe returns `none` and setup injects the fetch/XHR hook **without disabling the still-enabled Network domain**. Both paths then capture every request (CDP numeric-id entries + hook UUID-id entries), and the existing exact-id dedup can't collapse them because the two id schemes never collide.

  Fix: when setup falls back to the hook, it now disables the CDP Network domain first, so the hook is the single capture source. This also makes `cdp_status`'s `networkDomain: false` truthful instead of a label over a still-running domain — the "capability flag out of sync" symptom in the report was the same root cause. Read-time fuzzy dedup was deliberately rejected: it would collapse legitimately-identical rapid requests (a real double-mutation) and hide bugs — the opposite of what the reporter needed.

## 0.45.2

### Patch Changes

- 0386204: `cdp_mmkv` delete and boolean reads now work on the Nitro react-native-mmkv line (GH #209).

  - `delete` was calling `mmkv.delete(key)` — a JS-wrapper-class method that doesn't exist on the raw Nitro hybrid object the tool actually talks to (`createHybridObject('MMKVFactory').createMMKV(...)`), whose spec exposes `remove(key)`. The generated expression now prefers `remove()`, falls back to `delete()` for wrapper-shaped objects, and reports a named error (instead of a bare TypeError) when neither exists. This unblocks first-class auth/storage resets for logged-out replays on iOS — previously a raw `cdp_evaluate` escape hatch every time.
  - `get` with `type: 'boolean'` emitted `mmkv.getBool(key)`, which exists on no MMKV surface (hybrid object and wrapper both spell it `getBoolean`) — broken since the tool shipped. Now fixed.
  - The follow-up enhancement from the issue (a `clearKeys:` action-YAML directive for self-contained auth-gated replays) is tracked as GH #286.

## 0.45.1

### Patch Changes

- bd5d585: Recovery paths now detect "app not installed" and resolve their relaunch target truthfully (GH #262, absorbs #194 BUG 2).

  - `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container`'s stderr carries the `NSPOSIXErrorDomain code=2` marker (allowlist-only, stderr-only — argv-spoof-proof), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the newest matching `.app` snapshot from the last clearState (GH #201 dir, mtime-sorted budgeted scan). Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior. Concurrent recoveries are serialized, and a confirmed missing bundle is cached (with a cheap re-probe) so the diagnosis is never masked by `budget-exhausted`.
  - `cdp_restart hardReset=true`: the relaunch target resolves through `explicit arg > connectedTarget > cache > active-session appId > strict per-platform app.json` (no iOS←Android fallback), simctl targets the active session's UDID when one exists, failed launches are classified the same way in `hardResetSteps`, and a successful hard reset resets the detached-recovery budget.

- 81c386a: `device_screenshot` no longer blames "device transitioning state" when the target directory doesn't exist (GH #265).

  - `captureAndResizeScreenshot` now `mkdir -p`'s the parent of the derived output path before any dispatch tier runs (simctl raw, rn-fast-runner, agent-device daemon/CLI, adb stream) — new directories are the expected case, since the tool's own advisories steer agents toward fresh `docs/proof/<slug>/` paths. The fix covers `device_screenshot`, `device_batch` auto-captures, and `proof_step`, all of which funnel through the same helper.
  - When the directory itself cannot be created (e.g. a file blocks an intermediate path segment), the tool short-circuits before probing any device and returns an honest `SCREENSHOT_FAILED` with `reason: 'target-dir-unavailable'` naming the offending path — never the device-state guess.
  - A leading `~/` in the screenshot path is now expanded to the real home directory (Node never expands `~`, so mkdir would otherwise create a literal `./~/` under the bridge cwd and report success into the wrong location). Unexpandable forms (`~user/...`, bare `~`) are refused with an actionable error.

## 0.45.0

### Minor Changes

- eff45cd: #202 Phase 6 / #186 — foreign Maestro sessions become arbiter refusals; plugin maestro_run is the canonical surface.

  While a foreign Maestro/XCUITest session drives the target simulator (UDID-scoped detection, 5 s TTL, fail-open), local `device_*` and flow tools refuse fast with `BUSY_FOREIGN_FLOW` (~50 ms measured) — pointing at the safe L1 reads — instead of colliding into the ~44 s runner-leak cascade. L1 introspection stays free; `device_screenshot` serves pixels via its simctl fallback; a ~10 s teardown grace after the plugin's own flows prevents self-false-positives while WDA dies. The two historical reasons to leave the plugin surface are live-gate-verified closed and #201 is closed — including a new fix: the clearState `--app-file` resolution is snapshotted outside the device container (the installed-container path used to be deleted by clearState itself before the reinstall could read it). `RN_IOS_FOREIGN_GUARD=0` disables both the warning and the refusal (`RN_IOS_FOREIGN_WARN=0` remains a deprecated alias). The foreign-runner `ps` scan now uses `-ww` (command-column truncation could silently drop the UDID → false negatives).

## 0.44.0

### Minor Changes

- c05c058: #202 Phase 5 / #264 — the bridge now survives Metro restarts (supervisor split).

  The MCP entry point is now `dist/supervisor.js`: a thin stdio shim holding zero network sockets (immune to `lsof -ti tcp:8081 | xargs kill -9`, which used to SIGKILL the whole server and cost the session all 77 tools). It spawns the real bridge as a worker, and on worker death: errors in-flight calls with `-32000` ("retry the call"), respawns it (max 3 per rolling 60 s, then a terminal crash-loop error), and replays the cached MCP `initialize` handshake so the session continues seamlessly. Visibility: `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Opt out with `RN_BRIDGE_SUPERVISOR=0` (legacy single process). `SIGUSR2` now performs a real hot-reload (worker restart + handshake replay).

## 0.43.0

### Minor Changes

- abe4411: Expose `params` in the `maestro_run` and `cdp_run_action` MCP tool schemas.

  Both handlers have accepted `params` since GH #116 (forwarded to maestro as `-e KEY=VALUE` on the first attempt AND the post-repair retry), but the zod registrations omitted the field — and zod strips unknown keys by default, so a caller's parameter bindings were **silently dropped** at the tool-call layer and a parameterised action failed at runtime with unset `${VAR}` placeholders. Found by Codex review on PR #272 (the new `creating-actions` skill recommends `cdp_run_action({ actionId, params, trigger })`, which was un-callable as advertised; `commands/run-action.md` documented the same call shape). Key-format validation (`/^[A-Z_][A-Z0-9_]*$/`) stays in the handler. Wiring test pins both registrations.

## 0.42.0

### Minor Changes

- 73c6bf4: #202 Phase 4 — eradicate legacy runner apps, not just processes.

  At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Scanned at every device-open (one `simctl listapps`, ~150–350 ms measured — no memo, so a reinstall by another session is always caught); error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.

## 0.41.0

### Minor Changes

- 58c4886: Debugger-seat coexistence with React Native DevTools + silent hook-mode network capture.

  - New opt-out for background auto-reconnect: `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` `{ "cdp": { "autoConnect": false } }`. In passive mode the bridge yields the single RN debugger seat to the visual DevTools and reconnects only on explicit tool calls. Resolved mode is visible in `cdp_status` → `autoConnect` and `/doctor`.
  - Hook-mode network capture (RN < 0.83 fallback) no longer transports entries via `console.log("__RN_NET__:…")` — entries go to an in-app ring buffer drained on demand, so Metro logs and the user's DevTools console stay clean.

## 0.40.5

### Patch Changes

- 6190178: fix(#253): `cdp_repair_action` no longer hardcodes `targetPlatform='ios'` — Android auto-repair works against an emulator. The repair orchestrator now derives the platform from the active device session via `detectPlatform()` (booted-device probe fallback when no session is open; `'ios'` only as the final no-session, no-device fallback). Previously an Android repair foregrounded the app via `xcrun simctl`, snapshotted through the iOS short-circuit, and bootstrapped the iOS fast-runner — so Android selector drift always escalated as a hard failure instead of self-healing.

## 0.40.4

### Patch Changes

- e5404ed: fix(#249): Maestro pass detection no longer flips passing flows to failed when app logs contain the substring `FAILED`. The exit-0 secondary guard in `maestro_run`, `maestro_test_all`, and the inline maestro fallback used a bare `output.includes('FAILED')` over combined stdout+stderr — app/console output like a `FETCH_FAILED` Redux action or a `LOGIN_FAILED` analytics event marked a genuinely passing flow as failed and triggered pointless auto-repair. All three call sites now share `outputIndicatesFlowFailure`, which keys on Maestro's own terminal status lines (`Test FAILED` / `Flow FAILED` / a `[FAILED]` step marker / a bare `FAILED` line) instead of a substring.
- 070586d: fix(#250): `cdp_interact` no longer reports success when the app's own handler throws. The injected interact dispatch caught handler exceptions (`onPress`/`onChangeText`/`setValue` raising — unmounted component, missing context, thrown validation) and returned `success: true, action_executed: true`, which the tool layer surfaced as a non-error warning — so agents proceeded against a screen that may be in an error state. The helper now reports `success: false` (keeping `action_executed: true` to distinguish "dispatched but handler threw" from "couldn't dispatch"), and the tool layer maps it to a structured error with `meta.actionExecuted`, `meta.handlerError`, and a check-`cdp_error_log` hint. HELPERS_VERSION bumped to 25 so connected sessions re-inject.
- 8269476: fix(#251,#252): startup hardening. The project single-instance lock (`Lockfile.acquire`) now uses the same atomic `openSync('wx')` exclusive-create pattern as `DeviceLock` — the previous read-then-write let two bridges starting in the same instant both "acquire" the lock, with the second silently truncating the first; the loser now gets a structured conflict, stale-holder reclaim narrows the steal window with a re-read before unlink, and fs infra errors fail open (`degraded: true`) instead of crashing the bridge at boot. Separately, SessionStart is now bounded: the hook declares an explicit 120s timeout and the maestro-runner installer's `curl | bash` carries `--connect-timeout 10 --max-time 90`, so a stalled CDN can no longer block session start indefinitely; a CI guard (`session-start-bounded.test.sh`) pins both.

## 0.40.3

### Patch Changes

- 609c825: fix(B191,B192): post-flow lifecycle hardening follow-ups to #243/#244. `isAndroidConnectionFailure` now also classifies `startAndroidRunner`'s startup-failure shapes (`exited before readiness`, `Failed to spawn Android runner instrumentation`) into the structured retryable `RN_ANDROID_RUNNER_DOWN` instead of letting a startup crash escape as a raw exception. And `isBenignSessionGoneError` no longer runs its session-gone regex over unparseable (non-JSON) close payloads — with no error field to scope the match to, they surface unchanged, so a real close failure whose raw text merely mentions "no active session" can't be silently swallowed.

## 0.40.2

### Patch Changes

- c9d447d: fix(#243,#244): Android post-flow lifecycle. `rn-android-runner` readiness is now gated on its own `GET /health` instead of the `adb logcat` ring buffer — a prior runner's stale ready line (same tag + fixed port) used to fire readiness before the new socket bound, so the first `device_*` after a Maestro flow returned a bare `fetch failed`. When the runner genuinely can't come up, `runAndroid` now surfaces a structured `RN_ANDROID_RUNNER_DOWN` with a retry hint. Separately, `device_snapshot action=close` now tolerates an underlying session that a flow already tore down (the #237 slot-release): it cleans up local state and returns ok, so `open → flow → close` round-trips cleanly instead of erroring `SESSION_NOT_FOUND`.

## 0.40.1

### Patch Changes

- 51976e8: fix(#237): Android instrumentation-slot handoff — `runFlowParked` now releases the single Android `UiAutomation` slot before a Maestro flow (`maestro_run`/`maestro_test_all`/`cdp_auto_login`), fixing `UIAutomator2 server not ready after 30s`. It stops the in-tree `rn-android-runner`, `am force-stop`s our two instrumentation packages (the decisive device-side release), and — gated by `RN_DEVICE_KILL_LEGACY` — kills a stale legacy `agent-device` daemon by its specific PID (never `pkill`, guarded against our own process tree so the MCP server is never collateral). Best-effort and idempotent; iOS behavior is unchanged.

## 0.40.0

### Minor Changes

- de6a8d8: fix(#191): JS-first text entry — `device_fill` now prefers the deterministic React `onChangeText` path when CDP is connected and the ref resolves to a testID (via its cached snapshot identifier), settle-polls the field value to verify it (defeating the debounced-`onChangeText` read race), and on the native fallback runs a bounded clear+retype (real `clearFirst` + per-character delay) when the value is corrupted, escalating to a verified maestro fallback before erroring. Adds best-effort iOS predictive-keyboard suppression at session-open and a new `TEXT_ENTRY_UNVERIFIED` error code for the exhausted-and-still-corrupted case. Additive `meta` only (`textEntryPath`, `verify`, `timings_ms`); no breaking change for existing callers. NOTE: `device_batch` fills are not yet JS-first (they call the runner directly) — tracked as a follow-up.

## 0.39.4

### Patch Changes

- 72d17b5: Fix #210: iOS device-session visibility + self-healing. `cdp_status` now reports `deviceSession: { sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', appId?, deviceId?, foreignRunner? }` so the agent can see the XCUITest runner state before calling `device_*` (iOS-gated — Android leaves `rnFastRunner:'dead'` and skips the probe/scan). `device_find/press/fill` now auto-spawn the runner from the dispatch choke point when a session or booted simulator exists and the rig is prebuilt — cold-build-safe: a missing prebuilt rig returns an actionable `RN_FAST_RUNNER_DOWN` error naming `device_snapshot action=open` instead of a silent multi-minute `xcodebuild`. `device_screenshot` now falls back to `xcrun simctl io screenshot` (or `adb`) whenever the runner can't serve it — including while a Maestro flow owns the device — so it never hard-fails on iOS. Also fixes a latent bug where an omitted-platform `device_snapshot action=open` stored `platform: undefined`, skipping the iOS dispatch branch.

  Reframes the issue's "ride Maestro's WDA" suggestion (rejected: WDA is per-flow/ephemeral with no session to ride, and a WDA client would add a second XCUITest backend rather than unify; mid-flow pixels use simctl, mid-flow state uses CDP introspection). (GH #210, B186, D1249)

## 0.39.3

### Patch Changes

- 75a9573: Fix #182: the CDP MCP no longer fails with `-32000: Connection closed` when an orphaned bridge from a dead Claude Code session holds the single-instance lock.

  Root cause: when CC dies abnormally (SIGKILL/crash/window-close on macOS) without closing the child's stdin or signaling it, the bridge becomes a **live orphan** — still running, still holding the project lock. The existing reclaim (PID-dead / mtime>24h / process-name) can't recover a _live_ owner, so the next session hard-failed for up to 24h. Four composing fixes:

  - **Parent-death self-exit (prevent).** A `getppid()` poll (`lifecycle/parent-watch.ts`) captures the bridge's PPID at startup and self-exits (releasing the lock) when it _changes_ — i.e. the original Claude Code host died and the bridge was reparented. This catches the abnormal-death cases stdin-EOF + signal handlers miss. It compares against the startup PPID rather than testing `=== 1` so a bridge whose host runs as PID 1 (a container with no init system) is never falsely killed.
  - **Orphaned-owner reclaim (recover).** `Lockfile.isLockLive` reclaims a _live_ owner whose parent **changed** from the PPID it recorded at acquire (`ps -o ppid=`) — so a new session self-heals past an existing orphan instead of hard-failing. A null PPID lookup fails safe; pre-0.39 locks with no recorded `ppid` fall back to a legacy `PPID===1` reclaim.
  - **Heartbeat (recover wedged).** The lock body carries `lastHeartbeat`, refreshed every ~10s; a live owner whose heartbeat goes stale (>90s) is wedged and reclaimable — mirroring the device-lock's self-healing. Pre-0.39 locks without `lastHeartbeat` fall back to the existing mtime check (back-compat).
  - **Usurp self-terminate (sleep/wake safety).** `Lockfile.touch()` now returns whether we still own the lock. If a contender reclaimed our slot while the laptop slept (heartbeat expired → reclaimed → we wake), the next heartbeat detects the foreign PID and self-terminates instead of running as a second bridge on the same device. This also makes the (pre-existing, non-atomic) reclaim path self-correcting within one tick.

  Together these eliminate the manual `kill <pid> && rm <lock>` workaround. 15 #182 unit tests (incl. container-safety, sleep/wake usurp, and a real `ps -o ppid=` check); unit suite 1744/1744; `tsc` clean. (GH #182, B185, D1246)

## 0.39.2

### Patch Changes

- bc577e9: Fix the CDP connection wedge (GH #208): `cdp_status` no longer dead-locks on "Already connecting to Metro..." and no longer misreports a detached app as "Metro not found". Three root causes were addressed:

  - **RC1 — reconnect-storm wedge.** When the app detaches but Metro stays up, the WS-close reconnect loop holds `isReconnecting()` true for up to ~12 min (30 attempts × 30s cap, then re-armed indefinitely by the background poll). `autoConnect`'s guard threw "Already connecting" for every `cdp_status`/`cdp_*` call in that window. `cdp_status` now **preempts** an active reconnect storm via `softReconnect()` (the existing 3s `softReconnectRequested` handshake) for one fresh attempt instead of refusing, and surfaces the live `reconnectState` (attempt N/30) on any connect failure so it reads as progress, not a dead end.
  - **RC2 — misleading error.** "Metro up but 0 Hermes targets" now throws a typed `AppDetachedError` ("Metro is up … advertises 0 Hermes debug targets — the app isn't attached") instead of being conflated with the genuine "Metro not found" (now reserved for `discoverMetroPort` returning null).
  - **RC3 — no auto-recovery.** New `recoverDetached()` cold-restarts a detached iOS app (`simctl terminate` + `launch`) → reconnects → confirms with a real CDP liveness probe. Bounded to 3 consecutive attempts/session, skips while a Maestro flow holds the arbiter lease, iOS-only, opt-out via `RN_AUTO_RELAUNCH_ON_DETACH=0`. Cold-restart (vs recover-wedge's bare launch) is acceptable because it only fires when the app is ALREADY detached — never against a working app.

  Hardened via a Codex + Gemini multi-review: `cdp_status` now honors an explicit `args.platform` during a storm (tears down + reconnects rather than reusing the storm's target), auto-relaunch is skipped when the caller pinned a non-iOS platform (never cold-restarts an unrelated iOS session), `simctl launch` failures are surfaced instead of hidden behind "still detached", and the post-recovery status read can no longer throw out of the handler.

  19 new unit tests; full suite 1729/1729; `tsc --noEmit` clean. Live false-positive guard verified: the real `discover()` against Metro does not fire `AppDetachedError` while a target is present. Scoping: the literal-0-targets case is fixed; the RN-0.85 "C++ target present, 0 Hermes" flavor remains B156/B184 territory (recover-wedge path). (GH #208, B181, D1245)

## 0.39.1

### Patch Changes

- 6e8af52: Fix a batch of bugs, regressions, and reliability issues surfaced by a multi-agent repo audit.

  **Security**

  - Redaction no longer leaks private-key material. `redactString` now applies secret patterns BEFORE truncating (a >2000-char PEM previously had its `-----END-----` marker severed by truncation so the key body passed through), and the PEM rule now matches multi-word labels like `RSA PRIVATE KEY` / `OPENSSH PRIVATE KEY` (the old single-word pattern never matched the most common headers).

  **Device interaction**

  - `device_scroll` no longer throws on Android (and on the iOS fast-runner fallback): a direction-form scroll is now converted to coordinates before dispatch, matching `device_swipe`.
  - `device_batch` scroll steps no longer crash the whole batch on either platform (same root cause).
  - A coordinate `device_swipe` with `--count`/`--pattern` but no `durationMs` no longer mis-parses the flag value as a 3 ms duration on iOS (the positional extractor now strips flag values, matching Android).
  - The Android runner is no longer reused across emulators: `shouldReuseAndroidRunner` checks the bound `deviceId` (parity with iOS `shouldReuseRunner`), so a runner bound to one emulator can't silently drive another.
  - A wedged-but-alive fast-runner is now reaped: `ensureFastRunner` probes tri-state liveness instead of PID-only, so a hung HTTP listener no longer makes every subsequent command burn the full timeout.
  - `ensureSingleRunner` is now awaited at session-open so the stale-runner kill completes before the first interaction, and its `ps` failure surfaces as a warning instead of a silent no-op.

  **Actions / Maestro**

  - Actions now auto-promote `experimental → active` on the first clean replay (the documented lifecycle was defined + tested but never wired).
  - The GH#186 route-drift guard is now active in production (`cdp_run_action` is wired with a CDP-backed live-route reader; it previously defaulted to a no-op).
  - `maestro_test_all` and the inline Maestro fallback no longer mark passing flows as failed when app/console output merely contains `Error:`, and both now auto-resolve `--app-file` for iOS `clearState` flows (previously only `maestro_run` did). `clearState` detection also recognises the standalone `- clearState` command.
  - All Maestro `execFile` calls raise `maxBuffer` to 10 MB so a large flow log can't kill the child and mask a passing run.
  - `cdp_repair_action` `RUNNER_LEAK` refusals are now bucketed as `SNAPSHOT_FAILED` in MTTR telemetry instead of `INTERNAL_ERROR`.
  - A bare-form `id:` repair now emits a quoted scalar, so a testID containing YAML-special characters can't corrupt the action.

  **Reliability / correctness**

  - `collect_logs` no longer double-shifts Android logcat timestamps by the host UTC offset (which corrupted both the time and the cross-source merge order).
  - CDP freshness/dev probes attach a no-op catch to the raced `evaluate()` promise so a mid-probe WebSocket close can't surface as an unhandledRejection.
  - The observability server keeps a small `headersTimeout` (slow-loris guard), broadcasts a `shutdown` event so the browser stops auto-reconnecting after stop, and `Recorder.clear()` notifies subscribers instead of orphaning live SSE streams.
  - Action IDs now accept dots (`v2.0-login`) per their documented contract while still rejecting `..`.
  - The post-edit health-check hook's "app not installed → skip" guard works again (`grep -c || echo "0"` produced a two-line `0\n0`).
  - `learned-actions` resolves the project memory dir correctly for paths containing a dot, and its `${VAR}` extractor accepts digit-bearing keys.
  - The injected-helpers version is a single source of truth (the post-injection log no longer reports a stale `v11`).
  - `sync-versions.sh` drops a dead, misleading variable and documents that `rn-dev-agent-cdp` is independently versioned.

  Hardened the previously flaky `proof_step` unit tests (they depended on a machine-global session file) with a dependency-injection seam, making the suite deterministic.

## 0.39.0

### Minor Changes

- 5c4ca04: Add the read-only observability UI (D1226 "watch the agent live"): an in-process recorder + opt-in SSE server serving a React SPA (timeline | device | state). New `observe` MCP tool + `/rn-dev-agent:observe` slash command. Deep-redacted (args + payload, fail-closed), localhost-only with Host-header + Sec-Fetch-Site guards.

### Patch Changes

- c4804dc: Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
  Client picker dismissal after Android deep links (#136 sub-3). Routed through a
  single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
  actionable manual-select message instead of touching the legacy agent-device
  path. Cross-platform iOS support tracked as a follow-up.

## 0.38.40

### Patch Changes

- Deliver the GH #186 maestro-interop fixes that merged in #188 without a version bump (closes #189).

  - `cdp_run_action` now allows `runFlow` (including `when:` conditionals and `{file}` sub-flows) through the Maestro command allowlist, so actions with conditional dialog-handling (Expo dev-server picker, iOS "Open in" dialog) replay through the canonical runner instead of hard-failing with `Command not in allowlist: runFlow (Phase 134.1)`.
  - Non-destructive runner-leak `reacquire` recovery tier + cross-tool CDP re-pin, avoiding the ~44s relaunch / ~47s STALE_TARGET when maestro-mcp and rn-dev-agent contend for the same iOS device.
  - Structural route-drift detection: a stale-selector failure on an inserted screen is classified `ROUTE_DRIFT` instead of triggering a wasted fuzzy-repair.

  #188 shipped these to `main` with no version bump, leaving them undeliverable to marketplace installs; this patch publishes them.
