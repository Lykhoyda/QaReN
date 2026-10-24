import type { Element, EvidenceStatus, Kind, NativeNode, Screen } from './screen.js';
import { ancestorsOf, elementFrame } from './screen.js';

export const WITHHOLD_CAUSES = [
  'runtime-input',
  'concealed-fill',
  'secure-field',
  'input-value',
  'generic-value',
  'code-row',
  'echo',
] as const;
export type WithholdCause = (typeof WITHHOLD_CAUSES)[number];
export const MEDIA_KINDS = [
  'input',
  'other',
  'text',
  'button',
  'cell',
  'image',
  'switch',
  'link',
] as const satisfies readonly Kind[];
export const MEDIA_SOURCES = [
  'typed',
  'observed',
  'concealed',
  'secret',
  'code',
  'input',
] as const satisfies readonly Provenance[];
export interface MediaLatch {
  reason: WithholdCause;
  kind?: Kind;
  source?: Provenance;
}

export const MASK = '•••';
export const SCREEN_TEXT_WITHHELD = '[screen text withheld: a secure field is on screen]';

export function concealsScreen(screen: Screen): boolean {
  return screen.elements.some((element) => element.secure);
}

interface InputPrivacy {
  values: string[];
  nativeLabelMayBeValue: boolean;
  checkSubject: EvidenceStatus;
}

const inputPrivacy = new WeakMap<Element, InputPrivacy>();
interface PrivateSubject {
  names: string[];
  uncertain: boolean;
  unassociated: boolean;
}

const privateScreens = new WeakMap<
  Screen,
  {
    values: string[];
    secrets: string[];
    subjects: PrivateSubject[];
    sensitivePixels: boolean;
    cause?: MediaLatch;
  }
>();
const uncertainPrivateInputs = new WeakSet<Element>();

export function capturePrivateScreen(
  screen: Screen,
  facts: {
    values: readonly string[];
    secure: boolean;
    testID?: string;
    elements: Element[];
    associationUnique: boolean;
    labelMayBeValue?: boolean;
  }[],
): void {
  const values = new Set<string>();
  const add = (value: string): void => {
    if (value) values.add(value);
    if (value.trim()) values.add(value.trim());
  };
  const secrets = new Set<string>();
  const subjects: PrivateSubject[] = [];
  let unassociatedSecure = false;
  for (const fact of facts) {
    fact.values.forEach(add);
    if (fact.secure) fact.values.filter(Boolean).forEach((value) => secrets.add(value));
    const uncertain =
      fact.secure || !fact.associationUnique || inputCheckSubject(fact.elements[0]) !== 'supported';
    subjects.push({
      names: [
        ...new Set(
          [fact.testID, ...fact.elements.flatMap((e) => [e.label, e.placeholder, e.testID])].filter(
            (name): name is string => !!name,
          ),
        ),
      ],
      uncertain,
      unassociated:
        fact.elements.length === 0 ||
        (!fact.associationUnique && !fact.elements.some((e) => e.label || e.placeholder)),
    });
    if (fact.secure) {
      for (const element of fact.elements) {
        for (const value of inputPrivacy.get(element)?.values ?? []) if (value) secrets.add(value);
        if (element.value) secrets.add(element.value);
        if (
          element.label &&
          ((fact.labelMayBeValue ?? fact.secure) || nativeLabelMayBeValue(element))
        )
          secrets.add(element.label);
      }
    }
    if (fact.secure && !fact.associationUnique) unassociatedSecure = true;
    for (const element of fact.elements) {
      if (uncertain) uncertainPrivateInputs.add(element);
      for (const value of inputPrivacy.get(element)?.values ?? []) add(value);
      if (element.value) add(element.value);
      if (
        ((fact.labelMayBeValue ?? fact.secure) || nativeLabelMayBeValue(element)) &&
        element.label
      )
        add(element.label);
    }
  }
  if (unassociatedSecure) {
    for (const element of screen.elements) {
      if (isPossibleInput(element) || element.kind === 'other' || element.value !== undefined) {
        uncertainPrivateInputs.add(element);
        for (const value of inputPrivacy.get(element)?.values ?? []) add(value);
        if (element.value) add(element.value);
        if (element.label) add(element.label);
      }
    }
  }
  const carriers = screen.elements.filter(
    (element) =>
      inputValues({ ...screen, elements: [element] }).length > 0 ||
      facts.some((fact) => fact.elements.includes(element) && fact.values.some(Boolean)),
  );
  const sensitivePixels =
    values.size > 0 ||
    facts.some((fact) => fact.secure) ||
    inputValues(screen).length > 0 ||
    screen.elements.some((element) => element.secure);
  const secure =
    facts.some((fact) => fact.secure) || screen.elements.some((element) => element.secure);
  const input = carriers.some(
    (element) =>
      element.nativeKind === 'input' ||
      element.kind === 'input' ||
      element.semantic?.fill === 'supported',
  );
  const carrier = carriers[0];
  const cause: MediaLatch | undefined = !sensitivePixels
    ? undefined
    : secure
      ? { reason: 'secure-field' }
      : input
        ? { reason: 'input-value' }
        : { reason: 'generic-value', ...(carrier?.nativeKind ? { kind: carrier.nativeKind } : {}) };
  privateScreens.set(screen, {
    values: [...values],
    secrets: [...secrets],
    subjects,
    sensitivePixels,
    cause,
  });
}

