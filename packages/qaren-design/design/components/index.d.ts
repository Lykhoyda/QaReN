// QaReN design system components. Global: window.QaReN. Every component renders
// class-based markup styled by components/bundle.css over tokens.css; wrap pages in
// an element with class "qr-root" and data-theme="dark" or "light".

import type { ReactNode, MouseEventHandler } from 'react';

export type Verdict = 'PASS' | 'FAIL';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed';

/** The run's verdict as a word plus a check or cross glyph. The loudest element on any screen. */
export interface VerdictPillProps {
  verdict: Verdict;
  /** sm 12px (cards, rows), md 14px default, lg 20px (headers), xl 32px (social cards). */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export interface Step {
  /** The plan step as written, for example: Tap "onboarding-skip". */
  text: ReactNode;
  status: StepStatus;
  /** One muted line under the step, used for a failure reason. */
  detail?: ReactNode;
}
/** A plan's steps with a mark and a status word on every row. */
export interface StepListProps {
  steps: Step[];
  className?: string;
}

/** A screen recording of a run: thumbnail, duration and verdict. */
export interface VideoProofCardProps {
  verdict: Verdict;
  title: ReactNode;
  /** m:ss. Defaults to the literal "m:ss" so no invented duration ships. */
  duration?: string;
  /** Image URL. Without one the card shows a labelled placeholder frame. */
  thumbnail?: string;
  alt?: string;
  /** One mono line under the title, for example the simulator or the plan. */
  meta?: ReactNode;
  className?: string;
}

export interface Artifact {
  label: string;
  href?: string;
}
/** The block QaReN posts on a pull request: verdict, plan, steps and evidence links. */
export interface PRCommentSummaryProps {
  verdict: Verdict;
  title?: ReactNode;
  plan?: ReactNode;
  summary?: ReactNode;
  steps?: Step[];
  artifacts?: Artifact[];
  /** Shows a Placeholder badge. Defaults to true; set false only for real output. */
  placeholder?: boolean;
  className?: string;
}

/** One line of the run ledger. Stack rows inside an element with class "qr-ledger". */
export interface LedgerRowProps {
  index: number | string;
  status: StepStatus;
  /** The action verb, for example tap, wait, assert. */
  action: ReactNode;
  /** The element or text the action used. */
  target: ReactNode;
  duration?: string;
  className?: string;
}

/** The logo: the cursor Q symbol, alone or locked up with the outlined wordmark. Ring in text colour, cursor in accent. */
export interface LogoProps {
  variant?: 'symbol' | 'lockup';
  /** Height in px. Default 32. */
  size?: number;
  /** Cursor in the ring's colour, for single-colour use. */
  mono?: boolean;
  className?: string;
}

/** "QaReN" in JetBrains Mono, optionally with the amber cursor block. */
export interface WordmarkProps {
  href?: string;
  cursor?: boolean;
  blink?: boolean;
  /** Any CSS length; defaults to the inherited size. */
  size?: string;
  className?: string;
}

export interface ButtonProps {
  /** primary uses the accent: at most one per screen. Default secondary. */
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: MouseEventHandler;
  children: ReactNode;
  className?: string;
}

export interface LinkProps {
  href?: string;
  muted?: boolean;
  children: ReactNode;
  className?: string;
}

export interface InlineCodeProps {
  children: ReactNode;
  className?: string;
}

export interface BadgeProps {
  tone?: 'neutral' | 'pass' | 'fail' | 'placeholder';
  children: ReactNode;
  className?: string;
}

/** A static code sample. Lines starting with # or // render muted. */
export interface CodeBlockProps {
  code: string;
  /** File name or language, mono, in the header strip. */
  title?: string;
  placeholder?: boolean;
  /** Mute lines starting with # or //. Default true; set false for Markdown plans. */
  comments?: boolean;
  className?: string;
}

export interface TerminalLine {
  text: ReactNode;
  /** cmd gets a muted $ prompt; pass and fail colour the line (it must still contain the word). */
  kind?: 'cmd' | 'out' | 'muted' | 'pass' | 'fail';
}
/** A terminal window. Marked "Placeholder output" unless placeholder is false. */
export interface TerminalPaneProps {
  title?: string;
  lines: TerminalLine[];
  /** Blinking amber cursor after the last line. Counts as the screen's accent. */
  cursor?: boolean;
  /** Adds shadow-pane, for heroes and social cards. */
  float?: boolean;
  placeholder?: boolean;
  className?: string;
}

export interface CardProps {
  kicker?: ReactNode;
  title?: ReactNode;
  href?: string;
  children?: ReactNode;
  className?: string;
}

export interface CalloutProps {
  tone?: 'note' | 'caution' | 'danger';
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

export interface TableColumn {
  key: string;
  label: ReactNode;
  numeric?: boolean;
}
export interface TableProps {
  columns: TableColumn[];
  rows: Record<string, ReactNode>[];
  caption?: string;
  className?: string;
}

export interface NavLink {
  label: string;
  href?: string;
  active?: boolean;
}
export interface NavBarProps {
  links: NavLink[];
  homeHref?: string;
  /** A trailing element, usually a secondary Button. */
  action?: ReactNode;
  className?: string;
}

export interface FooterProps {
  note?: ReactNode;
  links?: NavLink[];
  className?: string;
}
