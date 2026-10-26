// GH #186 P1: runFlow allowlist via inline-at-validation. runFlow was excluded
// from ALLOWED_COMMANDS, so cdp_run_action hard-failed any saved action using it
// (commonly for conditional dialog handling). We allow it, recursively validate
// its inline commands, and securely resolve + EXPAND {file} refs inline (so the
// serialized flow written to /tmp has no remaining file references), with
// path-traversal / containment / cycle / depth guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAndValidateFlow,
  MaestroValidationError,
} from '../../dist/domain/maestro-validator.js';

const FLOW_ROOT = '/proj/.qaren/actions';
const FLOW_DIR = FLOW_ROOT;

// In-memory sub-flow files for the {file} tests.
function makeFs(files) {
  return {
    readFileFn: (p) => {
      if (!(p in files)) throw new Error('ENOENT ' + p);
      return files[p];
    },
    // identity realpath unless the path is mapped to an "escaped" location
    realpathFn: (p) => (files.__realpath && files.__realpath[p]) || p,
  };
}

// ── inline runFlow ──────────────────────────────────────────────────────

test('inline runFlow {when, commands} is allowed and its nested commands are validated', () => {
  const yaml = `- runFlow:\n    when:\n      visible: "Open in"\n    commands:\n      - tapOn: "Open in"`;
  const flow = parseAndValidateFlow(yaml, { rejectHeader: true });
  assert.equal(flow.commands.length, 1);
  assert.ok('runFlow' in flow.commands[0]);
});

test('inline runFlow with a DENIED nested command is rejected', () => {
  const yaml = `- runFlow:\n    commands:\n      - runScript: evil.js`;
  assert.throws(() => parseAndValidateFlow(yaml, { rejectHeader: true }), MaestroValidationError);
});

// ── {file} resolution + inline expansion ─────────────────────────────────

test('runFlow {file} within flowRoot is expanded inline (no file ref remains)', () => {
  const sub = `${FLOW_ROOT}/dialog.yaml`;
  const fs = makeFs({ [sub]: `- tapOn: "Allow"` });
  const yaml = `- runFlow: dialog.yaml`;
  const flow = parseAndValidateFlow(yaml, {
    rejectHeader: true,
    flowDir: FLOW_DIR,
    flowRoot: FLOW_ROOT,
    ...fs,
  });
  // The sub-flow's command is present and the serialized raw has no runFlow file ref.
  assert.ok(!/dialog\.yaml/.test(flow.raw), 'no file ref remains in serialized flow');
  assert.ok(/Allow/.test(flow.raw), 'sub-flow command was inlined');
});

test('runFlow {file} with .. traversal is rejected', () => {
  const fs = makeFs({});
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: ../../etc/evil.yaml`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} with an absolute path is rejected', () => {
  const fs = makeFs({});
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: /etc/evil.yaml`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} that realpath-escapes flowRoot (symlink) is rejected', () => {
  const inside = `${FLOW_ROOT}/link.yaml`;
  const fs = makeFs({ [inside]: `- tapOn: x`, __realpath: { [inside]: '/etc/outside.yaml' } });
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: link.yaml`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} with a non-yaml extension is rejected', () => {
  const fs = makeFs({ [`${FLOW_ROOT}/x.js`]: `whatever` });
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: x.js`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} cycle (a -> b -> a) is rejected', () => {
  const a = `${FLOW_ROOT}/a.yaml`;
  const b = `${FLOW_ROOT}/b.yaml`;
  const fs = makeFs({ [a]: `- runFlow: b.yaml`, [b]: `- runFlow: a.yaml` });
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: a.yaml`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} exceeding max depth is rejected', () => {
  const files = {};
  for (let i = 0; i < 8; i++) files[`${FLOW_ROOT}/d${i}.yaml`] = `- runFlow: d${i + 1}.yaml`;
  const fs = makeFs(files);
  assert.throws(
    () =>
      parseAndValidateFlow(`- runFlow: d0.yaml`, {
        rejectHeader: true,
        flowDir: FLOW_DIR,
        flowRoot: FLOW_ROOT,
        maxRunFlowDepth: 3,
        ...fs,
      }),
    MaestroValidationError,
  );
});

test('runFlow {file} with no flowRoot context is rejected (cannot resolve safely)', () => {
  assert.throws(
    () => parseAndValidateFlow(`- runFlow: dialog.yaml`, { rejectHeader: true }),
    MaestroValidationError,
  );
});
