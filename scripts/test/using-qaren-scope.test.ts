import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skill = readFileSync(
  new URL('../../packages/qaren-plugin/skills/using-qaren/SKILL.md', import.meta.url),
  'utf8',
);

test('the published drafting instructions put the three edge cases in priority order', () => {
  const steps = Array.from(skill.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm), (match) => match[1]);
  assert.deepEqual(
    steps.filter((name) => /^(leave and reopen|spelling variants|request count)$/i.test(name)),
    ['Leave and reopen', 'Spelling variants', 'Request count'],
  );
});

test('saved plan selection retains requested scope and drafts missing journeys outside the plan book', () => {
  const selection = skill.split('## Saved plans\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(
    selection,
    /explicitly selected plan[^.]*smoke-only[^.]*exact rerun[^.]*keep the requested scope/i,
  );
  assert.match(selection, /compare[^.]*steps[^.]*coverage/i);
  assert.match(selection, /missing journeys[^.]*temporary[^.]*outside `\.qaren\/plans\/`/i);
});
