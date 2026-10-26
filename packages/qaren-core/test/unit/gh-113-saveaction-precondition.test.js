// GH #113: saveAction's implicit "caller already gated actionWasEditedExternally"
// precondition is now a runtime soft-assertion. A caller that forgets to
// gate gets a clear SaveActionPreconditionError instead of silently
// clobbering a human edit.
//
// Both existing callers (cdp_repair_action, cdp_record_test_save_as_action)
// gate correctly, so the new guard fires only for new callers that
// miss the contract — exactly the threat model the issue describes
// (e.g. the planned #104 auto-repair-on-failure wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STORE_PATH = '../../dist/domain/action-store.js';
const _ACTION_PATH = '../../dist/domain/reusable-action.js';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'gh113-'));
  mkdirSync(join(root, '.qaren', 'actions'), { recursive: true });
  return root;
}

function writeAction(root, id, body, metadata = {}) {
  const filePath = join(root, '.qaren', 'actions', `${id}.yaml`);
  const meta = {
    id,
    intent: metadata.intent ?? `intent ${id}`,
    tags: metadata.tags ?? [],
    mutates: metadata.mutates ?? false,
    status: metadata.status ?? 'experimental',
    appId: metadata.appId ?? 'com.test.app',
    ...metadata,
  };
  // Build the YAML the way serializeM7Header does (caller doesn't need it
  // to be perfect for tests — loadAction parses it back).
  const yaml = [
    `appId: ${meta.appId}`,
    '---',
    `# id: ${meta.id}`,
    `# intent: ${meta.intent}`,
    `# status: ${meta.status}`,
    ...body,
  ].join('\n');
  writeFileSync(filePath, yaml);
  return filePath;
}

test('saveAction: succeeds when no external edit between load and save', async () => {
  const { loadAction, saveAction, withBody } = await import(STORE_PATH);
  const root = makeProject();
  writeAction(root, 'happy-path', ['- launchApp']);
  const action = loadAction(root, 'happy-path');
  assert.ok(action, 'action should load');
  const modified = withBody(action, '- launchApp\n- tapOn:\n    id: "btn"');
  const result = saveAction(modified);
  assert.ok(result.filePath.endsWith('happy-path.yaml'));
});

test('saveAction: throws SaveActionPreconditionError when YAML was edited externally', async () => {
  const { loadAction, saveAction, withBody, SaveActionPreconditionError } = await import(
    STORE_PATH
  );
  const root = makeProject();
  const filePath = writeAction(root, 'edited-mid-flight', ['- launchApp']);
  const action = loadAction(root, 'edited-mid-flight');
  assert.ok(action);

  // Simulate an external write: bump the file's mtime forward AFTER the
  // load (which already snapshotted the mtime into state.lastSeenMtimeMs).
  const future = (Date.now() + 10_000) / 1000;
  utimesSync(filePath, future, future);

  const modified = withBody(action, '- launchApp\n- tapOn: { id: "btn" }');
  assert.throws(
    () => saveAction(modified),
    (e) => e instanceof SaveActionPreconditionError && /edited externally/.test(e.message),
    'must throw a SaveActionPreconditionError',
  );

  // The error should reference the file path so a developer can identify
  // which action triggered the guard.
  try {
    saveAction(modified);
  } catch (e) {
    assert.match(e.message, /edited-mid-flight\.yaml/);
    assert.match(e.message, /GH #113/);
    assert.match(e.message, /actionWasEditedExternally/);
  }
});

test('saveAction: first write (file does not exist yet) bypasses the guard', async () => {
  // The guard only fires when the file already exists and has been
  // edited externally. A brand-new action (first save) has no prior
  // state to protect.
  const { saveAction } = await import(STORE_PATH);
  const root = makeProject();
  const targetPath = join(root, '.qaren', 'actions', 'never-existed.yaml');
  // Hand-craft a ReusableAction-shaped object (we can't use loadAction
  // because the file doesn't exist).
  const action = {
    filePath: targetPath,
    metadata: {
      id: 'never-existed',
      intent: 'first-write smoke',
      tags: [],
      mutates: false,
      status: 'experimental',
      appId: 'com.test.app',
    },
    body: '- launchApp',
    state: {
      schemaVersion: 1,
      revision: 0,
      updatedAt: new Date().toISOString(),
      lastSeenMtimeMs: 0,
      runHistory: [],
      repairHistory: [],
      stats: {},
    },
  };
  const result = saveAction(action);
  assert.ok(result.filePath.endsWith('never-existed.yaml'));
  // Verify the file actually landed
  assert.ok(readFileSync(result.filePath, 'utf-8').includes('id: never-existed'));
});
