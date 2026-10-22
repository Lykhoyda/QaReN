import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  parsePlan,
  parseStep,
  planNeedsJev,
  preparePlan,
  readPreparedPlan,
  slugify,
} from '../../../dist/qa/plan.js';
import { ACTION_ID_MAX_LEN, isValidActionId } from '../../../dist/domain/path-safety.js';

test('generated IDs preserve valid slugs and bound overflowing headings deterministically', () => {
  for (const title of [
    '  Hello, World!  ',
    '!!!',
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(4000),
  ]) {
    const full =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'plan';
    const expected =
      full.length <= ACTION_ID_MAX_LEN
        ? full
        : `${full.slice(0, 47)}-${createHash('sha256').update(full).digest('hex').slice(0, 16)}`;
    assert.equal(slugify(title), expected);
    assert.ok(isValidActionId(expected));
    for (const heading of ['#', '###']) {
      const markdown = `${heading} ${title}\n1. Tap "A"\n`;
      const parsed = parsePlan(markdown);
      assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
      assert.equal(parsed.blocks[0].slug, expected);
      assert.equal(parsed.blocks[0].title, title.trim());
      assert.deepEqual(
        readPreparedPlan(markdown, preparePlan(markdown, parsed.blocks)),
        parsed.blocks,
      );
    }
  }
});

test('long headings keep full-slug duplicate detection and distinguish equal prefixes', () => {
  const prefix = 'a'.repeat(80);
  const parsed = parsePlan(`### ${prefix} one\n1. Tap "A"\n### ${prefix} two\n1. Tap "B"\n`);
  assert.ok(parsed.blocks);
  assert.notEqual(parsed.blocks[0].slug, parsed.blocks[1].slug);
  const duplicate = parsePlan(`### ${prefix} ONE\n1. Tap "A"\n### ${prefix}---one!\n1. Tap "B"\n`);
  assert.equal(duplicate.blocks, undefined);
  assert.match(duplicate.refused?.[0].reason ?? '', /another block is already named/);
});

test('bounded-ID collisions refuse the whole plan in either order and with a headingless block', () => {
  const long = 'a'.repeat(65);
  const bounded = slugify(long);
  for (const [first, second] of [
    [long, bounded],
    [bounded, long],
  ]) {
    for (const heading of ['#', '###']) {
      const markdown = `${heading} ${first}\n1. Tap "A"\n### ${second}\n1. Tap "B"\n`;
      const parsed = parsePlan(markdown);
      assert.equal(parsed.blocks, undefined);
      assert.match(
        parsed.refused?.[0].reason ?? '',
        /distinct block titles produce the same action ID/,
      );
    }
  }
});

test('every grammar shape parses to its step kind', () => {
  const cases: Array<[string, unknown]> = [
    ['Tap "Save"', { kind: 'press', target: { quoted: 'Save', phrase: 'Save' } }],
    [
      'Press on the "Edit profile" button',
      { kind: 'press', target: { quoted: 'Edit profile', phrase: 'Edit profile button' } },
    ],
    ['Open Settings', { kind: 'press', target: { quoted: undefined, phrase: 'Settings' } }],
    ['Go to "tab-tasks"', { kind: 'press', target: { quoted: 'tab-tasks', phrase: 'tab-tasks' } }],
    [
      'Type "Anton" into the name field',
      { kind: 'fill', target: { quoted: undefined, phrase: 'name field' }, text: 'Anton' },
    ],
    [
      'Type “Anton” into "wizard-title-input"',
      {
        kind: 'fill',
        target: { quoted: 'wizard-title-input', phrase: 'wizard-title-input' },
        text: 'Anton',
      },
    ],
    [
      'Fill "Email" with "a@b.co"',
      { kind: 'fill', target: { quoted: 'Email', phrase: 'Email' }, text: 'a@b.co' },
    ],
    [
      'Enter "1234" in "otp_code"',
      { kind: 'fill', target: { quoted: 'otp_code', phrase: 'otp_code' }, text: '1234' },
    ],
    ['Scroll down', { kind: 'scroll', direction: 'down' }],
    ['Scroll up', { kind: 'scroll', direction: 'up' }],
    [
      'Scroll until you see "Load more"',
      { kind: 'scroll', direction: 'down', until: { quoted: 'Load more', phrase: 'Load more' } },
    ],
    [
      'Scroll down to "Footer"',
      { kind: 'scroll', direction: 'down', until: { quoted: 'Footer', phrase: 'Footer' } },
    ],
    [
      'Wait for "Welcome" to appear',
      { kind: 'wait', target: { quoted: 'Welcome', phrase: 'Welcome' } },
    ],
    ['Wait until "Done" is visible', { kind: 'wait', target: { quoted: 'Done', phrase: 'Done' } }],
    ['Go back', { kind: 'back' }],
    ['Back', { kind: 'back' }],
    ['Press back', { kind: 'back' }],
    ['Accept the permission dialog', { kind: 'dialog', action: 'accept' }],
    ['Allow the notifications prompt', { kind: 'dialog', action: 'accept' }],
    ['Dismiss the alert', { kind: 'dialog', action: 'dismiss' }],
    ['Deny the location permission', { kind: 'dialog', action: 'dismiss' }],
  ];
  for (const [line, expected] of cases) {
    assert.deepEqual(parseStep(line), expected, line);
  }
});

