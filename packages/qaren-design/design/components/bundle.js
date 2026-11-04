/* @ds-bundle: {"format":4,"namespace":"QaReN","components":[{"name":"Logo"},{"name":"VerdictPill"},{"name":"StepList"},{"name":"VideoProofCard"},{"name":"PRCommentSummary"},{"name":"LedgerRow"},{"name":"Wordmark"},{"name":"Button"},{"name":"Link"},{"name":"CodeBlock"},{"name":"InlineCode"},{"name":"TerminalPane"},{"name":"Card"},{"name":"Badge"},{"name":"Callout"},{"name":"Table"},{"name":"NavBar"},{"name":"Footer"}]} */
(function () {
  'use strict';
  var React = window.React;
  var h = React.createElement;

  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(' ');
  }

  // ---- glyphs (stroke in currentColor) ----
  function Check() {
    return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M3.5 8.5l3 3 6-7', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
  }
  function Cross() {
    return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }));
  }
  function Play() {
    return h('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' }, h('path', { d: 'M2 1l7 4-7 4z', fill: 'currentColor' }));
  }

  var STATUS_WORD = { pending: 'pending', running: 'running', passed: 'passed', failed: 'failed' };

  function Mark(props) {
    var s = props.status;
    return h('span', { className: cx('qr-mark', 'qr-mark--' + s), 'aria-hidden': 'true' },
      s === 'passed' ? h(Check) : s === 'failed' ? h(Cross) : null);
  }

  // ---- QaReN ----
  function VerdictPill(props) {
    var v = props.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    return h('span', {
      className: cx('qr-verdict', 'qr-verdict--' + v.toLowerCase(), props.size && props.size !== 'md' ? 'qr-verdict--' + props.size : null, props.className)
    }, v === 'PASS' ? h(Check) : h(Cross), v);
  }

  function StepList(props) {
    var steps = props.steps || [];
    return h('ol', { className: cx('qr-steps', props.className) }, steps.map(function (s, i) {
      var st = STATUS_WORD[s.status] ? s.status : 'pending';
      return h('li', { key: i, className: cx('qr-step', 'qr-step--' + st), 'aria-current': st === 'running' ? 'step' : undefined },
        h(Mark, { status: st }),
        h('span', { className: 'qr-step__n' }, String(i + 1)),
        h('span', { className: 'qr-step__text' }, s.text, s.detail ? h('span', { className: 'qr-step__detail' }, s.detail) : null),
        h('span', { className: cx('qr-status', 'qr-status--' + st) }, STATUS_WORD[st]));
    }));
  }

  function VideoProofCard(props) {
    var v = props.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    return h('figure', { className: cx('qr-video', props.className), style: { margin: 0 } },
      h('div', { className: 'qr-video__thumb' },
        props.thumbnail
          ? h('img', { src: props.thumbnail, alt: props.alt || 'Screen recording of the run' })
          : h('div', { className: 'qr-video__ph' }, h('span', null, 'Placeholder thumbnail')),
        h('div', { className: 'qr-video__verdict' }, h(VerdictPill, { verdict: v, size: 'sm' })),
        h('span', { className: 'qr-video__play' }, h(Play), props.duration || 'm:ss')),
      h('figcaption', { className: 'qr-video__body' },
        h('p', { className: 'qr-video__title' }, props.title),
        props.meta ? h('p', { className: 'qr-video__meta' }, props.meta) : null));
  }

  function PRCommentSummary(props) {
    var v = props.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    var placeholder = props.placeholder !== false;
    return h('section', { className: cx('qr-pr', 'qr-pr--' + v.toLowerCase(), props.className), 'aria-label': 'QaReN result: ' + v },
      h('div', { className: 'qr-pr__head' },
        h(VerdictPill, { verdict: v }),
        h('span', { className: 'qr-pr__title' }, props.title || 'QaReN check',
          props.plan ? h('span', { className: 'qr-pr__plan' }, props.plan) : null),
        placeholder ? h(Badge, { tone: 'placeholder' }, 'Placeholder') : null),
      h('div', { className: 'qr-pr__body' },
        props.summary ? h('p', { className: 'qr-pr__summary' }, props.summary) : null,
        props.steps ? h(StepList, { steps: props.steps }) : null),
      props.artifacts && props.artifacts.length
        ? h('div', { className: 'qr-pr__foot' }, props.artifacts.map(function (a, i) {
            return h('a', { key: i, className: 'qr-link', href: a.href || '#' }, a.label);
          }))
        : null);
  }

  function LedgerRow(props) {
    var st = STATUS_WORD[props.status] ? props.status : 'pending';
    return h('div', { className: cx('qr-ledger-row', 'qr-ledger-row--' + st, props.className), role: 'row' },
      h('span', { className: 'qr-ledger-row__i', role: 'cell' }, props.index),
      h(Mark, { status: st }),
      h('span', { className: 'qr-ledger-row__action', role: 'cell' }, props.action),
      h('span', { className: 'qr-ledger-row__target', role: 'cell', title: typeof props.target === 'string' ? props.target : undefined }, props.target),
      h('span', { className: 'qr-ledger-row__dur', role: 'cell' }, props.duration || ''),
      h('span', { className: cx('qr-status', 'qr-status--' + st), role: 'cell' }, STATUS_WORD[st]));
  }


  // ---- logo: the cursor Q. Ring in currentColor (text), cursor block in accent ----
  var RING = 'M38 49H23A13 13 0 0 1 10 36V20A13 13 0 0 1 23 7H39A13 13 0 0 1 52 20V33';
  var WORD = 'M94.88219178082191 55.62328767123287 89.35753424657534 46.5 90.32054794520548 46.95616438356164Q90.11780821917809 46.95616438356164 89.83904109589042 46.98150684931507Q89.56027397260274 47.00684931506849 89.20547945205479 47.00684931506849Q85.70821917808219 47.00684931506849 83.09794520547945 45.638356164383566Q80.4876712328767 44.26986301369863 79.0431506849315 41.78630136986301Q77.5986301369863 39.3027397260274 77.5986301369863 36.00821917808219V19.991780821917807Q77.5986301369863 16.646575342465752 79.0431506849315 14.18835616438356Q80.4876712328767 11.730136986301368 83.09794520547945 10.361643835616437Q85.70821917808219 8.993150684931507 89.20547945205479 8.993150684931507Q92.75342465753425 8.993150684931507 95.33835616438357 10.361643835616437Q97.92328767123288 11.730136986301368 99.36780821917809 14.18835616438356Q100.81232876712329 16.646575342465752 100.81232876712329 19.991780821917807V36.00821917808219Q100.81232876712329 39.35342465753425 99.36780821917809 41.86232876712329Q97.92328767123288 44.37123287671233 95.2876712328767 45.68904109589041L101.31917808219178 55.62328767123287ZM89.20547945205479 41.78630136986301Q91.94246575342466 41.78630136986301 93.41232876712328 40.24041095890411Q94.88219178082191 38.6945205479452 94.88219178082191 36.00821917808219V19.991780821917807Q94.88219178082191 17.254794520547946 93.36164383561643 15.708904109589042Q91.84109589041095 14.163013698630138 89.20547945205479 14.163013698630138Q86.56986301369864 14.163013698630138 85.04931506849316 15.708904109589042Q83.52876712328768 17.254794520547946 83.52876712328768 19.991780821917807V36.00821917808219Q83.52876712328768 38.6945205479452 85.02397260273973 40.24041095890411Q86.51917808219179 41.78630136986301 89.20547945205479 41.78630136986301ZM116.67671232876712 47.00684931506849Q112.36849315068494 47.00684931506849 109.85958904109589 44.7513698630137Q107.35068493150685 42.49589041095891 107.35068493150685 38.59315068493151Q107.35068493150685 34.53835616438356 110.06232876712329 32.30821917808219Q112.77397260273973 30.078082191780823 117.58904109589041 30.078082191780823H124.93835616438356V27.594520547945205Q124.93835616438356 25.465753424657535 123.56986301369864 24.249315068493154Q122.2013698630137 23.03287671232877 119.76849315068493 23.03287671232877Q117.58904109589041 23.03287671232877 116.1445205479452 23.97054794520548Q114.7 24.90821917808219 114.44657534246576 26.53013698630137H108.66849315068494Q109.12465753424658 22.67808219178082 112.19109589041096 20.397260273972602Q115.25753424657535 18.116438356164384 119.92054794520548 18.116438356164384Q124.98904109589041 18.116438356164384 127.92876712328768 20.65068493150685Q130.86849315068494 23.184931506849313 130.86849315068494 27.543835616438358V46.5H125.09041095890412V41.532876712328765H124.12739726027398L125.14109589041097 40.31643835616438Q125.14109589041097 43.40821917808219 122.8095890410959 45.20753424657534Q120.47808219178083 47.00684931506849 116.67671232876712 47.00684931506849ZM118.55205479452056 42.54657534246575Q121.33972602739726 42.54657534246575 123.1390410958904 41.10205479452055Q124.93835616438356 39.657534246575345 124.93835616438356 37.42739726027397V33.87945205479452H117.69041095890411Q115.66301369863014 33.87945205479452 114.44657534246576 35.019863013698625Q113.23013698630137 36.16027397260274 113.23013698630137 38.086301369863016Q113.23013698630137 40.16438356164384 114.64931506849315 41.355479452054794Q116.06849315068493 42.54657534246575 118.55205479452056 42.54657534246575ZM138.87671232876713 46.5V9.5H150.53424657534248Q154.13287671232877 9.5 156.79383561643834 10.843150684931508Q159.45479452054795 12.186301369863017 160.9246575342466 14.644520547945207Q162.3945205479452 17.102739726027398 162.3945205479452 20.397260273972602Q162.3945205479452 24.0972602739726 160.5191780821918 26.859589041095887Q158.64383561643837 29.621917808219177 155.45068493150686 30.73698630136986L162.9013698630137 46.5H156.26164383561644L149.6219178082192 31.54794520547945H144.75616438356164V46.5ZM144.75616438356164 26.327397260273973H150.53424657534248Q153.22054794520548 26.327397260273973 154.81712328767122 24.78150684931507Q156.413698630137 23.235616438356164 156.413698630137 20.54931506849315Q156.413698630137 17.863013698630137 154.81712328767122 16.291780821917808Q153.22054794520548 14.720547945205478 150.53424657534248 14.720547945205478H144.75616438356164ZM180.43835616438355 47.00684931506849Q176.9917808219178 47.00684931506849 174.40684931506848 45.663698630136984Q171.82191780821918 44.320547945205476 170.4027397260274 41.86232876712329Q168.9835616438356 39.4041095890411 168.9835616438356 36.16027397260274V28.96301369863014Q168.9835616438356 25.71917808219178 170.4027397260274 23.26095890410959Q171.82191780821918 20.802739726027397 174.40684931506848 19.45958904109589Q176.9917808219178 18.116438356164384 180.43835616438355 18.116438356164384Q183.93561643835616 18.116438356164384 186.49520547945207 19.45958904109589Q189.05479452054794 20.802739726027397 190.4739726027397 23.26095890410959Q191.8931506849315 25.71917808219178 191.8931506849315 28.96301369863014V33.98082191780822H174.66027397260274V36.16027397260274Q174.66027397260274 39.15068493150685 176.1554794520548 40.721917808219175Q177.65068493150685 42.293150684931504 180.4890410958904 42.293150684931504Q182.76986301369863 42.293150684931504 184.163698630137 41.48219178082192Q185.55753424657533 40.67123287671233 185.91232876712328 39.201369863013696H191.74109589041095Q191.08219178082192 42.74931506849315 187.9904109589041 44.87808219178082Q184.8986301369863 47.00684931506849 180.43835616438355 47.00684931506849ZM186.2164383561644 30.534246575342465V28.96301369863014Q186.2164383561644 25.972602739726028 184.77191780821917 24.376027397260273Q183.32739726027395 22.779452054794522 180.43835616438355 22.779452054794522Q177.65068493150685 22.779452054794522 176.1554794520548 24.4013698630137Q174.66027397260274 26.023287671232875 174.66027397260274 28.96301369863014V30.12876712328767L186.62191780821917 30.078082191780823ZM199.54657534246573 46.5V9.5H206.84520547945203L217.3876712328767 39.80958904109589Q217.286301369863 38.28904109589041 217.10890410958902 36.18561643835616Q216.93150684931504 34.082191780821915 216.83013698630134 31.826712328767123Q216.72876712328764 29.57123287671233 216.72876712328764 27.797260273972604V9.5H222.15205479452052V46.5H214.85342465753422L204.3616438356164 16.19041095890411Q204.51369863013696 17.55890410958904 204.64041095890408 19.586301369863016Q204.7671232876712 21.613698630136987 204.8684931506849 23.767808219178082Q204.9698630136986 25.921917808219177 204.9698630136986 27.746575342465754V46.5Z';
  function Logo(props) {
    var lockup = props.variant === 'lockup';
    var hgt = props.size || 32;
    var vw = lockup ? 230 : 64;
    var mono = props.mono;
    return h('svg', {
      className: cx('qr-logo', props.className), width: hgt * vw / 64, height: hgt, viewBox: '0 0 ' + vw + ' 64',
      role: 'img', 'aria-label': 'QaReN'
    },
      h('path', { d: RING, fill: 'none', stroke: 'currentColor', strokeWidth: 7 }),
      h('rect', { x: 43, y: 38, width: 14, height: 22, rx: 3, fill: mono ? 'currentColor' : 'var(--accent)' }),
      lockup ? h('path', { d: WORD, fill: 'currentColor' }) : null);
  }

  // ---- core ----
  function Wordmark(props) {
    return h(props.href ? 'a' : 'span', {
      className: cx('qr-wordmark', props.className), href: props.href, style: props.size ? { fontSize: props.size } : undefined, 'aria-label': 'QaReN'
    }, 'QaReN', props.cursor ? h('span', { className: cx('qr-cursor', props.blink ? 'qr-cursor--blink' : null), 'aria-hidden': 'true' }) : null);
  }

  function Button(props) {
    var cls = cx('qr-btn', 'qr-btn--' + (props.variant || 'secondary'), props.size === 'sm' ? 'qr-btn--sm' : null, props.className);
    if (props.href) {
      if (props.disabled) return h('a', { className: cls, 'aria-disabled': 'true', tabIndex: -1 }, props.children);
      return h('a', { className: cls, href: props.href, onClick: props.onClick }, props.children);
    }
    return h('button', { className: cls, type: props.type || 'button', disabled: props.disabled, onClick: props.onClick }, props.children);
  }

  function Link(props) {
    return h('a', { className: cx('qr-link', props.muted ? 'qr-link--muted' : null, props.className), href: props.href || '#' }, props.children);
  }

  function InlineCode(props) {
    return h('code', { className: cx('qr-code-inline', props.className) }, props.children);
  }

  function Badge(props) {
    return h('span', { className: cx('qr-badge', props.tone && props.tone !== 'neutral' ? 'qr-badge--' + props.tone : null, props.className) }, props.children);
  }

  function CodeBlock(props) {
    var lines = String(props.code || '').replace(/\n$/, '').split('\n');
    return h('div', { className: cx('qr-codeblock', props.className) },
      (props.title || props.placeholder)
        ? h('div', { className: 'qr-codeblock__head' }, h('span', null, props.title || ''), props.placeholder ? h(Badge, { tone: 'placeholder' }, 'Placeholder') : null)
        : null,
      h('pre', null, h('code', null, lines.map(function (l, i) {
        var c = props.comments !== false && /^\s*(#|\/\/)/.test(l);
        return h(React.Fragment, { key: i }, h('span', { className: c ? 'qr-comment' : undefined }, l), i < lines.length - 1 ? '\n' : null);
      }))));
  }

  function TerminalPane(props) {
    var placeholder = props.placeholder !== false;
    var lines = props.lines || [];
    return h('div', { className: cx('qr-terminal', props.float ? 'qr-terminal--float' : null, props.className) },
      h('div', { className: 'qr-terminal__bar' },
        h('span', { className: 'qr-terminal__dot' }), h('span', { className: 'qr-terminal__dot' }), h('span', { className: 'qr-terminal__dot' }),
        h('span', { className: 'qr-terminal__title' }, props.title || 'terminal'),
        placeholder ? h(Badge, { tone: 'placeholder' }, 'Placeholder output') : null),
      h('pre', null, lines.map(function (l, i) {
        var kind = l.kind || 'out';
        var last = i === lines.length - 1;
        return h('span', { key: i, className: cx('qr-line', 'qr-line--' + kind) },
          kind === 'cmd' ? h('span', { className: 'qr-prompt' }, '$ ') : null,
          l.text,
          last && props.cursor ? h('span', { className: 'qr-cursor qr-cursor--blink', 'aria-hidden': 'true', style: { marginLeft: '0.2em' } }) : null);
      })));
  }

  function Card(props) {
    return h(props.href ? 'a' : 'div', { className: cx('qr-card', props.className), href: props.href },
      props.kicker ? h('p', { className: 'qr-card__kicker' }, props.kicker) : null,
      props.title ? h('h3', { className: 'qr-card__title' }, props.title) : null,
      props.children ? h('div', { className: 'qr-card__body' }, props.children) : null);
  }

  var CALLOUT_LABEL = { note: 'Note', caution: 'Caution', danger: 'Danger' };
  function Callout(props) {
    var tone = CALLOUT_LABEL[props.tone] ? props.tone : 'note';
    return h('aside', { className: cx('qr-callout', 'qr-callout--' + tone, props.className) },
      h('p', { className: 'qr-callout__title' }, h('span', { className: 'qr-callout__label' }, CALLOUT_LABEL[tone]), props.title || null),
      h('p', null, props.children));
  }

  function Table(props) {
    var cols = props.columns || [];
    return h('div', { className: cx('qr-table-wrap', props.className) },
      h('table', { className: 'qr-table' },
        props.caption ? h('caption', { style: { position: 'absolute', left: '-9999px' } }, props.caption) : null,
        h('thead', null, h('tr', null, cols.map(function (c, i) { return h('th', { key: i, scope: 'col' }, c.label); }))),
        h('tbody', null, (props.rows || []).map(function (r, ri) {
          return h('tr', { key: ri }, cols.map(function (c, ci) {
            return h('td', { key: ci, className: c.numeric ? 'qr-num' : undefined }, r[c.key]);
          }));
        }))));
  }

  function NavBar(props) {
    return h('nav', { className: cx('qr-nav', props.className), 'aria-label': 'Main' },
      h('a', { href: props.homeHref || '#', className: 'qr-nav__home', 'aria-label': 'QaReN home' }, h(Logo, { variant: 'lockup', size: 26 })),
      h('ul', { className: 'qr-nav__links' }, (props.links || []).map(function (l, i) {
        return h('li', { key: i }, h('a', { className: 'qr-nav__link', href: l.href || '#', 'aria-current': l.active ? 'page' : undefined }, l.label));
      })),
      props.action || null);
  }

  function Footer(props) {
    return h('footer', { className: cx('qr-footer', props.className) },
      h(Wordmark, null),
      h('span', null, props.note || 'Open source under the MIT license.'),
      h('ul', { className: 'qr-footer__links' }, (props.links || []).map(function (l, i) {
        return h('li', { key: i }, h('a', { className: 'qr-link qr-link--muted', href: l.href || '#' }, l.label));
      })));
  }

  window.QaReN = {
    Logo: Logo,
    VerdictPill: VerdictPill, StepList: StepList, VideoProofCard: VideoProofCard, PRCommentSummary: PRCommentSummary, LedgerRow: LedgerRow,
    Wordmark: Wordmark, Button: Button, Link: Link, CodeBlock: CodeBlock, InlineCode: InlineCode, TerminalPane: TerminalPane,
    Card: Card, Badge: Badge, Callout: Callout, Table: Table, NavBar: NavBar, Footer: Footer
  };
})();
