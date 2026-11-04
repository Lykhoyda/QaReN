// The home page from the "Home (dark)" board. shortcut: src/content/docs/index.mdx repeats this
// copy as Markdown for the llms files; verify-site checks every h2 here appears there.
import { BASE_PATH, pagePath } from '../site.ts';
import { HomeHeader, SiteFooter } from './Chrome.tsx';
import { AgentPrompt } from './Content.tsx';

const docs = (slug: string) => `${BASE_PATH}${pagePath(slug)}`;

function Tick() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

const RUN = [
  ['1', 'Tap "onboarding-skip"'],
  ['2', 'Wait for "Welcome" to appear'],
  ['✓', '"Welcome" is on screen'],
  ['3', 'Tap "tab-tasks"'],
];

const TRUST = [
  {
    title: 'A verdict, not a summary',
    body: 'Every run ends in PASS, FAIL or a refusal with a typed reason and the next action to take. Your agent reads it as JSON; your scripts read the exit code.',
    foot: 'exit 0 pass · 1 fail · 4 refused',
  },
  {
    title: 'Evidence you can open',
    body: 'Each run keeps a step-by-step ledger and a readable report at the paths its receipt names. A pull request run adds a screen recording when one can be captured.',
    foot: 'report.md · ledger.json · run.json · logs/events.jsonl',
  },
  {
    title: 'It tests what you changed',
    body: "QaReN builds your working tree, or a pull request's head, and fails the run if the code changes while the plan is being walked, so a drifted run can never pass.",
    foot: 'CANDIDATE_DRIFTED is never a pass',
  },
];

const GUIDES = [
  ['cli', 'The qaren CLI', 'Every command, its flags and what it refuses.'],
  ['check', 'Check a plan', 'qaren check, devices, the receipt and exit codes.'],
  ['pull-requests', 'Test a pull request', 'qaren pr, screen recording and qaren publish.'],
  ['plans', 'Write a plan', 'The plan grammar and what a check reads.'],
  ['saved-blocks', 'Saved blocks', 'How passing blocks are saved, replayed and patched.'],
  ['plugin', 'Use it from your agent', "The plugin's skills in Claude Code, Codex and Cursor."],
];

