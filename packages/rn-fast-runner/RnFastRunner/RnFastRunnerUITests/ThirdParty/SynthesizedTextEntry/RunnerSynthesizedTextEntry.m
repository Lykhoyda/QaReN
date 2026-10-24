// MIT License. Copyright (c) 2026 Callstack. See the LICENSE file at the root of this runner package.
#import "RunnerSynthesizedTextEntry.h"
#import "RunnerXCTestEventBridge.h"

#import <objc/message.h>

static NSString *const RunnerTextSynthesisSurface = @"text";

typedef id (*RunnerTextMsgSendInit)(id, SEL, NSString *);
typedef id (*RunnerTextMsgSendInitPath)(id, SEL);
typedef void (*RunnerTextMsgSendType)(id, SEL, NSString *, NSTimeInterval, NSUInteger, BOOL);
typedef void (*RunnerTextMsgSendTypeKey)(id, SEL, NSString *, NSUInteger, NSTimeInterval);

typedef struct {
  RunnerXCTestEventBridge core;
  SEL initRecordSelector;
  SEL initPathSelector;
  SEL typeTextSelector;
  SEL typeKeySelector;  // only required in `replace` mode
} RunnerTextEventBridge;

static NSString * _Nullable RunnerResolveTextEventBridge(
  id application,
  BOOL replace,
  RunnerTextEventBridge *bridge
);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryResult(
  RunnerSynthesizedTextEntryStatus status,
  NSString * _Nullable message
);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryUnavailable(NSString *message);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryFailed(NSString *message);
static RunnerSynthesizedTextEntryResult *RunnerSynthesizeTextWithMode(
  id application,
  NSString *text,
  BOOL replace,
  BOOL prepareOnly,
  NSUInteger deleteCount,
  NSString *endKey,
  NSString *deleteKey
);

@interface RunnerSynthesizedTextEntryResult ()

@property(nonatomic, readwrite) RunnerSynthesizedTextEntryStatus status;
@property(nonatomic, readwrite, nullable) NSString *message;

@end


@implementation RunnerSynthesizedTextEntryResult
@end

@implementation RunnerSynthesizedTextEntry

+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text {
  return RunnerSynthesizeTextWithMode(application, text, NO, NO, 0, @"", @"\b");
}

+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text {
  return RunnerSynthesizeTextWithMode(application, text, YES, NO, 0, @"", @"\b");
}

+ (RunnerSynthesizedTextEntryResult *)prepareReplacementWithApplication:(id)application
                                                          deleteCount:(NSUInteger)deleteCount
                                                               endKey:(NSString *)endKey
                                                            deleteKey:(NSString *)deleteKey {
  if (deleteCount > 256) return RunnerTextEntryUnavailable(@"focused clear exceeds the 256-key budget");
  return RunnerSynthesizeTextWithMode(application, @"", YES, YES, deleteCount, endKey, deleteKey);
}

@end

