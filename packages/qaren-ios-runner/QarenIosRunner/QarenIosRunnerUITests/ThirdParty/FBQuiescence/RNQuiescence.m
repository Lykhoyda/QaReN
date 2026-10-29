#import "RNQuiescence.h"
#import "XCUIApplicationProcess.h"

#import <objc/runtime.h>

RNQuiescenceProbe RNQuiescenceDecideProbe(BOOL hasClassic, BOOL hasPreEvent)
{
  if (hasClassic) {
    return RNQuiescenceProbeClassic;
  }
  if (hasPreEvent) {
    return RNQuiescenceProbePreEvent;
  }
  return RNQuiescenceProbeUnavailable;
}

static RNQuiescenceProbe gProbeResult = RNQuiescenceProbeUnavailable;

RNQuiescenceProbe RNQuiescenceGetProbeResult(void)
{
  return gProbeResult;
}

BOOL RNQuiescenceParseBypass(NSString *_Nullable raw)
{
  if (raw == nil) {
    return YES;
  }
  NSString *v = [[raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
  return !([v isEqualToString:@"0"] || [v isEqualToString:@"false"]);
}

BOOL RNQuiescenceBypassEnabled(void)
{
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    enabled = RNQuiescenceParseBypass(NSProcessInfo.processInfo.environment[@"RN_QUIESCENCE_BYPASS"]);
  });
  return enabled;
}

static void (*original_waitClassic)(id, SEL, BOOL);
static void (*original_waitPreEvent)(id, SEL, BOOL, BOOL);

static void rnq_swizzledWaitClassic(id self, SEL _cmd, BOOL includingAnimations)
{
  if (RNQuiescenceBypassEnabled()) {
    return; // make XCTest believe the app is idling
  }
  original_waitClassic(self, _cmd, includingAnimations);
}

static void rnq_swizzledWaitPreEvent(id self, SEL _cmd, BOOL includingAnimations, BOOL isPreEvent)
{
  if (RNQuiescenceBypassEnabled()) {
    return; // make XCTest believe the app is idling
  }
  original_waitPreEvent(self, _cmd, includingAnimations, isPreEvent);
}

@interface XCUIApplicationProcess (RNQuiescence)
@end

@implementation XCUIApplicationProcess (RNQuiescence)

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wobjc-load-method"
#pragma clang diagnostic ignored "-Wcast-function-type-strict"

+ (void)load
{
  // Test-only fault injection for the UNAVAILABLE degrade path (Task 9 Step 3).
  NSString *force = NSProcessInfo.processInfo.environment[@"RN_QUIESCENCE_FORCE_UNAVAILABLE"];
  if (force != nil && [force isEqualToString:@"1"]) {
    gProbeResult = RNQuiescenceProbeUnavailable;
    return;
  }
  Method classic = class_getInstanceMethod(self.class, @selector(waitForQuiescenceIncludingAnimationsIdle:));
  Method preEvent = class_getInstanceMethod(self.class, @selector(waitForQuiescenceIncludingAnimationsIdle:isPreEvent:));
  gProbeResult = RNQuiescenceDecideProbe(classic != NULL, preEvent != NULL);
  switch (gProbeResult) {
    case RNQuiescenceProbeClassic:
      original_waitClassic = (void (*)(id, SEL, BOOL))method_setImplementation(classic, (IMP)rnq_swizzledWaitClassic);
      break;
    case RNQuiescenceProbePreEvent:
      original_waitPreEvent = (void (*)(id, SEL, BOOL, BOOL))method_setImplementation(preEvent, (IMP)rnq_swizzledWaitPreEvent);
      break;
    case RNQuiescenceProbeUnavailable:
      break; // Swift logs RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE at startup (Task 2)
  }
}

#pragma clang diagnostic pop

@end