export function Home() {
  return (
    <div className="docs-root home">
      <HomeHeader />
      <main id="main" className="home-main" data-pagefind-body="">
        <section className="home-hero">
          <div className="home-hero__text">
            <p className="docs-label">
              React Native · iOS simulator · Claude Code, Codex and Cursor
            </p>
            <h1 className="home-display">A QA engineer for your coding agent</h1>
            <p className="home-lead">
              Claude Code, Codex or Cursor writes the React Native change. QaReN tries it in your
              app on an iOS simulator and comes back with PASS or FAIL, and the evidence behind it.
            </p>
            <div className="home-actions">
              <a href="#get-started" className="plain home-btn home-btn--primary">
                Set it up
              </a>
              <a href="#how-it-works" className="plain home-btn">
                How it works
              </a>
            </div>
          </div>
          <figure
            className="home-run"
            aria-label="An example run: four plan steps pass and the verdict is PASS"
          >
            <div className="home-run__bar">
              <span />
              <span />
              <span />
              <span className="docs-label">Onboarding to the tasks tab</span>
            </div>
            <ol>
              {RUN.map(([n, step]) => (
                <li key={step}>
                  <span className="home-run__tick">
                    <Tick />
                  </span>
                  <span className="home-run__n">{n}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div className="home-run__foot">
              <span className="home-verdict">
                <Tick />
                PASS
              </span>
              <span className="docs-label">report.md · ledger.json · block saved</span>
            </div>
          </figure>
        </section>

        <section className="home-split home-rule">
          <h2>Your agent says it is done. Did anyone open the app?</h2>
          <div className="home-split__body">
            <p>
              A coding agent checks its work the ways it can: types, lint, unit tests. It does not
              tap through the app. A screen that never appears, a tap that lands on nothing or a
              flow that breaks halfway gets past all of those and reaches review, or your users.
            </p>
            <p>
              QaReN is the QA engineer on your agent's team. Your agent hands it the change and a
              short plan of what to check; QaReN runs that plan in the real app and tells both of
              you what happened.
            </p>
          </div>
        </section>

        <section className="home-section" aria-labelledby="look">
          <p className="docs-label">How a check runs</p>
          <h2 id="look">What a check looks like</h2>
          <ol className="home-flow">
            <li>
              <span className="home-num">1</span>
              <p>You ask your agent to QA a change, for example "QA the onboarding change".</p>
            </li>
            <li>
              <span className="home-num">2</span>
              <p>
                The agent writes a plan in Markdown: what to tap, what to wait for and what must be
                on screen.
              </p>
              <pre className="home-plan">
                {`### Onboarding to the tasks tab

1. Tap "onboarding-skip"
2. Wait for "Welcome" to appear
✓ "Welcome"
3. Tap "tab-tasks"`}
              </pre>
            </li>
            <li>
              <span className="home-num">3</span>
              <p>
                QaReN borrows a simulator, builds and installs the app from your working tree,
                starts Metro, walks the plan step by step and tears down what it started.
              </p>
            </li>
            <li>
              <span className="home-num">4</span>
              <p>
                You get PASS or FAIL with the evidence. On a pull request, QaReN can record the
                screen and post the result as a comment.
              </p>
            </li>
          </ol>
        </section>

        <section className="home-section" aria-labelledby="trust">
          <h2 id="trust">Why you can trust the verdict</h2>
          <div className="home-cards">
            {TRUST.map((card) => (
              <article key={card.title} className="home-trust">
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <p className="docs-label home-trust__foot">{card.foot}</p>
              </article>
            ))}
            <article className="home-trust">
              <h3>Faster on every run</h3>
              <p>
                A passing block that is eligible is saved under{' '}
                <code className="docs-ic">.qaren/actions/</code> and replayed next time by the exact
                elements it used, so repeat checks skip the search.
              </p>
              <p className="docs-label home-trust__foot">
                ledger.blocks: replayed · patched · discovered
              </p>
            </article>
          </div>
        </section>

        <section className="home-split" aria-labelledby="built">
          <h2 id="built">Built for</h2>
          <div className="docs-table home-split__body">
            <table>
              <thead>
                <tr>
                  <th scope="col">Your</th>
                  <th scope="col">What QaReN works with</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Coding agent</th>
                  <td>Claude Code, Codex or Cursor, through the QaReN plugin.</td>
                </tr>
                <tr>
                  <th scope="row">App</th>
                  <td>
                    An Expo React Native app that uses{' '}
                    <code className="docs-ic">expo-dev-client</code> and pnpm.
                  </td>
                </tr>
                <tr>
                  <th scope="row">Mac</th>
                  <td>
                    An Apple silicon Mac with Xcode. QaReN 2.0 sets up and checks on an iOS
                    simulator.
                  </td>
                </tr>
                <tr>
                  <th scope="row">Android</th>
                  <td className="home-muted">Coming in 2.1.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="get-started" className="home-split" aria-labelledby="gs">
          <div className="home-gs">
            <h2 id="gs">Get started</h2>
            <p>
              Open Claude Code, Codex or Cursor in your app. Copy this prompt, then paste it into
              your agent to set up QaReN for iOS simulators on an Apple silicon Mac:
            </p>
            <ol className="home-gs__steps">
              <li>
                <span>1</span>Copy the prompt.
              </li>
              <li>
                <span>2</span>Paste it into your agent, from the app root.
              </li>
              <li>
                <span>3</span>It stops and tells you if a step needs you, such as an Xcode download
                or a plugin UI step.
              </li>
            </ol>
            <p className="home-muted home-small">
              Prefer terminal commands or manual installation? See the{' '}
              <a href={docs('getting-started')}>full installation guide</a>.
            </p>
          </div>
          <div className="home-gs__prompt">
            <AgentPrompt />
          </div>
        </section>

        <section id="how-it-works" className="home-section home-last" aria-labelledby="hiw">
          <h2 id="hiw">How it works</h2>
          <p className="home-narrow">
            Under the hood, QaReN is the <code className="docs-ic">qaren</code> command-line tool.
            The plugin teaches your agent to drive it, and you can run the same commands yourself.
          </p>
          <div className="home-guides">
            {GUIDES.map(([slug, title, body]) => (
              <a key={slug} href={docs(slug)} className="plain docs-card">
                <span className="home-guides__title">{title}</span>
                <span className="home-muted home-small">{body}</span>
              </a>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter wide />
    </div>
  );
}