test('lines the grammar cannot read return null', () => {
  assert.equal(parseStep('Frobnicate the widget'), null);
  assert.equal(
    parseStep('Cancel'),
    null,
    'a bare Cancel is a button press only when written as Tap "Cancel"',
  );
});

test('a fill without quoted text refuses with its line number', () => {
  const parsed = parsePlan(
    '## QA\n1. Tap "Settings"\n2. Type your name into the field\n✓ "Saved"\n',
  );
  assert.ok(parsed.refused);
  assert.deepEqual(parsed.refused, [
    { line: 3, text: '2. Type your name into the field', reason: 'fill needs the text in quotes' },
  ]);
});

test('a plan splits into blocks by ### heading and hashes its item lines', () => {
  const markdown = [
    '# Change profile data',
    '',
    '## QA',
    '### Log in as the test user',
    '1. Tap "login_submit"',
    '### Change profile data',
    'starts on: Profile',
    '1. Open "tab-profile"',
    '2. Tap "profile-edit-btn"',
    '3. Type "Anton" into "profile-name-input"',
    '4. Tap "Save"',
    '✓ The profile header shows "Anton"',
    '✓ The avatar is unchanged',
    '',
    '## Notes',
    'not part of the plan',
  ].join('\n');
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks);
  assert.deepEqual(
    parsed.blocks.map((b) => [b.slug, b.title, b.items.length]),
    [
      ['log-in-as-the-test-user', 'Log in as the test user', 1],
      ['change-profile-data', 'Change profile data', 7],
    ],
  );
  const [, profile] = parsed.blocks;
  assert.deepEqual(
    profile.items.map((i) => [i.line, i.kind, i.source]),
    [
      [7, 'wait', 'grammar'],
      [8, 'press', 'grammar'],
      [9, 'press', 'grammar'],
      [10, 'fill', 'grammar'],
      [11, 'press', 'grammar'],
      [12, 'check', 'grammar'],
      [13, 'check', 'grammar'],
    ],
  );
  const mixed = profile.items[5];
  const phrase = profile.items[6];
  assert.ok(
    mixed.kind === 'check' && !mixed.literal && mixed.text === 'The profile header shows "Anton"',
  );
  assert.ok(
    phrase.kind === 'check' && !phrase.literal && phrase.text === 'The avatar is unchanged',
  );
  assert.match(profile.planHash, /^[0-9a-f]{64}$/);
  assert.notEqual(profile.planHash, parsed.blocks[0].planHash);
  assert.equal(
    profile.planHash,
    parsePlan(markdown.replace('4. Tap "Save"', '4.  Tap  "Save"')).blocks![1].planHash,
  );
});

test('starts on is a leading literal wait for a testID or visible text', () => {
  for (const [raw, value] of [
    ['starts on: Profile', 'Profile'],
    ['starts on: "Profile"', 'Profile'],
    ['Starts on: wizard-title-input', 'wizard-title-input'],
  ]) {
    const parsed = parsePlan(`# Journey\n## QA\n### Continue\n${raw}\n1. Tap "Back"`);
    assert.ok(parsed.blocks);
    assert.deepEqual(parsed.blocks[0].items[0], {
      kind: 'wait',
      precondition: true,
      target: { quoted: value, phrase: value },
      line: 4,
      raw,
      source: 'grammar',
    });
  }
});

test('starts on cannot replace the steps or appear after them', () => {
  assert.match(
    parsePlan('### Continue\nstarts on: Profile').refused?.[0].reason ?? '',
    /this block has no steps/,
  );
  assert.deepEqual(parsePlan('### Continue\n1. Tap "Back"\nstarts on: Profile').refused, [
    { line: 3, text: 'starts on: Profile', reason: "starts on must come before the block's steps" },
  ]);
});

