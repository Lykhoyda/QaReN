// MIT License. Copyright (c) 2026 Callstack. See the LICENSE file at the root of this runner package.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, RunnerSynthesizedTextEntryStatus) {
  RunnerSynthesizedTextEntryStatusSucceeded,
  RunnerSynthesizedTextEntryStatusUnavailable,
  RunnerSynthesizedTextEntryStatusFailed,
};

@interface RunnerSynthesizedTextEntryResult : NSObject

@property(nonatomic, readonly) RunnerSynthesizedTextEntryStatus status;
@property(nonatomic, readonly, nullable) NSString *message;

@end

@interface RunnerSynthesizedTextEntry : NSObject

// Types into the first responder without serializing the accessibility tree.
+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text;

// Sends ordered Command-A, Delete, and text records.
+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text;

+ (RunnerSynthesizedTextEntryResult *)prepareReplacementWithApplication:(id)application
                                                          deleteCount:(NSUInteger)deleteCount
                                                               endKey:(NSString *)endKey
                                                            deleteKey:(NSString *)deleteKey;

@end

NS_ASSUME_NONNULL_END