export function privateCheckSubjects(screen: Screen): readonly PrivateSubject[] {
  return privateScreens.get(screen)?.subjects ?? [];
}

export function mentionsPrivateValue(screen: Screen, text: string): boolean {
  return privateScreens.get(screen)?.values.some((value) => text.includes(value)) ?? false;
}

export function captureInputPrivacy(element: Element, data: InputPrivacy): void {
  inputPrivacy.set(element, data);
}

export function isPossibleInput(element: Element): boolean {
  return element.kind === 'input' || inputPrivacy.has(element);
}

export function inputCheckSubject(element: Element): EvidenceStatus {
  if (element.secure || uncertainPrivateInputs.has(element)) return 'unknown';
  return (
    inputPrivacy.get(element)?.checkSubject ??
    (element.kind === 'input' ? 'supported' : 'unsupported')
  );
}

// A field whose value is private evidence: native secure, or an input the screen model cannot read safely.
export function isPrivateInput(element: Element): boolean {
  return (
    element.secure || inputCheckSubject(element) === 'unknown' || nativeLabelMayBeValue(element)
  );
}

export function nativeLabelMayBeValue(element: Element): boolean {
  return inputPrivacy.get(element)?.nativeLabelMayBeValue ?? false;
}

// An input label equal to its own or a private value is that value, at any length.
function labelIsValue(element: Element, set: PrivateSet): boolean {
  if (nativeLabelMayBeValue(element)) return true;
  const own = (text: string | undefined) => text?.trim().normalize('NFC');
  const label = own(element.label);
  return (
    !!label &&
    isPossibleInput(element) &&
    [element.value, ...set.values.map((value) => value.text)].some((value) => own(value) === label)
  );
}

export function inputValues(screen: Screen, evidenceOnly = false): string[] {
  return [
    ...new Set([
      ...(privateScreens.get(screen)?.values ?? []),
      ...screen.elements.flatMap((e) => {
        if (!isPossibleInput(e)) return [];
        const data = inputPrivacy.get(e);
        return [
          ...(!evidenceOnly || e.secure
            ? [...(data?.values ?? []).filter(Boolean), ...(e.value ? [e.value] : [])]
            : []),
          ...(data?.nativeLabelMayBeValue && e.label ? [e.label] : []),
        ];
      }),
    ]),
  ];
}

export function redactEvidence(
  screen: Screen,
  text: string,
  typed: readonly string[] = [],
): string {
  const privacy = new ObservedPrivacy(typed);
  privacy.observe(screen);
  return privacy.redact(text);
}

export type Provenance = 'typed' | 'observed' | 'concealed' | 'secret' | 'code' | 'input';

export interface PrivateValue {
  text: string;
  provenance: Provenance;
}

export interface PrivateSet {
  values: readonly PrivateValue[];
  fragments?: readonly string[];
}

export type Policy = 'model' | 'durable' | 'identifier' | 'persisted';

const WORD = '\\p{L}\\p{M}\\p{N}_';
export const SHORT = 3;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const chars = (text: string): number => [...text].length;
const whole = (pattern: string): string => `(?<![${WORD}])${pattern}(?![${WORD}])`;

function forms(value: string): string[] {
  return [
    ...new Set(
      [value, value.trim()].flatMap((form) => [form, form.normalize('NFC'), form.normalize('NFD')]),
    ),
  ].filter(Boolean);
}

const DIGIT_GAP = '[\\s\\p{White_Space}\\p{P}\\p{S}]';
function digitForm(value: string): string | undefined {
  const digits = value.trim().replace(new RegExp(DIGIT_GAP, 'gu'), '');
  if (!/^\d{3,}$/.test(digits)) return undefined;
  return [...digits].join(`${DIGIT_GAP}*`);
}