test('a headingless plan is one block named after the title', () => {
  const parsed = parsePlan('# Smoke\n1. Tap "A"\n✓ "B"\n');
  assert.ok(parsed.blocks);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].slug, 'smoke');
  assert.equal(parsed.blocks[0].items.length, 2);
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});

test('duplicate headings, empty declared blocks and multiline comments are handled', () => {
  const dup = parsePlan('### Login\n1. Tap "A"\n### Login\n1. Tap "B"\n');
  assert.deepEqual(dup.refused, [
    { line: 3, text: '### Login', reason: 'another block is already named "login"' },
  ]);
  const empty = parsePlan('### Login\n### Create\n1. Tap "A"\n');
  assert.deepEqual(empty.refused?.[0], {
    line: 1,
    text: '### Login',
    reason:
      'this block has no steps (reusing a saved block by heading arrives with blocks in a later phase)',
  });
  const commented = parsePlan('<!--\nthis is\nignored -->\n1. Tap "A"\n<!-- one line -->\n✓ "B"\n');
  assert.ok(commented.blocks);
  assert.equal(commented.blocks[0].items.length, 2);
  const indented = parsePlan('## QA\n1. Tap "A"\n   ## Notes\nprose here\n');
  assert.ok(indented.blocks, JSON.stringify(indented.refused));
});

test('prose inside the plan and an empty plan are refused with a line number', () => {
  const prose = parsePlan('## QA\n1. Tap "A"\nthen wait a bit\n');
  assert.deepEqual(prose.refused, [
    { line: 3, text: 'then wait a bit', reason: 'not a numbered step or a ✓ line' },
  ]);
  const unknown = parsePlan('1. Frobnicate the widget\n');
  assert.equal(unknown.refused?.[0].line, 1);
  assert.match(unknown.refused?.[0].reason ?? '', /no verb the grammar knows/);
  assert.equal(parsePlan('# Only a title\n').refused?.[0].reason, 'the plan has no steps');
});

test('a commented-out ## heading inside the QA section does not end the section', () => {
  const parsed = parsePlan(
    '## QA\n1. Tap "A"\n<!--\n## old heading\n2. Tap "old"\n-->\n2. Tap "B"\n✓ "Done"\n',
  );
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  assert.equal(parsed.blocks.length, 1);
  assert.deepEqual(
    parsed.blocks?.[0].items.map((i) => [i.line, i.kind]),
    [
      [2, 'press'],
      [7, 'press'],
      [8, 'check'],
    ],
  );
});

test('a comment opened mid-line and a commented-out ## QA are both ignored', () => {
  const parsed = parsePlan(
    '<!-- ## QA -->\n## QA\n1. Tap "A" <!--\n## obsolete\n-->\n2. Tap "B"\n',
  );
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  assert.deepEqual(
    parsed.blocks[0].items.map((i) => [i.line, i.raw]),
    [
      [3, '1. Tap "A"'],
      [6, '2. Tap "B"'],
    ],
  );
});

test('a comment opened on the ## QA line itself hides the following steps until it closes', () => {
  const parsed = parsePlan('## QA <!--\n1. Tap "commented"\n-->\n1. Tap "A"\n');
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  assert.deepEqual(
    parsed.blocks[0].items.map((i) => [i.line, i.raw]),
    [[4, '1. Tap "A"']],
  );
});

test('a fill preposition is only stripped as a whole word', () => {
  const step = parseStep('type "hello" input');
  assert.deepEqual(step, {
    kind: 'fill',
    target: { quoted: undefined, phrase: 'input' },
    text: 'hello',
  });
  const topic = parseStep('type "hello" into topic');
  assert.deepEqual(topic, {
    kind: 'fill',
    target: { quoted: undefined, phrase: 'topic' },
    text: 'hello',
  });
});

