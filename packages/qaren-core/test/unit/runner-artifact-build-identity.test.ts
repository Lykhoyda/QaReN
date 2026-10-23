import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '../../../..');
const VERSION = '2.0.0-beta.3';

test('the installed runtime supplies its full version despite a legacy host-plugin override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-runtime-identity-'));
  const runtime = join(root, 'runtime');
  const legacy = join(root, 'legacy-plugin.json');
  try {
    mkdirSync(join(runtime, 'qa'), { recursive: true });
    writeFileSync(
      join(runtime, 'package.json'),
      JSON.stringify({ name: 'qaren-runtime', version: VERSION }),
    );
    writeFileSync(legacy, JSON.stringify({ version: '1.0.13' }));
    await build({
      entryPoints: [join(ROOT, 'packages/qaren-core/src/runners/protocol.ts')],
      outfile: join(runtime, 'qa', 'protocol.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    const observed = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {getPluginVersion} from './runtime/qa/protocol.mjs'; console.log(getPluginVersion());",
      ],
      { cwd: root, env: { ...process.env, QAREN_PLUGIN_MANIFEST: legacy }, encoding: 'utf8' },
    );
    assert.equal(observed.trim(), VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