export function matchPrivate(
  text: string,
  set: PrivateSet,
  policy: Policy,
  token?: (value: string) => string | undefined,
): { text: string; hit: boolean } {
  const rules = set.values
    .flatMap((value) => {
      const length = chars(value.text.trim());
      if (
        length < SHORT &&
        value.provenance !== 'secret' &&
        value.provenance !== 'code' &&
        value.provenance !== 'input'
      )
        return [];
      const candidates = forms(value.text).flatMap((form) =>
        value.provenance === 'input' ? [form, JSON.stringify(form).slice(1, -1)] : [form],
      );
      const patterns = [...new Set(candidates)].map((form) =>
        value.provenance === 'code' || (value.provenance === 'secret' && length === 1)
          ? whole(escape(form))
          : escape(form),
      );
      const digits = digitForm(value.text);
      if (digits) patterns.push(digits);
      return patterns.map((pattern) => ({ pattern, value: value.text }));
    })
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const fragments = (set.fragments ?? []).flatMap(forms);
  if (!rules.length && !fragments.length) return { text, hit: false };
  let hit = false;
  const parts: { text: string; masked: boolean }[] = [];
  let offset = 0;
  if (rules.length) {
    const pattern = new RegExp(rules.map((rule) => `(${rule.pattern})`).join('|'), 'gu');
    for (const match of text.matchAll(pattern)) {
      const index = rules.findIndex((_, i) => match[i + 1] !== undefined);
      parts.push({ text: text.slice(offset, match.index), masked: false });
      parts.push({
        text: policy === 'model' ? (token?.(rules[index].value) ?? MASK) : MASK,
        masked: true,
      });
      offset = match.index + match[0].length;
      hit = true;
    }
  }
  parts.push({ text: text.slice(offset), masked: false });
  const projected = parts
    .map((part) =>
      part.masked
        ? part.text
        : part.text.replace(/\S+/gu, (match) => {
            if (
              !fragments.some((value) => {
                const digits = value.replace(new RegExp(DIGIT_GAP, 'gu'), '');
                if (/^\d+$/u.test(value) || /^\d{3,}$/u.test(digits))
                  return (match.match(/\d+/gu) ?? []).some((candidate) =>
                    digits.includes(candidate),
                  );
                const letters = [...value];
                return letters.some(
                  (_, index) =>
                    index + SHORT <= letters.length &&
                    match.includes(letters.slice(index, index + SHORT).join('')),
                );
              })
            )
              return match;
            hit = true;
            return MASK;
          }),
    )
    .join('');
  return { text: projected, hit };
}

export function planLineBody(text: string): string {
  return text.replace(/^\s*\d+[.)]\s+/, '');
}

export function projectPlanLine(
  text: string,
  set: PrivateSet,
  policy: Policy = 'durable',
  token?: (value: string) => string | undefined,
): { text: string; hit: boolean } {
  const content = planLineBody(text);
  const prefix = text.slice(0, text.length - content.length);
  const projected = matchPrivate(content, set, policy, token);
  let hit = projected.hit;
  const body = projected.text.replace(
    /"([^"\n]*)"|“([^”\n]*)”/g,
    (quoted, straight: string | undefined, curly: string | undefined) => {
      const value = straight ?? curly;
      const entry = set.values.find(
        (entry) =>
          entry.provenance === 'typed' &&
          chars(entry.text.trim()) < SHORT &&
          forms(entry.text).includes(value!),
      );
      if (!entry) return quoted;
      hit = true;
      const replacement = policy === 'model' ? (token?.(entry.text) ?? MASK) : MASK;
      return quoted[0] + replacement + quoted[quoted.length - 1];
    },
  );
  return { text: prefix + body, hit };
}

const subsequence = (needle: string, haystack: string): boolean => {
  let at = 0;
  for (const char of haystack) if (char === [...needle][at]) at += 1;
  return at === [...needle].length;
};

type Frame = NonNullable<ReturnType<typeof elementFrame>>;
const boxText = (element: Element) => element.label || element.value || '';

function boxRows(boxes: Element[], frameOf: (element: Element) => Frame, gap: number): Element[][] {
  const bands: Element[][] = [];
  for (const element of [...boxes].sort((a, b) => frameOf(a).y - frameOf(b).y)) {
    const frame = frameOf(element);
    const band = bands.find((row) => {
      const first = frameOf(row[0]);
      return Math.abs(frame.y + frame.height / 2 - first.y - first.height / 2) <= 4;
    });
    if (band) band.push(element);
    else bands.push([element]);
  }
  return bands.flatMap((band) => {
    band.sort((a, b) => frameOf(a).x - frameOf(b).x);
    const widths = band.map((element) => frameOf(element).width).sort((a, b) => a - b);
    const middle = Math.floor(widths.length / 2);
    const median = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
    const rows: Element[][] = [[]];
    for (const element of band) {
      const row = rows[rows.length - 1];
      const previous = row[row.length - 1];
      const frame = frameOf(element);
      const before = previous && frameOf(previous);
      if (before && (frame.x <= before.x || frame.x - before.x - before.width > gap * median))
        rows.push([element]);
      else row.push(element);
    }
    return rows;
  });
}

