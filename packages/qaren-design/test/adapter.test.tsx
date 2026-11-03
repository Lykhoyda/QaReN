import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { buildAdapter } from '../scripts/build-adapter';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const names = buildAdapter(pkgDir);
const QaReN = (await import('../dist/index.js')).default;

const steps = [
  { text: 'Tap "onboarding-skip"', status: 'passed' as const },
  { text: '"Welcome" is on screen', status: 'failed' as const, detail: 'reason' },
];

// One element per component in the bundle header.
const cases: Record<string, [ReactElement, string]> = {
  Logo: [<QaReN.Logo />, 'qr-logo'],
  VerdictPill: [<QaReN.VerdictPill verdict="PASS" />, 'qr-verdict'],
  StepList: [<QaReN.StepList steps={steps} />, 'qr-steps'],
  VideoProofCard: [<QaReN.VideoProofCard verdict="FAIL" title="Onboarding" />, 'qr-video'],
  PRCommentSummary: [<QaReN.PRCommentSummary verdict="PASS" steps={steps} />, 'qr-pr'],
  LedgerRow: [
    <QaReN.LedgerRow index={1} status="passed" action="tap" target="skip" />,
    'qr-ledger-row',
  ],
  Wordmark: [<QaReN.Wordmark cursor />, 'qr-wordmark'],
  Button: [<QaReN.Button>Run</QaReN.Button>, 'qr-btn'],
  Link: [<QaReN.Link href="/docs">Docs</QaReN.Link>, 'qr-link'],
  CodeBlock: [<QaReN.CodeBlock code={'# plan\nqaren check'} />, 'qr-codeblock'],
  InlineCode: [<QaReN.InlineCode>qaren</QaReN.InlineCode>, 'qr-code-inline'],
  TerminalPane: [
    <QaReN.TerminalPane lines={[{ text: 'qaren check', kind: 'cmd' }]} />,
    'qr-terminal',
  ],
  Card: [<QaReN.Card title="Plans">Write one</QaReN.Card>, 'qr-card'],
  Badge: [<QaReN.Badge tone="pass">passed</QaReN.Badge>, 'qr-badge'],
  Callout: [<QaReN.Callout tone="caution">Careful</QaReN.Callout>, 'qr-callout'],
  Table: [
    <QaReN.Table columns={[{ key: 'a', label: 'A' }]} rows={[{ a: '1' }]} />,
    'qr-table-wrap',
  ],
  NavBar: [<QaReN.NavBar links={[{ label: 'Docs', href: '/', active: true }]} />, 'qr-nav'],
  Footer: [<QaReN.Footer links={[{ label: 'GitHub' }]} />, 'qr-footer'],
};

describe('generated adapter', () => {
  test('covers every component in the bundle header', () => {
    expect(Object.keys(cases).sort()).toEqual([...names].sort());
  });

  test.each(Object.entries(cases))('%s renders its root class', (_, [element, root]) => {
    expect(renderToStaticMarkup(element)).toMatch(new RegExp(`^<\\w+ class="${root}[ "]`));
  });

  test('NavBar carries the Logo lockup', () => {
    expect(renderToStaticMarkup(cases.NavBar[0])).toContain(
      'class="qr-logo" width="93.4375" height="26" viewBox="0 0 230 64"',
    );
  });
});

describe('hydration on React 19', () => {
  const dom = new Window({ url: 'https://qaren.test/' });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });
  afterAll(async () => {
    await dom.happyDOM.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  test('a server-rendered page hydrates without errors and stays interactive', async () => {
    let clicks = 0;
    const page = (
      <div className="qr-root" data-theme="dark">
        {Object.values(cases).map(([element], i) => (
          <section key={i}>{element}</section>
        ))}
        <QaReN.Button variant="primary" onClick={() => clicks++}>
          Check
        </QaReN.Button>
      </div>
    );
    const container = dom.document.createElement('div');
    container.innerHTML = renderToString(page);
    dom.document.body.append(container);
    const recoverable: unknown[] = [];
    const consoleError = spyOn(console, 'error');
    // Happy DOM implements the container API with its own DOM types.
    const root = await act(async () =>
      hydrateRoot(container as unknown as Element, page, {
        onRecoverableError: (error) => recoverable.push(error),
      }),
    );
    await act(async () => {
      (container.querySelector('.qr-btn--primary') as unknown as HTMLElement).click();
    });
    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(clicks).toBe(1);
    // The adapter's module-scoped window kept bundle.js off the real one.
    expect((dom as unknown as { QaReN?: unknown }).QaReN).toBeUndefined();
    consoleError.mockRestore();
    await act(async () => root.unmount());
  });
});
