import { formatAction } from './actions';
import type { ExecutedAction, StepRecord } from './types';

export interface HistoryOptions {
  /** Number of recent steps eligible for detailed action targets. */
  detailed: number;
  /** Soft budget: protected facts and safety directives are never sliced. */
  maxChars: number;
}
export const DEFAULT_HISTORY: HistoryOptions = { detailed: 3, maxChars: 4000 };
const cut = (s: string, max: number) => s.length > max ? `${s.slice(0, max - 1)}…` : s;
const criticalNote = (s: string) => /BLOCKED|POSTPONED|User answered:|user.*(?:reject|refus|denied)|MODEL SWITCH/i.test(s);
const failedAction = (a: ExecutedAction) => !!a.result && (!a.result.ok || /nothing on the page changed/.test(a.result.message));
const problem = (s: StepRecord) => !!s.error || s.actions.some((a) => a.skipped || failedAction(a)) || s.warnings.some((w) => w.startsWith('LOOP'));

function actionLine(a: ExecutedAction, withTarget: boolean): string {
  const protectedAction = a.skipped || failedAction(a);
  const target = withTarget && a.target ? ` (${protectedAction ? a.target : cut(a.target, 60)})` : '';
  const outcome = a.skipped ? `skipped: ${a.skipped}` : a.result ? (failedAction(a) ? `FAILED: ${a.result.message}` : cut(a.result.message, 80)) : 'not executed';
  return `${formatAction(a.action)}${target} → ${outcome}`;
}

/** Exact duplicates retain their first source. Recent distinct failures remain complete. */
function protectedContext(steps: readonly StepRecord[], extracted: readonly string[]): string[] {
  const parts: string[] = [];
  const facts = [...new Set(extracted)];
  if (facts.length) parts.push(`Saved notes (from extract):\n${facts.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  const safety = new Map<string, string>();
  const failures = new Map<string, string>();
  const notes = new Map<string, string>();
  const add = (map: Map<string, string>, key: string, n: number, text: string) => { if (!map.has(key)) map.set(key, `Step ${n}: ${text}`); };
  for (const s of steps) {
    if (s.error) add(failures, `error:${s.error}`, s.n, `error: ${s.error}`);
    for (const a of s.actions) {
      if (a.skipped) add(safety, `skip:${actionLine(a, true)}`, s.n, actionLine(a, true));
      else if (failedAction(a)) add(failures, `action:${actionLine(a, true)}`, s.n, actionLine(a, true));
    }
    for (const note of s.notes) {
      if (criticalNote(note)) add(safety, `note:${note}`, s.n, `note: ${note}`);
      else add(notes, note, s.n, `note: ${cut(note, 180)}`);
    }
    for (const warning of s.warnings.filter((w) => w.startsWith('LOOP'))) add(failures, `warning:${warning}`, s.n, `warning: ${warning}`);
  }
  const lines = [...safety.values(), ...[...failures.values()].slice(-6), ...[...notes.values()].slice(-6)];
  if (lines.length) parts.push(`Important context (historical actions; use current observation indices):\n${lines.join('\n')}`);
  return parts;
}

function stepText(s: StepRecord, detailed: boolean): string {
  // Failure and note records already occur in the protected block.
  const actions = s.actions.filter((a) => !a.skipped && !failedAction(a));
  if (!detailed) return `Step ${s.n}: ${actions.map((a) => actionLine(a, false)).join('; ') || 'see important context'}`;
  const lines = [`Step ${s.n} (${cut(s.url, 100)}):`];
  if (problem(s)) {
    if (s.reasoning) lines.push(`  reasoning: ${cut(s.reasoning, 300)}`);
    if (s.expectedOutcome) lines.push(`  expected: ${cut(s.expectedOutcome, 200)}`);
  }
  for (const a of actions) lines.push(`  - ${actionLine(a, true)}`);
  return lines.join('\n');
}

function budgeted(parts: string[], candidates: string[], maxChars: number, omittedLabel: string): string {
  const floor = parts.join('\n\n');
  if (floor.length > maxChars) return `${floor}\n\n[History soft budget exceeded: protected context retained in full.]`;
  if (floor.length + omittedLabel.length + 2 > maxChars) return floor;
  const kept: string[] = [];
  // Reserve omission metadata before packing complete records. Never slice an action.
  let room = maxChars - floor.length - omittedLabel.length - 4;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (candidate.length + 2 > room) continue;
    kept.unshift(candidate);
    room -= candidate.length + 2;
  }
  return [...parts, kept.length < candidates.length ? omittedLabel.replace(/\d+ earlier steps/, `${candidates.length - kept.length} earlier steps`) : '', ...kept].filter(Boolean).join('\n\n');
}

export function buildHistory(steps: readonly StepRecord[], extracted: readonly string[], opts: HistoryOptions = DEFAULT_HISTORY): string {
  const parts = protectedContext(steps, extracted);
  if (!steps.length) return budgeted(parts, [], opts.maxChars, '');
  const split = Math.max(0, steps.length - opts.detailed);
  return budgeted(parts, steps.map((s, i) => stepText(s, i >= split)), opts.maxChars, `(${steps.length} earlier steps omitted)`);
}

export function buildDigest(steps: readonly StepRecord[], extracted: readonly string[], keep = 2, maxChars = DEFAULT_HISTORY.maxChars): string {
  const parts = protectedContext(steps, extracted);
  if (!steps.length) return budgeted(parts, [], maxChars, '');
  const pages = [...new Set(steps.map((s) => cut(s.url, 80)).filter(Boolean))].slice(-6);
  const failed = steps.filter(problem).length;
  const summary = `Earlier context was reset to save space. So far: ${steps.length} steps (${failed} with problems).${pages.length ? ` Pages visited, oldest first: ${pages.join(' → ')}.` : ''}`;
  return budgeted(parts, [summary, ...(keep > 0 ? steps.slice(-keep) : []).map((s) => stepText(s, false))], maxChars, '(earlier context omitted)');
}