// Text boxes by their own frames, plus cells measured by their container; a cell row spelling part of a filled value also counts.
export function codeBoxRows(screen: Screen, filled: readonly string[] = []): Element[][] {
  const visible = (element: Element) =>
    !element.offscreen && (elementFrame(element)?.width ?? 0) > 0;
  const texts = screen.elements.filter(
    (element) => visible(element) && element.kind === 'text' && chars(boxText(element)) <= 1,
  );
  const textBoxes = texts.filter(
    (element) =>
      !ancestorsOf(element).some(
        (ancestor) => texts.includes(ancestor) && boxText(ancestor) === boxText(element),
      ),
  );
  const textRow = (row: Element[]) =>
    row.length >= 3 && row.some((element) => chars(boxText(element)) === 1);
  const own = boxRows(textBoxes, (element) => elementFrame(element)!, 1.5).filter(textRow);
  const labelled = screen.elements.filter(
    (element) =>
      visible(element) &&
      element.kind !== 'text' &&
      element.kind !== 'input' &&
      !element.secure &&
      !element.ref.startsWith('react:') &&
      chars(element.label ?? '') === 1 &&
      !textBoxes.some(
        (inner) => ancestorsOf(inner).includes(element) && boxText(inner) === boxText(element),
      ),
  );
  const occupied = [...textBoxes, ...labelled];
  const cellParents = new Set(
    occupied.flatMap((element) =>
      [element, ...ancestorsOf(element)].flatMap((cell) => ancestorsOf(cell).slice(0, 1)),
    ),
  );
  const emptyCells = screen.elements.filter(
    (element) =>
      visible(element) &&
      (element.kind === 'other' || element.kind === 'button') &&
      !element.secure &&
      !element.ref.startsWith('react:') &&
      !boxText(element) &&
      cellParents.has(ancestorsOf(element)[0]) &&
      !occupied.some((box) => ancestorsOf(box).includes(element)),
  );
  const boxes = [...occupied, ...emptyCells];
  // A glyph-width Text inside a code cell is measured by its cell: the outermost framed ancestor holding no other box.
  const cellFrames = (boxes: Element[]) =>
    new Map(
      boxes.map((element) => {
        const frame = elementFrame(element)!;
        const ancestors = ancestorsOf(element);
        const shared = ancestors.findIndex((ancestor) =>
          boxes.some((other) => other !== element && ancestorsOf(other).includes(ancestor)),
        );
        const cell = ancestors
          .slice(0, shared < 0 ? ancestors.length : shared)
          .filter((ancestor) => elementFrame(ancestor) !== undefined)
          .at(-1);
        const outer = cell && elementFrame(cell)!;
        const contains =
          outer &&
          outer.width > 0 &&
          outer.x <= frame.x &&
          outer.y <= frame.y &&
          outer.x + outer.width >= frame.x + frame.width &&
          outer.y + outer.height >= frame.y + frame.height;
        return [element, contains ? outer : frame];
      }),
    );
  // Evenly spread cells (space-between on a wide phone) can sit up to two cell widths apart.
  const originalCells = cellFrames(occupied);
  const original = boxRows(occupied, (element) => originalCells.get(element)!, 2).filter((row) => {
    if (row.every((element) => element.kind === 'text')) return textRow(row);
    const spelled = row.map(boxText).join('');
    return (
      chars(spelled) >= 2 && filled.some((value) => subsequence(spelled, value.replace(/\s/gu, '')))
    );
  });
  const cells = cellFrames(boxes);
  const spread = boxRows(boxes, (element) => cells.get(element)!, 2).filter((row) => {
    const spelled = row.map(boxText).join('');
    return (
      row.length >= 2 &&
      chars(spelled) >= 1 &&
      filled.some((value) => subsequence(spelled, value.replace(/\s/gu, '')))
    );
  });
  const partialCovered = new Set(spread.flat());
  const rows = [
    ...spread,
    ...original.filter((row) => !row.every((element) => partialCovered.has(element))),
  ];
  const covered = new Set(rows.flat());
  return [...rows, ...own.filter((row) => !row.every((element) => covered.has(element)))];
}

