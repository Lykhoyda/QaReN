import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  DocsLayout,
  Footer,
  InlineCode,
  LedgerRow,
  Link,
  Logo,
  NavBar,
  PRCommentSummary,
  StepList,
  Table,
  TerminalPane,
  VerdictPill,
  VideoProofCard,
  Wordmark,
  type Step,
} from '../src/index';

const html = (el: ReactElement) => renderToStaticMarkup(el);
// Text a reader sees: markup stripped, entities decoded for quotes.
const text = (el: ReactElement) =>
  html(el)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const steps: Step[] = [
  { text: 'Tap "onboarding-skip"', status: 'passed' },
  { text: 'Wait for "Welcome" to appear', status: 'running' },
  { text: '"Welcome" is on screen', status: 'failed', detail: 'Placeholder failure reason' },
  { text: 'Open settings', status: 'pending' },
];

describe('components', () => {
  test('VerdictPill writes the verdict as a word beside its glyph', () => {
    const pass = html(<VerdictPill verdict="PASS" />);
    expect(pass).toContain('class="qr-verdict qr-verdict--pass"');
    expect(pass).toMatch(/<svg[^>]*aria-hidden="true".*<\/svg>PASS<\/span>$/);
    expect(html(<VerdictPill verdict="FAIL" size="lg" />)).toContain(
      'qr-verdict--fail qr-verdict--lg',
    );
  });

  test('StepList renders every status as a word', () => {
    const out = html(<StepList steps={steps} />);
    for (const s of ['passed', 'running', 'failed', 'pending']) {
      expect(out).toContain(`<span class="qr-status qr-status--${s}">${s}</span>`);
    }
    expect(out).toContain('aria-current="step"');
    expect(text(<StepList steps={steps} />)).toContain('Placeholder failure reason');
  });

  test('StepList falls back to pending for an unknown status', () => {
    const odd = [{ text: 'x', status: 'skipped' as Step['status'] }];
    expect(html(<StepList steps={odd} />)).toContain('qr-status--pending">pending<');
  });

  test('VideoProofCard shows a labelled placeholder and the m:ss stand-in', () => {
    const out = text(<VideoProofCard verdict="FAIL" title="Skip onboarding" />);
    expect(out).toContain('Placeholder thumbnail');
    expect(out).toContain('FAIL');
    expect(out).toContain('m:ss');
  });

  test('PRCommentSummary carries the verdict word, step statuses and the placeholder badge', () => {
    const el = (
      <PRCommentSummary
        verdict="FAIL"
        plan="Skip onboarding"
        steps={steps}
        artifacts={[{ label: 'report.md' }]}
      />
    );
    expect(html(el)).toContain('aria-label="QaReN result: FAIL"');
    const out = text(el);
    expect(out).toContain('FAIL');
    expect(out).toContain('Placeholder');
    expect(out).toContain('failed');
    expect(out).toContain('report.md');
    expect(text(<PRCommentSummary verdict="PASS" placeholder={false} />)).not.toContain(
      'Placeholder',
    );
  });

  test('LedgerRow renders its status as a word and titles string targets only', () => {
    const out = html(
      <LedgerRow index={3} status="failed" action="assert" target={'"Welcome"'} duration="x.x s" />,
    );
    expect(out).toContain('qr-ledger-row--failed');
    expect(out).toContain('<span class="qr-status qr-status--failed" role="cell">failed</span>');
    expect(out).toContain('title="&quot;Welcome&quot;"');
    expect(
      html(<LedgerRow index={1} status="passed" action="tap" target={<b>x</b>} />),
    ).not.toContain('title=');
  });

  test('Logo draws the symbol, or the lockup with the wordmark outline', () => {
    const symbol = html(<Logo />);
    expect(symbol).toContain('aria-label="QaReN"');
    expect(symbol).toContain('viewBox="0 0 64 64"');
    expect(symbol).toContain('fill="var(--accent)"');
    const lockup = html(<Logo variant="lockup" size={26} mono />);
    expect(lockup).toContain('viewBox="0 0 230 64"');
    expect((lockup.match(/<path /g) ?? []).length).toBe(2);
    expect(lockup).not.toContain('var(--accent)');
  });

  test('Wordmark is a link when given href and carries the cursor on request', () => {
    expect(html(<Wordmark />)).toBe('<span class="qr-wordmark" aria-label="QaReN">QaReN</span>');
    expect(html(<Wordmark href="/" cursor blink />)).toContain('<a class="qr-wordmark" href="/"');
    expect(html(<Wordmark cursor blink />)).toContain('qr-cursor qr-cursor--blink');
  });

  test('Button defaults to a secondary button and becomes a link with href', () => {
    expect(html(<Button>Run</Button>)).toBe(
      '<button class="qr-btn qr-btn--secondary" type="button">Run</button>',
    );
    expect(
      html(
        <Button variant="primary" size="sm" href="/setup">
          Set it up
        </Button>,
      ),
    ).toBe('<a class="qr-btn qr-btn--primary qr-btn--sm" href="/setup">Set it up</a>');
  });

  test('Link renders a muted variant', () => {
    expect(
      html(
        <Link href="/x" muted>
          Docs
        </Link>,
      ),
    ).toBe('<a class="qr-link qr-link--muted" href="/x">Docs</a>');
  });

  test('InlineCode wraps code', () => {
    expect(html(<InlineCode>qaren check</InlineCode>)).toBe(
      '<code class="qr-code-inline">qaren check</code>',
    );
  });

  test('Badge omits the neutral modifier', () => {
    expect(html(<Badge>Run ledger</Badge>)).toBe('<span class="qr-badge">Run ledger</span>');
    expect(html(<Badge tone="pass">PASS</Badge>)).toContain('qr-badge qr-badge--pass');
  });

  test('CodeBlock mutes comment lines unless comments is false', () => {
    const code = '# install\nqaren check\n';
    const out = html(<CodeBlock code={code} title="shell" placeholder />);
    expect(out).toContain('<span class="qr-comment"># install</span>\n<span>qaren check</span>');
    expect(text(<CodeBlock code={code} title="shell" placeholder />)).toContain('Placeholder');
    expect(html(<CodeBlock code="# QA" comments={false} />)).not.toContain('qr-comment');
    expect(html(<CodeBlock code="x" />)).not.toContain('qr-codeblock__head');
  });

  test('TerminalPane marks placeholder output and prompts commands', () => {
    const el = (
      <TerminalPane
        lines={[
          { text: 'qaren check', kind: 'cmd' },
          { text: 'PASS placeholder', kind: 'pass' },
        ]}
        cursor
      />
    );
    const out = html(el);
    expect(out).toContain('<span class="qr-prompt">$ </span>qaren check');
    expect(out).toContain('qr-line qr-line--pass');
    expect(out).toContain('qr-cursor qr-cursor--blink');
    expect(text(el)).toContain('Placeholder output');
    expect(text(<TerminalPane lines={[]} placeholder={false} />)).not.toContain('Placeholder');
  });

  test('Card is a link when given href', () => {
    const out = html(
      <Card kicker="Start here" title="Getting started" href="/start">
        Install it.
      </Card>,
    );
    expect(out).toContain('<a class="qr-card" href="/start">');
    expect(out).toContain('<h3 class="qr-card__title">Getting started</h3>');
  });

  test('Callout labels its tone in words', () => {
    expect(text(<Callout tone="caution">Mind the device.</Callout>)).toBe(
      'Caution Mind the device.',
    );
    expect(html(<Callout tone="danger">x</Callout>)).toContain('qr-callout qr-callout--danger');
  });

  test('Table renders headers, cells and a hidden caption', () => {
    const out = html(
      <Table
        caption="Commands"
        columns={[
          { key: 'cmd', label: 'Command' },
          { key: 'n', label: 'Runs', numeric: true },
        ]}
        rows={[{ cmd: 'qaren pr', n: '1' }]}
      />,
    );
    expect(out).toContain('<th scope="col">Command</th>');
    expect(out).toContain('<td class="qr-num">1</td>');
    expect(out).toContain('Commands</caption>');
  });

  test('NavBar marks the current link and shows the logo lockup', () => {
    const out = html(
      <NavBar
        links={[
          { label: 'Docs', active: true },
          { label: 'Changelog', href: '/changelog/' },
        ]}
      />,
    );
    expect(out).toContain('aria-label="Main"');
    expect(out).toContain('aria-current="page">Docs</a>');
    expect(out).toContain('viewBox="0 0 230 64"');
  });

  test('Footer shows the wordmark, the default note and muted links', () => {
    const out = text(
      <Footer links={[{ label: 'GitHub', href: 'https://github.com/Lykhoyda/QaReN' }]} />,
    );
    expect(out).toBe('QaReN Open source under the MIT license. GitHub');
  });

  test('DocsLayout renders the light docs page with sidebar, reading column and footer', () => {
    const out = html(
      <DocsLayout
        nav={{ links: [{ label: 'Docs', active: true }] }}
        groups={[
          {
            label: 'How QaReN works',
            items: [
              { label: 'Write a plan', href: '/plans/', active: true },
              { label: 'Saved blocks' },
            ],
          },
        ]}
      >
        <h1 className="h1">Write a plan</h1>
      </DocsLayout>,
    );
    expect(out).toMatch(/^<div class="qr-root qr-docs" data-theme="light">/);
    expect(out).toContain('<nav class="qr-docs__side" aria-label="Docs">');
    expect(out).toContain('<p class="label qr-docs__group-label">How QaReN works</p>');
    expect(out).toContain(
      '<a class="qr-docs__link" href="/plans/" aria-current="page">Write a plan</a>',
    );
    expect(out).toContain('<main class="qr-docs__main"><h1 class="h1">Write a plan</h1></main>');
    expect(out).toContain('<footer class="qr-footer">');
  });
});
