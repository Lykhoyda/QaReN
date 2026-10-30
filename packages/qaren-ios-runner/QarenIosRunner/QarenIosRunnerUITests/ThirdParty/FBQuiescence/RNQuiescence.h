/**
 * RNQuiescence — XCTest quiescence bypass for qaren-ios-runner (GH #384, Story 03).
 *
 * Adapted from mobile-dev-inc/maestro (Apache-2.0):
 *   maestro-ios-xctest-runner/maestro-driver-iosUITests/Categories/
 *   XCUIApplicationProcess+FBQuiescence.m
 * which derives from facebookarchive/WebDriverAgent (BSD-3-Clause).
 *
 * Changes from upstream (see IMPORT_NOTES.md):
 * - bypass is a process-wide env decision (RN_QUIESCENCE_BYPASS, default ON)
 *   instead of FBConfiguration.waitForIdleTimeout + a per-app associated object
 * - the non-bypass path calls the original implementation unmodified
 *   (no _XCTSetApplicationStateTimeout bounding — keeps stock behavior intact)
 * - FBLogger dropped; startup markers are logged by the Swift runner instead
 */

#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, RNQuiescenceProbe) {
  RNQuiescenceProbeClassic = 0,
  RNQuiescenceProbePreEvent = 1,
  RNQuiescenceProbeUnavailable = 2,
};

NS_ASSUME_NONNULL_BEGIN

/// Pure decision: which selector variant to swizzle. Classic wins when both
/// resolve (Maestro's probe order). Exposed for unit tests.
RNQuiescenceProbe RNQuiescenceDecideProbe(BOOL hasClassic, BOOL hasPreEvent);

/// Probe outcome recorded by +load. Unavailable until +load has run.
RNQuiescenceProbe RNQuiescenceGetProbeResult(void);

/// Pure parse of an RN_QUIESCENCE_BYPASS value: nil → YES (default ON);
/// "0"/"false" (trimmed, case-insensitive) → NO; anything else → YES.
/// Exposed for unit tests.
BOOL RNQuiescenceParseBypass(NSString *_Nullable raw);

/// Cached process-wide decision read once from the environment.
BOOL RNQuiescenceBypassEnabled(void);

NS_ASSUME_NONNULL_END
