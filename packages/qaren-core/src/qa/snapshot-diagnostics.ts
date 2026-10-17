const KINDS = [
  'TextField',
  'SecureTextField',
  'TextView',
  'SearchField',
  'ScrollView',
  'Table',
  'CollectionView',
  'Cell',
  'StaticText',
  'Other',
];

const UNREADABLE = Symbol('unreadable');

export function diagnosticField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor ? undefined : 'value' in descriptor ? descriptor.value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

export function diagnosticKind(type: unknown): number {
  const index = typeof type === 'string' ? KINDS.indexOf(type) : -1;
  return index < 0 ? 9 : index;
}

export const emptyKindCounts = (): number[] => KINDS.map(() => 0);

export function diagnosticRect(value: unknown): number[] | null {
  const coordinates = ['x', 'y', 'width', 'height'].map((key) => diagnosticField(value, key));
  if (!coordinates.every((n): n is number => typeof n === 'number' && Number.isFinite(n)))
    return null;
  if (coordinates[2] < 0 || coordinates[3] < 0) return null;
  return coordinates.map(Math.round);
}

type Viewport = {
  viewportStatus: 'collected' | 'missing' | 'invalid';
  viewportSource: 'first-nonempty-window' | 'app' | 'unbounded' | null;
  viewport: number[] | null;
};

function viewportFields(value: unknown, normalized: boolean): Viewport {
  const absent: Viewport = {
    viewportStatus: value === undefined ? 'missing' : 'invalid',
    viewportSource: null,
    viewport: null,
  };
  const status = diagnosticField(value, 'viewportStatus');
  if (normalized && (status === 'missing' || status === 'invalid'))
    return { ...absent, viewportStatus: status };
  if (normalized ? status !== 'collected' : diagnosticField(value, 'v') !== 1) return absent;
  const source = diagnosticField(value, 'viewportSource');
  const viewport = diagnosticField(value, 'viewport');
  if (source === 'unbounded' && viewport === null)
    return { viewportStatus: 'collected', viewportSource: source, viewport: null };
  if (
    (source !== 'app' && source !== 'first-nonempty-window') ||
    !Array.isArray(viewport) ||
    diagnosticField(viewport, 'length') !== 4
  )
    return absent;
  const rect = diagnosticRect(
    Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key, i) => [key, diagnosticField(viewport, String(i))]),
    ),
  );
  return rect ? { viewportStatus: 'collected', viewportSource: source, viewport: rect } : absent;
}

export function snapshotInventory() {
  return {
    emittedCount: 0,
    normalizedCount: 0,
    missingRectCount: 0,
    emittedByKind: emptyKindCounts(),
    normalizedByKind: emptyKindCounts(),
    missingRectByKind: emptyKindCounts(),
  };
}

export function normalizedSnapshotDiagnostics(
  viewport: unknown,
  inventory: ReturnType<typeof snapshotInventory>,
) {
  return { ...viewportFields(viewport, false), ...inventory };
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

export function privateSnapshotDiagnostics(value: unknown) {
  const vector = (key: string): number[] | null => {
    const raw = diagnosticField(value, key);
    if (!Array.isArray(raw) || diagnosticField(raw, 'length') !== KINDS.length) return null;
    const numbers = KINDS.map((_, i) => diagnosticField(raw, String(i)));
    return numbers.every(count) ? numbers : null;
  };
  const groups = ['emitted', 'normalized', 'missingRect'] as const;
  const inventory = Object.fromEntries(
    groups.flatMap((group) => {
      const total = diagnosticField(value, `${group}Count`);
      const bins = vector(`${group}ByKind`);
      const valid = count(total) && bins && bins.reduce((sum, n) => sum + n, 0) === total;
      return [
        [`${group}Count`, valid ? total : null],
        [`${group}ByKind`, valid ? bins : null],
      ];
    }),
  );
  return { ...viewportFields(value, true), ...inventory };
}