static RunnerSynthesizedTextEntryResult *RunnerSynthesizeTextWithMode(
  id application,
  NSString *text,
  BOOL replace,
  BOOL prepareOnly,
  NSUInteger deleteCount,
  NSString *endKey,
  NSString *deleteKey
) {
  @try {
    RunnerTextEventBridge bridge;
    NSString *missing = RunnerResolveTextEventBridge(application, replace, &bridge);
    if (missing != nil) return RunnerTextEntryUnavailable(missing);

    NSInteger targetProcessID =
      ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.core.processIDSelector);
    if (targetProcessID <= 0) {
      return RunnerTextEntryUnavailable(
        @"private XCTest text synthesis unavailable: could not resolve target process ID"
      );
    }

    if (replace) {
      id selectionRecord = ((RunnerTextMsgSendInit)objc_msgSend)(
        [bridge.core.recordClass alloc], bridge.initRecordSelector, @"rn-dev-agent-fill-select-all"
      );
      id selectionPath =
        ((RunnerTextMsgSendInitPath)objc_msgSend)([bridge.core.pathClass alloc], bridge.initPathSelector);
      if (selectionRecord == nil || selectionPath == nil) {
        return RunnerTextEntryFailed(
          @"private XCTest text synthesis failed: could not create the selection event"
        );
      }
      ((RunnerMsgSendSetInteger)objc_msgSend)(
        selectionRecord, bridge.core.setTargetProcessIDSelector, targetProcessID
      );
      // Each text-input path reliably performs only its first operation.
      NSUInteger commandModifier = 1UL << 4;
      ((RunnerTextMsgSendTypeKey)objc_msgSend)(
        selectionPath, bridge.typeKeySelector,
        deleteCount > 0 ? endKey : @"a", deleteCount > 0 ? 0 : commandModifier, 0.0
      );
      ((RunnerMsgSendAddPath)objc_msgSend)(selectionRecord, bridge.core.addPathSelector, selectionPath);
      NSError *selectionError = nil;
      BOOL selected = ((RunnerMsgSendSynthesize)objc_msgSend)(
        selectionRecord, bridge.core.synthesizeSelector, &selectionError
      );
      if (!selected) {
        NSString *detail = selectionError.localizedDescription ?: @"synthesizeWithError returned false";
        return RunnerTextEntryFailed(
          [NSString stringWithFormat:@"private XCTest text selection failed: %@", detail]
        );
      }
      id deleteRecord = ((RunnerTextMsgSendInit)objc_msgSend)(
        [bridge.core.recordClass alloc], bridge.initRecordSelector, @"qaren-fill-delete"
      );
      id deletePath =
        ((RunnerTextMsgSendInitPath)objc_msgSend)([bridge.core.pathClass alloc], bridge.initPathSelector);
      if (deleteRecord == nil || deletePath == nil) {
        return RunnerTextEntryFailed(@"private XCTest text synthesis failed: could not create the delete event");
      }
      ((RunnerMsgSendSetInteger)objc_msgSend)(deleteRecord, bridge.core.setTargetProcessIDSelector, targetProcessID);
      if (deleteCount > 0) {
        NSString *deletes = [@"" stringByPaddingToLength:deleteCount withString:deleteKey startingAtIndex:0];
        ((RunnerTextMsgSendType)objc_msgSend)(deletePath, bridge.typeTextSelector, deletes, 0.0, 1000, YES);
      } else {
        ((RunnerTextMsgSendTypeKey)objc_msgSend)(deletePath, bridge.typeKeySelector, deleteKey, 0, 0.0);
      }
      ((RunnerMsgSendAddPath)objc_msgSend)(deleteRecord, bridge.core.addPathSelector, deletePath);
      NSError *deleteError = nil;
      if (!((RunnerMsgSendSynthesize)objc_msgSend)(deleteRecord, bridge.core.synthesizeSelector, &deleteError)) {
        return RunnerTextEntryFailed(@"private XCTest text deletion failed");
      }
      if (prepareOnly) return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusSucceeded, nil);
    }

    id record = ((RunnerTextMsgSendInit)objc_msgSend)(
      [bridge.core.recordClass alloc],
      bridge.initRecordSelector,
      replace ? @"rn-dev-agent-fill-text" : @"rn-dev-agent-type"
    );
    id path = ((RunnerTextMsgSendInitPath)objc_msgSend)([bridge.core.pathClass alloc], bridge.initPathSelector);
    if (record == nil || path == nil) {
      return RunnerTextEntryFailed(
        @"private XCTest text synthesis failed: could not create the text event"
      );
    }
    ((RunnerMsgSendSetInteger)objc_msgSend)(record, bridge.core.setTargetProcessIDSelector, targetProcessID);
    ((RunnerTextMsgSendType)objc_msgSend)(path, bridge.typeTextSelector, text, 0.0, 60, YES);
    ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.core.addPathSelector, path);

    NSError *error = nil;
    BOOL ok = ((RunnerMsgSendSynthesize)objc_msgSend)(record, bridge.core.synthesizeSelector, &error);
    if (!ok) {
      NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
      return RunnerTextEntryFailed(
        [NSString stringWithFormat:@"private XCTest text synthesis failed: %@", detail]
      );
    }
    return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusSucceeded, nil);
  } @catch (NSException *exception) {
    return RunnerTextEntryFailed(
      RunnerFormatXCTestException(exception, @"private XCTest text synthesis failed")
    );
  }
}

static NSString * _Nullable RunnerResolveTextEventBridge(
  id application,
  BOOL replace,
  RunnerTextEventBridge *bridge
) {
  RunnerXCTestEventBridge core;
  NSString *missing = RunnerResolveXCTestEventBridge(application, RunnerTextSynthesisSurface, &core);
  if (missing != nil) return missing;

  SEL initRecordSelector = NSSelectorFromString(@"initWithName:");
  SEL initPathSelector = NSSelectorFromString(@"initForTextInput");
  SEL typeTextSelector = NSSelectorFromString(@"typeText:atOffset:typingSpeed:shouldRedact:");
  SEL typeKeySelector = NSSelectorFromString(@"typeKey:modifiers:atOffset:");

  missing = RunnerRequireSelector(
    core.recordClass, initRecordSelector, @"initWithName:", RunnerTextSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    core.pathClass, initPathSelector, @"initForTextInput", RunnerTextSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    core.pathClass,
    typeTextSelector,
    @"typeText:atOffset:typingSpeed:shouldRedact:",
    RunnerTextSynthesisSurface
  );
  if (missing != nil) return missing;
  if (replace) {
    missing = RunnerRequireSelector(
      core.pathClass, typeKeySelector, @"typeKey:modifiers:atOffset:", RunnerTextSynthesisSurface
    );
    if (missing != nil) return missing;
  }

  *bridge = (RunnerTextEventBridge){
    .core = core,
    .initRecordSelector = initRecordSelector,
    .initPathSelector = initPathSelector,
    .typeTextSelector = typeTextSelector,
    .typeKeySelector = typeKeySelector,
  };
  return nil;
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryResult(
  RunnerSynthesizedTextEntryStatus status,
  NSString * _Nullable message
) {
  RunnerSynthesizedTextEntryResult *result = [RunnerSynthesizedTextEntryResult new];
  result.status = status;
  result.message = message;
  return result;
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryUnavailable(NSString *message) {
  return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusUnavailable, message);
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryFailed(NSString *message) {
  return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusFailed, message);
}
