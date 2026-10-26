export interface SessionAuthorityDetails {
  axis?: string;
  cause?: string;
  expected?: string;
  observed?: string;
  nextAction?: string;
}

export class SessionAuthorityError extends Error {
  readonly code: string;
  readonly holder?: { sessionId: string; claimEpoch: number };
  private supplementalMeta?: Record<string, unknown>;
  readonly details?: SessionAuthorityDetails;

  constructor(
    code: string,
    message: string,
    holder?: { sessionId: string; claimEpoch: number },
    details?: SessionAuthorityDetails,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SessionAuthorityError';
    this.code = code;
    this.holder = holder;
    this.details = details;
  }

  attachMeta(meta: Record<string, unknown>): void {
    this.supplementalMeta = { ...this.supplementalMeta, ...meta };
  }

  getSupplementalMeta(): Record<string, unknown> {
    return { ...this.supplementalMeta };
  }
}

export const PROVEN_METRO_ORIGIN_META_KEY = 'metroOriginPinning';

export function isProvenMetroOriginMismatch(error: unknown): boolean {
  return (
    error instanceof SessionAuthorityError &&
    error.code === 'METRO_ORIGIN_MISMATCH' &&
    error.getSupplementalMeta()[PROVEN_METRO_ORIGIN_META_KEY] !== undefined
  );
}
