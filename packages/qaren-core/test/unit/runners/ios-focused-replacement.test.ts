import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const native = fileURLToPath(
  new URL(
    '../../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/SynthesizedTextEntry/',
    import.meta.url,
  ),
);

test('focused replacement clears before string synthesis without reading field values', (t) => {
  if (process.platform !== 'darwin') return t.skip('requires the macOS Objective-C runtime');
  const dir = mkdtempSync(join(tmpdir(), 'qaren-focused-replacement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const harness = join(dir, 'main.m');
  writeFileSync(
    harness,
    `
#import <Foundation/Foundation.h>
#import "RunnerSynthesizedTextEntry.h"

static NSString *contents;
static BOOL selected;
static NSUInteger records;
static NSUInteger failRecord;
static NSUInteger valueReads;
static BOOL redacted;
static BOOL ignoreSelection;

@interface InputApplication : NSObject
@end
@implementation InputApplication
- (NSInteger)processID { return 123; }
- (id)value { valueReads++; @throw [NSException exceptionWithName:@"PrivateValueRead" reason:nil userInfo:nil]; }
@end

@interface XCPointerEventPath : NSObject
@property(nonatomic, copy) NSString *key;
@property(nonatomic, copy) NSString *text;
@property(nonatomic) NSUInteger modifiers;
- (id)initForTextInput;
- (void)typeKey:(NSString *)key modifiers:(NSUInteger)modifiers atOffset:(NSTimeInterval)offset;
- (void)typeText:(NSString *)text atOffset:(NSTimeInterval)offset typingSpeed:(NSUInteger)speed shouldRedact:(BOOL)shouldRedact;
@end
@implementation XCPointerEventPath
- (id)initForTextInput { return [super init]; }
- (void)typeKey:(NSString *)key modifiers:(NSUInteger)modifiers atOffset:(NSTimeInterval)offset {
  self.key = key; self.modifiers = modifiers;
}
- (void)typeText:(NSString *)text atOffset:(NSTimeInterval)offset typingSpeed:(NSUInteger)speed shouldRedact:(BOOL)shouldRedact {
  self.text = text; redacted = redacted && shouldRedact;
}
@end

@interface XCSynthesizedEventRecord : NSObject
@property(nonatomic) NSInteger targetProcessID;
@property(nonatomic, strong) XCPointerEventPath *path;
- (id)initWithName:(NSString *)name;
- (void)addPointerEventPath:(XCPointerEventPath *)path;
- (BOOL)synthesizeWithError:(NSError **)error;
@end
@implementation XCSynthesizedEventRecord
- (id)initWithName:(NSString *)name { return [super init]; }
- (void)addPointerEventPath:(XCPointerEventPath *)path { self.path = path; }
- (BOOL)synthesizeWithError:(NSError **)error {
  records++;
  if (records == failRecord) return NO;
  if ([self.path.key isEqualToString:@"a"] && self.path.modifiers == (1UL << 4)) selected = !ignoreSelection;
  else if ([self.path.key isEqualToString:@"end"]) selected = NO;
  else if ([self.path.key isEqualToString:@"\\b"] || [self.path.key isEqualToString:@"XCUIKeyboardKeyDelete"]) {
    if (selected) contents = @"";
    else if (contents.length) contents = [contents substringToIndex:contents.length - 1];
    selected = NO;
  } else if (self.path.text != nil) {
    // Model the reported insertion-only string delivery after a selection event.
    selected = NO;
    if ([self.path.text stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\\b"]].length == 0) {
      NSUInteger count = MIN(contents.length, self.path.text.length);
      contents = [contents substringToIndex:contents.length - count];
    } else contents = [contents stringByAppendingString:self.path.text];
  }
  return YES;
}
@end

int main(void) {
  @autoreleasepool {
    InputApplication *app = [InputApplication new];
    NSMutableArray *rows = [NSMutableArray new];
    for (NSString *before in @[@"prior", @"", @"replacement", @"private-prefill"]) {
      contents = before; selected = NO; records = 0; failRecord = 0; valueReads = 0; redacted = YES;
      RunnerSynthesizedTextEntryResult *result = [RunnerSynthesizedTextEntry replaceTextWithApplication:app text:@"replacement"];
      [rows addObject:@{@"exact": @([contents isEqualToString:@"replacement"]), @"status": @(result.status), @"valueReads": @(valueReads), @"redacted": @(redacted), @"records": @(records)}];
    }
    contents = @"prior"; selected = NO; records = 0; failRecord = 0;
    RunnerSynthesizedTextEntryResult *insert = [RunnerSynthesizedTextEntry synthesizeTextWithApplication:app text:@"replacement"];
    [rows addObject:@{@"inserted": @([contents isEqualToString:@"priorreplacement"]), @"status": @(insert.status), @"records": @(records)}];
    ignoreSelection = YES; contents = @"prior"; records = 0;
    [RunnerSynthesizedTextEntry replaceTextWithApplication:app text:@"replacement"];
    BOOL retainedPrefix = ![contents isEqualToString:@"replacement"];
    [RunnerSynthesizedTextEntry prepareReplacementWithApplication:app deleteCount:contents.length endKey:@"end" deleteKey:@"\\b"];
    [RunnerSynthesizedTextEntry synthesizeTextWithApplication:app text:@"replacement"];
    [rows addObject:@{@"neededFallback": @(retainedPrefix), @"exact": @([contents isEqualToString:@"replacement"]), @"valueReads": @(valueReads), @"redacted": @(redacted)}];
    contents = @"private-prefill"; records = 0;
    [RunnerSynthesizedTextEntry prepareReplacementWithApplication:app deleteCount:256 endKey:@"end" deleteKey:@"\\b"];
    [RunnerSynthesizedTextEntry synthesizeTextWithApplication:app text:@"replacement"];
    [rows addObject:@{@"exact": @([contents isEqualToString:@"replacement"]), @"valueReads": @(valueReads), @"redacted": @(redacted)}];
    records = 0;
    RunnerSynthesizedTextEntryResult *oversized = [RunnerSynthesizedTextEntry prepareReplacementWithApplication:app deleteCount:257 endKey:@"end" deleteKey:@"\\b"];
    [rows addObject:@{@"refused": @((BOOL)(oversized.status != RunnerSynthesizedTextEntryStatusSucceeded)), @"records": @(records)}];
    NSData *json = [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
    puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  }
}
`,
  );
  const binary = join(dir, 'replacement-test');
  const build = spawnSync(
    'clang',
    [
      '-fobjc-arc',
      '-framework',
      'Foundation',
      '-I',
      native,
      harness,
      join(native, 'RunnerSynthesizedTextEntry.m'),
      join(native, 'RunnerXCTestEventBridge.m'),
      '-o',
      binary,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(build.status, 0, build.stderr || String(build.error));
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  const rows = JSON.parse(run.stdout);
  for (const [index, name] of ['prefilled', 'empty', 'already-equal', 'private'].entries()) {
    assert.equal(
      rows[index].exact,
      true,
      `${name} field retained contents before string insertion`,
    );
    assert.equal(rows[index].status, 0);
    assert.equal(rows[index].valueReads, 0);
    assert.equal(rows[index].redacted, true);
  }
  assert.equal(rows[4].inserted, true);
  assert.equal(rows[4].records, 1);
  assert.equal(rows[5].neededFallback, true);
  for (const row of rows.slice(5, 7)) {
    assert.equal(row.exact, true);
    assert.equal(row.valueReads, 0);
    assert.equal(row.redacted, true);
  }
  assert.equal(rows[7].refused, true);
  assert.equal(rows[7].records, 0);
});
