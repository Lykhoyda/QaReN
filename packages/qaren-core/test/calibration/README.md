# Developer-only temporal calibration

This is an ordinary-plan driver and an offline analyzer, not another runtime or device owner. It has not been run against a device or live model. A functional `check` PASS is necessary but insufficient for calibration; missing or partial measurements prevent a calibration PASS.

```text
freeze source + app + binaries + plan + schedule
  -> one ordinary qaren check --fresh-install
     -> existing CLI admission / lease / bootstrap / child / cleanup
        -> receipt + ledger + bounded core.log metrics
           -> separate offline calibration verdict
```

## Frozen schedule

`plan.md` schedules five consecutive semantic acquisitions each on onboarding, Home and Tasks. `schedule.ts` binds the plan's actual line numbers to these cohorts and six use cycles: onboarding Skip, onboarding Done, check → actual screenshot → cached Tasks press, Home press, fixed scroll, and exact-ID notes fill with literal readback. Scroll and exact-ID fill intentionally remain model-free; the other four mutation cycles and all fifteen semantic waits exercise Jev. No verb, acceptance fixture, or policy is overridden.

The campaign is separate from unchanged phrase, simultaneous-two-Save and typing/privacy acceptance. It does not prove the controlled-input matrix, historical echo protection or unknown-input refusal. The real application source and navigation assumptions still need device confirmation; failures and missing later cases stay failed/incomplete, not removed from the schedule.

## Invocation, only after operational authorization

Build core and the existing debug CLI separately, and prepare the native local products using the existing owned workflow. Freezing requires those artifacts already to exist; it never builds or invokes a device/model. The fixed native directory is `packages/rn-fast-runner/build/DerivedData/Build/Products`. No generated manifest with invented hashes is checked in.

```sh
node packages/qaren-core/test/calibration/run.ts freeze /absolute/app/root /absolute/new-campaign-directory
# This next command makes live model calls and fresh-installs the selected app.
node packages/qaren-core/test/calibration/run.ts run /absolute/new-campaign-directory
node packages/qaren-core/test/calibration/run.ts analyze /absolute/new-campaign-directory
```

The output directory must be new and outside the repository and app. A private `manifest.json` freezes the full schedule, plan hash, fixed device/app, margins, CLI argv, tracked and untracked nonignored source bytes, app config, core runtime, CLI binary and native products. It fingerprints the actual binaries; it does not claim a reproducible-build attestation or hash every ignored external dependency. Local dependencies/toolchain must be held constant by the operator. Symlink entries in a tree are hashed as links, not recursively followed.

`run` refuses source/binary drift, existing `QAREN_*` overrides and a second attempt in the same directory. It inherits credentials without recording them, sets only the existing `RN_RUNNER_BUILD=local` selection, and relies on the CLI's default neighboring core runtime. The existing CLI alone owns the device and all cleanup. No external timeout, alternate lease, fallback bootstrap, wrapper runtime, or automatic campaign retry is added. Pre/post snapshots and all CLI results are retained; a changed build or interrupted run cannot pass analysis. A separate operator run is a separate frozen campaign, never a replacement receipt.

## Metrics and analyzer

Production emits `qaren-core: metric` records with monotonic run-relative timestamps and allowlisted categorical and numeric fields; see the [runtime-input diagnostics contract](../../../qaren-cli/README.md#runtime-inputs) for retained readiness classifications. Capture observers carry numeric observation and plan-line identities explicitly; no global current-operation slot, raw evidence mutation, screen contents, target names, prompts, refs or input values are introduced. Jev spans correlate by their position inside the synchronous walker's decision spans. These records do not change the wire, ledger schema, timeouts or verdict rules. Sink failures are swallowed; missing records then fail offline analysis. The per-child ceiling is 20,000 records plus one overflow marker.

Capture totals include adapter work, React semantic acquisition, joining/native privacy admission and privacy history. Native producer intervals and their five existing phase timings are copied as numeric diagnostics, including returned partial captures; they are not treated as host timestamps or used to fabricate transport time. A thrown adapter failure may have no producer interval. The existing V2 validator supplies the budget-agreement event. An authorization event records the existing guard's authorization, not proof that bytes reached the device; the final guard remains after instrumentation, and interrupted mutations fail. Post-action readback, withheld screenshots, refresh, re-ask, expiry and replay are explicit.

The analyzer requires the complete scheduled ledger, intact sequential metric spans, admitted acquisition cohorts, successful decisions, cached screenshot ordering/file evidence, every guarded send, and readback. It separately checks the existing durable fresh-install and cleanup receipt contract. It requires maxima of native producer acquisition ≤18 seconds, complete acquisition ≤20 seconds, post-acquisition use ≤8 seconds, and oldest evidence <32 seconds. It reports missing stages, failures, refresh/replay/re-ask counts and measured maxima. Refresh, expiry, replay, failed/unknown measurements, truncation and stopped/missing cases fail the baseline. Independent current process/lease cleanup verification remains an operational acceptance step; this analyzer does not probe running processes or devices.

## Native adapter measurements

- The capture-scoped observer and run-relative clock travel through `handlers/device-session.ts` → `agent-device-wrapper.ts:runNative` → `runners/rn-fast-runner-client.ts:runIOS/sendCommandOnce` as host-only `qaTiming`. Neither callback is serialized into a native command.
- `native-readiness` spans measure the existing QA health probe (`count: 1`) and, only on platform-presence captures, the existing V2-specific probe (`count: 2`). Ordinary snapshots perform and require just the first probe. No extra probe is introduced for metrics; producer initial/final eligibility phases are separate measurements.
- `native-transport` measures the command fetch through response headers; `native-decode` measures the existing `response.json()` body consumption and decoding. Both carry the capture's line/observation identity. Transport instrumentation runs before the unchanged final send authorization, never between authorization and fetch. Failed sends and decoding attempts close with fixed failure codes. Existing status/retry transport paths carry the same observer.
- `native-read-only-v1` records each successful probe's exact `QA_READ_ONLY_V1` capability only with a bound session/instance/claim and target identity validated by the existing health admission. Neither a cached capability nor `qaReadOnly: true` is an attestation. Unbound identity or a capability disappearing on the second probe yields no positive attestation for that probe and cannot pass analysis.

All required adapter fields are now wired and covered hermetically, including the one-probe ordinary path. Exact network-only, queue and native serialization timings are not separately available; do not label a residual as network time. No driver-generated stage values or bypass flags exist. Live V2/read-only attestation, full calibration, phrase/two-Save/typing acceptance and independent cleanup remain open.

## Hermetic checks

```sh
corepack yarn build:core
node --test packages/qaren-core/test/unit/qa/calibration-*.test.ts packages/qaren-core/test/unit/runners/calibration-adapters.test.ts
```

The pipeline regression walks the fixed plan using real capture, Jev and native adapters against in-memory transport responses, then parses the production logger's emitted records and exercises the offline analyzer CLI with temporary receipt files. It also removes/truncates actual records to prove fail-closed behavior. Synthetic analyzer fixtures and temporary test receipts are not live campaign evidence.
