function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedPresenceInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function systemModalDiagnostic(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.appState !== 'string' ||
    ![
      'unknown',
      'notRunning',
      'runningBackgroundSuspended',
      'runningBackground',
      'runningForeground',
    ].includes(value.appState) ||
    !boundedPresenceInteger(value.alertCount, 65535) ||
    !boundedPresenceInteger(value.sheetCount, 65535) ||
    value.alertCount + value.sheetCount === 0 ||
    !Array.isArray(value.modals) ||
    value.modals.length > 32
  )
    return undefined;
  const modals = [];
  for (const row of value.modals) {
    if (
      !isRecord(row) ||
      !['exists', 'frameEmpty', 'centerInViewport', 'springboardFrameEmpty'].every(
        (key) => typeof row[key] === 'boolean',
      ) ||
      !boundedPresenceInteger(row.hittableDescendantCount, 1000000) ||
      !Array.isArray(row.descendantTypes) ||
      row.descendantTypes.length > 256
    )
      return undefined;
    const descendantTypes = [];
    for (const entry of row.descendantTypes) {
      if (
        !isRecord(entry) ||
        !boundedPresenceInteger(entry.type, 65535) ||
        !boundedPresenceInteger(entry.count, 1000000)
      )
        return undefined;
      descendantTypes.push({ type: entry.type, count: entry.count });
    }
    modals.push({
      exists: row.exists,
      frameEmpty: row.frameEmpty,
      centerInViewport: row.centerInViewport,
      springboardFrameEmpty: row.springboardFrameEmpty,
      descendantTypes,
      hittableDescendantCount: row.hittableDescendantCount,
    });
  }
  return {
    appState: value.appState,
    alertCount: value.alertCount,
    sheetCount: value.sheetCount,
    modals,
  };
}
