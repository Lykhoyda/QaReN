import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const native = new URL(
  '../../../../qaren-ios-runner/QarenIosRunner/QarenIosRunnerUITests/',
  import.meta.url,
);
const read = (name: string) => readFileSync(new URL(name + '.swift', native), 'utf8');

test('tokenless native pre-read binds the current descriptor, rejects placeholders and journals no value', (t) => {
  if (process.platform !== 'darwin') return t.skip('requires the macOS Swift toolchain');
  const source = read('QarenIosRunnerTests+CommandExecution');
  const start = source.indexOf('    case .verifyInput:');
  const end = source.indexOf('    case .interactionFrame:', start);
  assert.ok(start >= 0 && end > start);
  const branch = source.slice(start + '    case .verifyInput:'.length, end);
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 60_000,
    input: `
import Foundation
${read('TextInputTarget')}
${read('CommandJournal')}
struct Descriptor { let type = "TextField"; let identifier = "name"; let generation = 8 }
struct Command { let text: String?; var operationToken: String? = nil; let snapshotNodeIndex: Int? = 1 }
struct ErrorPayload { let code: String; let message: String }
struct DataPayload: Codable { let verifyVerdict: String; let verifyStable: Bool }
struct Response { let ok: Bool; var data: DataPayload? = nil; var error: ErrorPayload? = nil }
enum ElementType { case textField, secureTextField }
class XCUIElement {
  var exists = true
  var elementType = ElementType.textField
  var raw: String? = "fill-sentinel-882"
  var placeholder: String? = nil
}
let current = XCUIElement()
let activeApp = current
let currentSnapshotGeneration = 8
let attributes = TextInputTarget.CandidateAttributes(type: "TextField", identifier: "name", label: "Name", frame: CGRect(x: 0, y: 0, width: 100, height: 30))
struct Record { let operationToken = "old"; let element: XCUIElement; let attributes: TextInputTarget.CandidateAttributes?; let generation: Int; let nodeIndex: Int? }
var lastExactTypeTarget: Record? = nil
var exactCalls = 0
var recordedCalls = 0
var ambiguous = false
func withTemporaryScrollIdleTimeoutIfSupported(_ app: XCUIElement, operation: () -> Void) { operation() }
func exactInputDescriptor(from command: Command) -> Descriptor? { Descriptor() }
enum Resolution { case bound(XCUIElement), ambiguous, absent }
func resolveRecordedTextInput(app: XCUIElement, recorded: TextInputTarget.CandidateAttributes) -> Resolution {
  recordedCalls += 1
  return .ambiguous
}
func resolveExactTextInput(app: XCUIElement, descriptor: Descriptor, sameGeneration: Bool, requireFrameMatch: Bool) -> Resolution {
  precondition(sameGeneration && requireFrameMatch)
  exactCalls += 1
  let candidates = ambiguous ? [attributes, attributes] : [attributes]
  switch TextInputTarget.resolve(candidates: candidates, descriptorType: descriptor.type, descriptorIdentifier: descriptor.identifier, descriptorLabel: nil, descriptorRect: attributes.frame, sameGeneration: sameGeneration, requireFrameMatch: requireFrameMatch) {
  case .unique: return .bound(current)
  case .ambiguous: return .ambiguous
  case .absent: return .absent
  }
}
func readExactInputValue(_ element: XCUIElement) -> (raw: String?, placeholder: String?) { (element.raw, element.placeholder) }
func verify(_ command: Command) -> Response {
${branch}
}
let sentinel = "fill-sentinel-882"
let journal = CommandJournal()
func probe(_ id: String, _ expected: String) throws -> DataPayload {
  let response = verify(Command(text: sentinel))
  let data = response.data!
  precondition(data.verifyVerdict == expected)
  let body = try JSONEncoder().encode(data)
  journal.record(commandId: id, command: "verifyInput", ok: response.ok, body: body)
  precondition(!String(data: journal.lookup(commandId: id)!.body!, encoding: .utf8)!.contains(sentinel))
  return data
}
// No record, unrelated record, and an ambiguous agreeing record cannot redirect a fresh descriptor.
let first = try probe("absent-record", "exact")
precondition(first.verifyStable)
lastExactTypeTarget = Record(element: XCUIElement(), attributes: .init(type: "TextField", identifier: "other", label: nil, frame: .zero), generation: 8, nodeIndex: 2)
let second = try probe("unrelated-record", "exact")
precondition(second.verifyStable)
precondition(recordedCalls == 0 && exactCalls == 2)
lastExactTypeTarget = Record(element: XCUIElement(), attributes: attributes, generation: 8, nodeIndex: 1)
_ = try probe("ambiguous-record", "ambiguous")
precondition(recordedCalls == 1)
lastExactTypeTarget = nil
current.placeholder = sentinel
_ = try probe("placeholder", "mismatch")
current.placeholder = nil
current.raw = sentinel.uppercased()
_ = try probe("case", "case-normalized")
current.raw = nil
_ = try probe("failed-read", "unreadable")
current.raw = sentinel
ambiguous = true
_ = try probe("ambiguous-target", "ambiguous")
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
