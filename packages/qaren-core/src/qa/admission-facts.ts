import { cleanTimingEvent } from './timing.js';
import type { AdmissionRefusalFacts } from './admission.js';

export type AdmissionFacts = Omit<AdmissionRefusalFacts, 'inference' | 'warmMs' | 'warmAttempts'>;
const REQUIRED = [
  'attempt',
  'lastStarted',
  'lastCompleted',
  'inner',
  'relaunches',
  'relaunchFailed',
  'liveness',
  'elapsedMs',
  'remainingMs',
  'budgetMs',
] as const;
const NUMBERS = [
  'attempt',
  'relaunches',
  'elapsedMs',
  'remainingMs',
  'budgetMs',
  'attachBudgetMs',
  'walkBudgetMs',
  'targetsTotal',
  'devTrue',
  'devFalse',
  'devUndefined',
  'devUnknown',
] as const;
const COUNTS = ['targetsTotal', 'devTrue', 'devFalse', 'devUndefined', 'devUnknown'] as const;

export function cleanAdmissionFacts(value: unknown): AdmissionFacts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = cleanTimingEvent({
    ...value,
    stage: 'admission',
    edge: 'point',
    outcome: 'failed',
    at: 0,
  });
  if (!clean || REQUIRED.some((key) => clean[key] === undefined)) return undefined;
  if (NUMBERS.some((key) => clean[key] !== undefined && !Number.isSafeInteger(clean[key])))
    return undefined;
  if (
    COUNTS.some((key) => clean[key] !== undefined) &&
    (COUNTS.some((key) => clean[key] === undefined) ||
      clean.targetsTotal !==
        clean.devTrue! + clean.devFalse! + clean.devUndefined! + clean.devUnknown!)
  )
    return undefined;
  const keys = [...REQUIRED, ...NUMBERS, 'bundleRequest'];
  return Object.fromEntries(
    keys
      .filter((key) => clean[key as keyof typeof clean] !== undefined)
      .map((key) => [key, clean[key as keyof typeof clean]]),
  ) as AdmissionFacts;
}