const NATIVE_TYPES = new Set([
  'Application',
  'Window',
  'Other',
  'Group',
  'StaticText',
  'Button',
  'Link',
  'Image',
  'Icon',
  'Cell',
  'Table',
  'CollectionView',
  'ScrollView',
  'TextField',
  'SecureTextField',
  'SearchField',
  'TextView',
  'Switch',
  'Toggle',
  'Slider',
  'Stepper',
  'Picker',
  'PickerWheel',
  'DatePicker',
  'SegmentedControl',
  'PageIndicator',
  'ProgressIndicator',
  'ActivityIndicator',
  'NavigationBar',
  'TabBar',
  'Toolbar',
  'Keyboard',
  'Key',
  'WebView',
  'Map',
  'Alert',
  'Sheet',
]);
export const SYSTEM_SCROLL_BAR_LABEL =
  /^(vertical|horizontal)\s+scroll\s+bar(?:,?\s*\d+\s+pages?)?$/i;
const BARE_PERCENT = /^\d{1,3}%$/;
// iOS may add one decimal digit and a (narrow) no-break space before %.
export const SCROLL_BAR_PERCENT = /^\d{1,3}(?:[.,]\d)?\s?%$/;
// The sink adds the 12-byte `qaren-core: ` prefix and a newline, keeping each line within 512 bytes.
const SENSITIVE_PIXELS_LIMIT = 499;
const SHAPE_LIMIT = 4;

const shapeType = (type: string | undefined): string =>
  type !== undefined && (NATIVE_TYPES.has(type) || /^Element\(\d{1,3}\)$/.test(type))
    ? type
    : 'unlisted';

function labelClass(label: string | undefined): string {
  const text = label?.trim();
  if (!text) return 'none';
  if (SYSTEM_SCROLL_BAR_LABEL.test(text)) return 'sb-exact';
  return /scroll\s*bar/i.test(text) ? 'sb-loose' : 'other';
}

function valueClass(value: string | undefined): string {
  if (value === undefined) return 'none';
  if (BARE_PERCENT.test(value)) return 'pct';
  if (/^\d{1,3}(?:[.,]\d+)?\s*%$/.test(value)) return 'pct-loose';
  if (/^[-+]?\d+$/.test(value)) return 'int';
  return /^[-+]?\d*[.,]\d+$/.test(value) ? 'dec' : 'text';
}

function lengthBucket(length: number): string {
  if (length <= 1) return String(length);
  return length <= 3 ? '2-3' : length <= 8 ? '4-8' : '9+';
}

// Value-free counts and shapes observe the stored verdict without changing privacy decisions.
export function sensitivePixelsReasons(
  screen: Screen,
  nodes: readonly NativeNode[],
): string | undefined {
  const stored = privateScreens.get(screen);
  if (stored?.sensitivePixels !== true) return undefined;
  const values = new Set(stored.values);
  const nodeOf = new Map(nodes.map((node) => [node.ref, node]));
  const nodeAt = new Map(nodes.map((node) => [node.index, node]));
  const carriers = new Map<string | undefined, number>();
  const shapes: unknown[][] = [];
  for (const element of screen.elements) {
    const carrier =
      (element.value !== undefined && values.has(element.value)) ||
      ((element.secure || nativeLabelMayBeValue(element)) &&
        element.label !== undefined &&
        values.has(element.label));
    if (!carrier) continue;
    const node = nodeOf.get(element.ref);
    carriers.set(node?.type, (carriers.get(node?.type) ?? 0) + 1);
    const parent = node?.parentIndex === undefined ? undefined : nodeAt.get(node.parentIndex);
    shapes.push([
      shapeType(node?.type),
      labelClass(node?.label),
      valueClass(element.value),
      lengthBucket(element.value?.length ?? 0),
      node?.rect ? Math.round(node.rect.width) : null,
      node?.rect ? Math.round(node.rect.height) : null,
      parent ? shapeType(parent.type) : 'none',
      element.testID ? 1 : 0,
      element.value === undefined
        ? 'label'
        : element.value === node?.value?.trim()
          ? 'native'
          : 'react',
    ]);
  }
  return formatSensitivePixels(
    stored.values.length,
    screen.elements.filter((element) => element.secure).length,
    inputValues(screen).length,
    carriers,
    shapes,
  );
}

