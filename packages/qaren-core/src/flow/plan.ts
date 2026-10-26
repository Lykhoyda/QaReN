export const PLAN_SCHEMA = 'rn-flow/1';

export const LOOKUP_BUDGET_MS = 17_000;
export const OPTIONAL_LOOKUP_BUDGET_MS = 7_000;
export const SCROLL_UNTIL_VISIBLE_BUDGET_MS = 20_000;
export const SETTLE_CAP_MS = 5_000;
export const NATIVE_DISPATCH_BUDGET_MS = 10_000;
export const LAUNCH_BUDGET_MS = 15_000;
export const TERMINATE_BUDGET_MS = 10_000;
export const DEFAULT_ERASE_CHARACTERS = 50;
export const DEFAULT_SWIPE_DURATION_MS = 400;

export type Platform = 'ios' | 'android';
export type Domain = 'native' | 'react-tree' | 'lifecycle';
export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type Selector = DeepReadonly<
  { id: string; text?: never; index?: number } | { text: string; id?: never; index?: number }
>;

export interface StepSource {
  readonly line: number;
  readonly file?: string;
}

interface StepBase {
  id: string;
  source: StepSource;
  domain: Domain;
  optional: boolean;
  // 0 means one observation, never a poll.
  budgetMs: number;
}

export type Step = DeepReadonly<
  StepBase &
    (
      | { op: 'launchApp'; stopApp: boolean; clearState: boolean }
      | { op: 'tapOn' | 'doubleTapOn' | 'longPressOn'; selector: Selector }
      | { op: 'assertVisible' | 'assertNotVisible'; selector: Selector }
      | { op: 'scrollUntilVisible'; selector: Selector; direction: Direction }
      | { op: 'inputText'; text: string }
      | { op: 'eraseText'; characters: number }
      | { op: 'hideKeyboard'; fallbackDomain: 'react-tree' }
      | { op: 'pressKey'; key: 'Enter' | 'Back' }
      | { op: 'swipe'; direction: Direction; from?: Selector; durationMs: number }
      | { op: 'back' | 'scroll' | 'waitForAnimationToEnd' | 'stopApp' | 'killApp' | 'clearState' }
      | { op: 'takeScreenshot'; name: string }
      | { op: 'openLink'; link: string }
      | {
          op: 'runFlow';
          when: { visible: Selector } | { notVisible: Selector };
          steps: Step[];
        }
    )
>;

export interface Plan {
  readonly schema: typeof PLAN_SCHEMA;
  readonly actionId: string;
  readonly appId: string;
  readonly platform: Platform;
  readonly steps: readonly Step[];
}
