import { type Judge, JevError, validateAnswer } from './questions.js';
import { type JevRollup, summarizeJev } from './ledger.js';
import {
  type PreparedPlan,
  type RefusedLine,
  type PlanDiagnostic,
  planDiagnostics,
  parsePlan,
  parsePlanWithJev,
  planNeedsJev,
  preparePlan,
} from './plan.js';

export type PreflightResult =
  | { ok: true; prepared: PreparedPlan; jev: JevRollup; jevRequired: boolean }
  | {
      ok: false;
      code: 'JEV_UNREACHABLE' | 'PLAN_UNPARSEABLE';
      message: string;
      refused?: PlanDiagnostic[];
      jev: JevRollup;
    };

const unparseable = (refused: RefusedLine[], judge: Judge): PreflightResult => ({
  ok: false,
  code: 'PLAN_UNPARSEABLE',
  message: 'the plan does not parse',
  refused: planDiagnostics(refused),
  jev: summarizeJev(judge.calls),
});

// Quoted targets and literal checks resolve without a model, so only other plans probe Jev first.
export async function preflightPlan(markdown: string, judge: Judge): Promise<PreflightResult> {
  if (!planNeedsJev(markdown)) {
    const parsed = parsePlan(markdown);
    if (parsed.refused) return unparseable(parsed.refused, judge);
    return {
      ok: true,
      prepared: preparePlan(markdown, parsed.blocks),
      jev: summarizeJev(judge.calls),
      jevRequired: false,
    };
  }
  try {
    const question = { type: 'noul' as const, instructions: 'The readiness marker is ready.' };
    const answers = await judge.ask({ readiness: 'ready' }, { preflight: question }, 'preflight');
    const answer = validateAnswer(question, answers.preflight);
    if (answer.type !== 'noul' || answer.noul < 0.7) throw new JevError('JEV_RESPONSE_INVALID');
    const parsed = await parsePlanWithJev(markdown, judge);
    if (parsed.refused) return unparseable(parsed.refused, judge);
    return {
      ok: true,
      prepared: preparePlan(markdown, parsed.blocks),
      jev: summarizeJev(judge.calls),
      jevRequired: true,
    };
  } catch (error) {
    if (!(error instanceof JevError)) throw error;
    return {
      ok: false,
      code: 'JEV_UNREACHABLE',
      message: error.message,
      jev: summarizeJev(judge.calls),
    };
  }
}