export function formatSensitivePixels(
  r1: number,
  secure: number,
  r3: number,
  carriers: Iterable<readonly [string | undefined, number]>,
  allShapes: readonly (readonly unknown[])[] = [],
): string {
  const counts = new Map<string, number>();
  for (const [raw, count] of carriers) {
    const type = raw !== undefined && NATIVE_TYPES.has(raw) ? raw : 'Other';
    counts.set(type, (counts.get(type) ?? 0) + count);
  }
  const types = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  let omittedTypes = 0;
  const shapes = allShapes.slice(0, SHAPE_LIMIT);
  const line = () =>
    `sensitive-pixels ${JSON.stringify({
      v: 1,
      r1,
      secure,
      r3,
      types,
      omittedTypes,
      shapes,
      omittedShapes: allShapes.length - shapes.length,
    })}`;
  let text = line();
  while (
    Buffer.byteLength(text, 'utf8') > SENSITIVE_PIXELS_LIMIT &&
    (shapes.length || types.length)
  ) {
    if (shapes.length) shapes.pop();
    else {
      types.pop();
      omittedTypes++;
    }
    text = line();
  }
  return text;
}

export class ObservedPrivacy {
  private readonly inputValues = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly concealed = new Set<string>();
  private readonly secret = new Set<string>();
  private readonly preclassified: string[] = [];
  private readonly filledValues = new Set<string>();
  private readonly provenCodes = new Set<string>();
  private filled = false;
  private readonly codeRows = new WeakMap<Screen, Element[][]>();
  private readonly codeElements = new WeakSet<Element>();
  private sensitivePixels = false;
  private sensitiveInWindow = false;
  private sensitiveLatest = false;
  private firstLatch?: MediaLatch;
  private windowLatch?: MediaLatch;
  private latestLatch?: MediaLatch;
  // Fields typed into without a readable value, by any identity ('' is any input); only a seen field can leave.
  private readonly concealedFields = new Set<{ ids: string[]; seen: boolean }>();
  private shown: Element[] = [];

  constructor(private readonly typed: readonly string[] = []) {}

  // Plan values known before the walk (fills, a configured login block) are typed before anything streams.
  classify(values: readonly string[]): void {
    this.preclassified.push(...values.filter(Boolean));
  }

  classifyInputs(values: readonly string[]): void {
    values.filter(Boolean).forEach((value) => this.inputValues.add(value));
    if (this.inputValues.size) this.mark({ reason: 'runtime-input' });
  }

  assertInputHashSafe(text: string, values: Iterable<string> = this.inputValues): boolean {
    return !matchPrivate(
      text,
      {
        values: [...values].flatMap((value) =>
          forms(value)
            .flatMap((form) => [form, JSON.stringify(form).slice(1, -1)])
            .map((text) => ({ text, provenance: 'input' as const })),
        ),
      },
      'persisted',
    ).hit;
  }

  observe(screen: Screen): void {
    this.sensitiveLatest = false;
    this.latestLatch = undefined;
    this.shown = screen.elements.filter((element) => !element.offscreen);
    for (const field of this.concealedFields)
      if (this.showing(field.ids)) field.seen = true;
      else if (field.seen) this.concealedFields.delete(field);
    if (this.concealedFields.size > 0) this.mark({ reason: 'concealed-fill' });
    const cause = privateScreens.get(screen)?.cause;
    if (cause) this.mark(cause);
    for (const value of privateScreens.get(screen)?.secrets ?? []) this.secret.add(value);
    for (const value of inputValues(screen)) this.observed.add(value);
    for (const value of inputValues(screen, true)) this.concealed.add(value);
    if (this.filled) {
      const rows = codeBoxRows(
        screen,
        this.privateSet().values.map((value) => value.text),
      );
      this.codeRows.set(screen, rows);
      for (const value of this.filledValues)
        if (chars(value) < SHORT && rows.some((row) => row.map(boxText).join('') === value))
          this.provenCodes.add(value);
      const boxes = rows.flat();
      for (const element of screen.elements) {
        const members = boxes.filter((box) => ancestorsOf(box).includes(element));
        const text = element.label || element.value || '';
        const merged =
          members.length > 0 &&
          text.replace(new RegExp(DIGIT_GAP, 'gu'), '') ===
            members.map((box) => box.label || box.value || '').join('');
        const echo = boxes.some(
          (box) => ancestorsOf(element).includes(box) && text === (box.label || box.value || ''),
        );
        if (boxes.includes(element) || echo || merged) this.codeElements.add(element);
      }
      if (rows.length > 0) this.mark({ reason: 'code-row' });
    }
    for (const element of screen.elements)
      if (element.secure) {
        for (const value of inputPrivacy.get(element)?.values ?? []) this.secret.add(value);
        if (element.value) this.secret.add(element.value);
        if (nativeLabelMayBeValue(element) && element.label) this.secret.add(element.label);
      }
    const text = [
      ...screen.visibleText,
      ...screen.elements
        .filter((element) => !element.offscreen && !element.ref.startsWith('react:'))
        .flatMap((element) => [element.label ?? '', element.value ?? '']),
    ];
    const values = this.privateSet();
    const folded = text.map((line) => line.normalize('NFC').toLowerCase());
    const match = values.values.find(
      (value) =>
        text.some(
          (line) =>
            matchPrivate(
              line,
              {
                values: [value],
                fragments: values.fragments?.filter((fragment) => fragment === value.text),
              },
              'persisted',
            ).hit,
        ) ||
        (chars(value.text.trim()) < SHORT &&
          forms(value.text).some((form) => text.some((line) => line.includes(form)))) ||
        (chars(value.text.trim()) >= SHORT &&
          folded.some((line) => line.includes(value.text.trim().normalize('NFC').toLowerCase()))),
    );
    if (
      text.some((line) => matchPrivate(line, values, 'persisted').hit) ||
      values.values.some(
        (value) =>
          chars(value.text.trim()) < SHORT &&
          forms(value.text).some((form) => text.some((line) => line.includes(form))),
      ) ||
      values.values.some(
        (value) =>
          chars(value.text.trim()) >= SHORT &&
          folded.some((line) => line.includes(value.text.trim().normalize('NFC').toLowerCase())),
      )
    )
      this.mark({ reason: 'echo', ...(match ? { source: match.provenance } : {}) });
  }

