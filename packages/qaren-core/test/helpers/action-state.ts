// GH #397 — sidecar run-history seeding for blind-probe tests. Routes through
// the production appendRunRecord() so seeded sidecars carry the same
// invariants (history cap, updatedAt, stats) as anything production writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRunRecord } from '../../dist/domain/reusable-action.js';
import type { ActionRuntimeState, RunRecord } from '../../src/domain/reusable-action.js';

export function appendRunRecordToSidecar(projectRoot: string, id: string, record: RunRecord): void {
  const path = join(projectRoot, '.qaren', 'state', `${id}.state.json`);
  const state = JSON.parse(readFileSync(path, 'utf8')) as ActionRuntimeState;
  const next = appendRunRecord(state, record);
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
}
