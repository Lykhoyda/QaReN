export type NativeVerifyVerdict =
  | 'exact'
  | 'mismatch'
  | 'case-normalized'
  | 'unreadable'
  | 'secure-masked'
  | 'target-lost'
  | 'ambiguous'
  | 'unavailable';

// What a fill proved: only exact verifies; masked and unavailable never promote to verified.
export type FillEvidence = 'exact' | 'masked' | 'unavailable' | 'mismatch' | 'case-normalized';

export interface NativeVerification {
  verified: boolean;
  evidence: FillEvidence;
  native: NativeVerifyVerdict;
  nativeStable: boolean;
  observedMismatch: boolean;
}

export function classifyNativeVerification(
  native: NativeVerifyVerdict,
  nativeStable: boolean,
): NativeVerification {
  return {
    verified: native === 'exact' && nativeStable,
    evidence: !nativeStable
      ? 'unavailable'
      : native === 'exact'
        ? 'exact'
        : native === 'secure-masked'
          ? 'masked'
          : native === 'mismatch'
            ? 'mismatch'
            : native === 'case-normalized'
              ? 'case-normalized'
              : 'unavailable',
    native,
    nativeStable,
    observedMismatch: native === 'mismatch' && nativeStable,
  };
}