  didFill(value?: string): void {
    this.filled = true;
    if (value) this.filledValues.add(value);
  }

  concealFallback(value: string, secure = false, ...fields: (string | undefined)[]): void {
    const ids = fields.filter((field): field is string => Boolean(field));
    if (ids.length === 0) ids.push('');
    this.concealedFields.add({ ids, seen: this.showing(ids) });
    this.concealed.add(value);
    if (secure) this.secret.add(value);
    this.mark({ reason: 'concealed-fill' });
  }

  private showing(ids: readonly string[]): boolean {
    return this.shown.some((element) =>
      ids.some((id) =>
        id
          ? element.testID === id || element.label === id
          : element.kind === 'input' || isPrivateInput(element),
      ),
    );
  }

  private mark(latch: MediaLatch): void {
    this.firstLatch ??= latch;
    this.windowLatch ??= latch;
    this.latestLatch ??= latch;
    this.sensitivePixels = true;
    this.sensitiveInWindow = true;
    this.sensitiveLatest = true;
  }

  latched(): MediaLatch | undefined {
    return this.firstLatch;
  }

  windowLatched(): MediaLatch | undefined {
    return this.windowLatch;
  }

  canScreenshot(): boolean {
    return !this.sensitivePixels;
  }

  // The published video starts here, still showing the latest screen; screenshots keep the run-wide flag.
  startWindow(): void {
    this.sensitiveInWindow = this.sensitiveLatest;
    this.windowLatch = this.latestLatch;
  }

  windowClean(): boolean {
    return !this.sensitiveInWindow;
  }

  privateSet(policy: Policy = 'durable'): PrivateSet {
    const tagged = (values: Iterable<string>, provenance: Provenance): PrivateValue[] =>
      [...new Set(values)].filter(Boolean).map((text) => ({ text, provenance }));
    // Persisted decisions match slot values whole; fragments only over-mask output.
    const fragmentable = (value: string): boolean =>
      policy !== 'persisted' || !this.inputValues.has(value);
    return {
      fragments: [
        ...[...this.inputValues].filter(fragmentable),
        ...[...this.filledValues].filter(
          (value) =>
            fragmentable(value) &&
            (/^\d{3,}$/u.test(value.replace(new RegExp(DIGIT_GAP, 'gu'), '')) ||
              this.secret.has(value)),
        ),
      ],
      values: [
        ...tagged(this.inputValues, 'input'),
        ...tagged(this.provenCodes, 'code'),
        ...tagged(this.secret, 'secret'),
        ...tagged(this.concealed, 'concealed'),
        ...tagged([...this.typed, ...this.preclassified], 'typed'),
        ...tagged(this.observed, 'observed'),
      ],
    };
  }

  modelValues(): string[] {
    return [...this.inputValues, ...this.typed, ...this.preclassified, ...this.observed];
  }

  maskForModel(values: readonly string[], source: readonly string[]): ModelMask {
    return modelMask(values, source, this.privateSet(), this.codeElements);
  }

  redactIdentifier(text: string): string {
    return matchPrivate(text, this.privateSet(), 'identifier').text;
  }

  redact(text: string): string {
    return matchPrivate(text, this.privateSet(), 'durable').text;
  }