test('named input grammar is declarative and malformed reserved forms never become literals', () => {
  for (const name of ['A', 'SLOT_A', 'A' + '_'.repeat(31)]) {
    const parsed = parseStep(`Fill "slot-field" with input ${name}`);
    assert.deepEqual(parsed, {
      kind: 'fill',
      target: { quoted: 'slot-field', phrase: 'slot-field' },
      input: name,
    });
    const source = `# Sign in\n1. Fill "slot-field" with input ${name}`;
    const plan = parsePlan(source);
    assert.ok(plan.blocks);
    const prepared = preparePlan(source, plan.blocks);
    assert.deepEqual(readPreparedPlan(source, prepared), plan.blocks);
    const extra = structuredClone(prepared);
    extra.blocks[0].items[0].text = 'invented';
    assert.equal(readPreparedPlan(source, extra), undefined);
  }
  for (const name of ['', 'slot_a', '_PASS', 'A'.repeat(33), 'PASS extra', '${PASS}']) {
    assert.ok('refuse' in parseStep(`Fill "slot-field" with input ${name}`));
  }
  assert.equal(parseStep('Fill "slot-field" with "input SLOT_A"').text, 'input SLOT_A');
  assert.equal(
    parseStep('Fill "note" with "remember with input BAR"').text,
    'remember with input BAR',
  );
  assert.equal(parseStep('Type "with input BAR" into "note"').text, 'with input BAR');
});

test('a declared input echo parses as its own step and refuses every malformed form', () => {
  for (const line of ['Expect input EMAIL on screen', 'expect input EMAIL on this screen']) {
    assert.deepEqual(parseStep(line), { kind: 'echo', input: 'EMAIL' });
  }
  const reason = 'expect input needs a declared input name and "on screen"';
  for (const line of [
    'Expect input "qa@example.test" on screen',
    'Expect input email on screen',
    'Expect input EMAIL',
    'Expect input EMAIL on the sheet',
    'Expect input ${EMAIL} on screen',
  ]) {
    assert.deepEqual(parseStep(line), { refuse: reason });
    const plan = parsePlan(`# Sign in\n1. Fill "email" with input EMAIL\n2. ${line}\n`);
    assert.deepEqual(
      plan.refused?.map((r) => [r.line, r.reason]),
      [[3, reason]],
    );
  }
  assert.deepEqual(
    parsePlan(
      '# Sign in\n1. Fill "email" with input EMAIL\n2. Expect input OTP on screen\n',
    ).refused?.map((r) => [r.line, r.reason]),
    [[3, 'expect input names an input no fill step in this plan uses']],
  );
  const source =
    '# Sign in\n1. Fill "email" with input EMAIL\n2. Expect input EMAIL on screen\n3. Tap "submit"\n';
  const plan = parsePlan(source);
  assert.ok(plan.blocks);
  assert.deepEqual(
    plan.blocks[0].items.map((item) => item.kind),
    ['fill', 'echo', 'press'],
  );
  assert.deepEqual(readPreparedPlan(source, preparePlan(source, plan.blocks)), plan.blocks);
  assert.equal(planNeedsJev(source), false);
  const without = parsePlan(source.replace('2. Expect input EMAIL on screen\n', ''));
  assert.notEqual(without.blocks![0].planHash, plan.blocks[0].planHash);
});

test('named fixture grammar is finite and literal fill shapes remain unchanged', () => {
  assert.deepEqual(parseStep('Fill "code" with input FIXTURE (non-secret)'), {
    kind: 'fill',
    target: { quoted: 'code', phrase: 'code' },
    input: 'FIXTURE',
    sensitivity: 'non-secret',
  });
  assert.deepEqual(parseStep('Fill "code" with input FIXTURE'), {
    kind: 'fill',
    target: { quoted: 'code', phrase: 'code' },
    input: 'FIXTURE',
  });
  assert.equal(parseStep('Type "text with input FIXTURE" into "field"')?.kind, 'fill');
  assert.equal(parseStep('Type "text" into field (optional)')?.kind, 'fill');
  for (const text of [
    'Fill "field" with input "FIXTURE"',
    'Fill "field" with input FIXTURE (non-secert)',
    'Fill "field" with "fixture" (non-secret)',
    'Expect input FIXTURE on screen (non-secret)',
    'Please fill "field" with input FIXTURE (non-secret)',
  ]) {
    assert.ok(parsePlan(`1. ${text}`).refused, text);
    assert.equal(planNeedsJev(`1. ${text}`), false);
  }
});

test('broken markers are comments: a flagged plan parses to the same blocks', () => {
  const plan = '# Login\n\n## QA\n\n### Login\n1. Tap "Sign in"\n✓ "Welcome"\n';
  const shape = (markdown: string) =>
    parsePlan(markdown).blocks?.map(({ slug, title, planHash, items }) => ({
      slug,
      title,
      planHash,
      raw: items.map((item) => item.raw),
    }));
  for (const marker of ['<!-- qaren:broken ios -->', '<!-- qaren:broken -->'])
    assert.deepEqual(shape(`${marker}\n${plan}`), shape(plan));
});
