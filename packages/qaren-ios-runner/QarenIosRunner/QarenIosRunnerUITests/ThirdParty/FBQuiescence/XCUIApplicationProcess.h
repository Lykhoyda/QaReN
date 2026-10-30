/**
 * Minimal private-API declaration for XCTest's XCUIApplicationProcess,
 * trimmed to the members the RNQuiescence swizzle touches.
 *
 * Provenance: class-dump header vendored by facebookarchive/WebDriverAgent
 * (BSD-3-Clause) and mobile-dev-inc/maestro (Apache-2.0) at
 * maestro-ios-xctest-runner/maestro-driver-iosUITests/PrivateHeaders/XCTest/
 * XCUIApplicationProcess.h. See packages/qaren-ios-runner/IMPORT_NOTES.md.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface XCUIApplicationProcess : NSObject

// Before Xcode 16 beta 5
- (void)waitForQuiescenceIncludingAnimationsIdle:(BOOL)includingAnimations;
// Since Xcode 16 beta 5
- (void)waitForQuiescenceIncludingAnimationsIdle:(BOOL)includingAnimations isPreEvent:(BOOL)isPreEvent;

@end

NS_ASSUME_NONNULL_END