  screenText(screen: Screen): string[] {
    if (concealsScreen(screen)) return [SCREEN_TEXT_WITHHELD];
    const rows = this.codeRows.get(screen) ?? [];
    const first = new Set(rows.map((row) => row[0]));
    const represented = new Set<string>();
    const projected: string[] = [];
    const set = this.privateSet();
    for (const element of screen.elements) {
      if (
        element.offscreen ||
        element.ref.startsWith('react:') ||
        element.kind === 'image' ||
        (element.kind === 'other' && !this.codeElements.has(element))
      )
        continue;
      if (element.label) represented.add(element.label);
      if (element.value) represented.add(element.value);
      if (isPossibleInput(element) && element.value !== undefined)
        represented.add(
          `${element.label ?? element.placeholder ?? element.testID ?? 'input'}: ${element.value}`,
        );
      if (this.codeElements.has(element)) {
        if (first.has(element)) projected.push('[code]');
        continue;
      }
      const mirrored = labelIsValue(element, set);
      const label = mirrored
        ? MASK
        : (element.label ?? element.placeholder ?? element.testID ?? 'input');
      const text =
        isPossibleInput(element) && element.value !== undefined
          ? `${label}: ${MASK}`
          : mirrored
            ? MASK
            : element.label;
      if (text) projected.push(this.redact(text));
    }
    return [
      ...projected,
      ...screen.visibleText
        .filter((text) => !represented.has(text))
        .map((text) => this.redact(text)),
    ];
  }
}

export interface ModelMask {
  tokens: string[];
  apply(text: string): string;
  applyPlanLine(text: string): string;
  describeElement(element: Element, render: (element: Element) => string): string;
}

export function modelMask(
  values: readonly string[],
  source: readonly string[],
  set: PrivateSet = { values: [] },
  codeElements = new WeakSet<Element>(),
): ModelMask {
  const unique = [
    ...new Set([...values, ...set.values.map((value) => value.text)].filter(Boolean)),
  ];
  let prefix = 'QAREN_VALUE';
  while (source.some((text) => text.includes(`[${prefix}_`))) prefix += '_';
  const owner = (value: string): string => value.trim().normalize('NFC');
  const owners = [...new Set(unique.map(owner))];
  const tokens = owners.map((_, i) => `[${prefix}_${i + 1}]`);
  const replacements = new Map(
    unique.flatMap((value) =>
      forms(value).map((form) => [form, tokens[owners.indexOf(owner(value))]]),
    ),
  );
  const listed = new Set(set.values.map((value) => value.text));
  const all: PrivateSet = {
    ...set,
    values: [
      ...set.values,
      ...unique
        .filter((value) => !listed.has(value))
        .map((text) => ({ text, provenance: 'observed' as const })),
    ],
  };
  // Tokens already in the text are shielded by digit-free placeholders so no value rule rewrites them.
  const guard = (i: number): string => String.fromCharCode(0xe001, 0xe100 + i, 0xe001);
  const maskText = (text: string): string => {
    const opaque = tokens.filter((token) => text.includes(token));
    let guarded = text;
    opaque.forEach((token, i) => (guarded = guarded.split(token).join(guard(i))));
    const masked = matchPrivate(
      guarded,
      all,
      'model',
      (match) => replacements.get(match) ?? replacements.get(match.trim()),
    ).text;
    return opaque.reduce((out, token, i) => out.split(guard(i)).join(token), masked);
  };
  return {
    tokens: [...new Set(values.filter(Boolean).map((value) => replacements.get(value)!))],
    apply: maskText,
    applyPlanLine: (text) =>
      projectPlanLine(
        text,
        {
          ...all,
          values: all.values.map((entry) =>
            entry.provenance === 'secret' || entry.provenance === 'code'
              ? entry
              : { ...entry, provenance: 'typed' as const },
          ),
        },
        'model',
        (value) => replacements.get(value),
      ).text,
    describeElement: (element, render) => {
      if (codeElements.has(element)) return 'box (hidden)';
      const shown = isPossibleInput(element)
        ? {
            ...element,
            value: element.value === undefined ? undefined : MASK,
            label: labelIsValue(element, all) ? MASK : element.label,
          }
        : element;
      const testID = element.testID;
      if (!testID) return maskText(render(shown));
      const placeholder = '';
      const rendered = render({ ...shown, testID: placeholder });
      const masked = maskText(rendered);
      if (rendered.split(placeholder).length !== 2 || masked.split(placeholder).length !== 2)
        return maskText(render(shown));
      const identifier = matchPrivate(testID, all, 'identifier').hit ? MASK : testID;
      return masked.replace(placeholder, () => identifier);
    },
  };
}

export function maskValues(text: string, values: readonly string[]): string {
  return matchPrivate(
    text,
    { values: values.filter(Boolean).map((value) => ({ text: value, provenance: 'typed' })) },
    'durable',
  ).text;
}
