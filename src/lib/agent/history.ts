import { formatAction } from './actions';
import type { ExecutedAction, StepRecord } from './types';

export interface HistoryOptions {
  /** Сколько последних шагов показывать подробно. */
  detailed: number;
  /** Жёсткий лимит символов; старые шаги выбрасываются первыми. */
  maxChars: number;
}

export const DEFAULT_HISTORY: HistoryOptions = { detailed: 3, maxChars: 4000 };

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function actionLine(a: ExecutedAction, withTarget: boolean): string {
  const target = withTarget && a.target ? ` (${cut(a.target, 60)})` : '';
  const outcome = a.skipped ? `skipped: ${a.skipped}` : a.result ? (a.result.ok ? a.result.message : `FAILED: ${a.result.message}`) : 'not executed';
  return `${formatAction(a.action)}${target} → ${outcome}`;
}

function detailedStep(s: StepRecord): string {
  const lines = [`Step ${s.n} (${cut(s.url, 100)}):`];
  if (s.reasoning) lines.push(`  reasoning: ${cut(s.reasoning, 300)}`);
  if (s.expectedOutcome) lines.push(`  expected: ${cut(s.expectedOutcome, 200)}`);
  for (const a of s.actions) lines.push(`  - ${actionLine(a, true)}`);
  if (s.error) lines.push(`  error: ${cut(s.error, 200)}`);
  for (const n of s.notes) lines.push(`  note: ${cut(n, 500)}`);
  for (const w of s.warnings.filter((w) => w.startsWith('LOOP'))) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}

/** Старый шаг в одну строку: что делали и чем кончилось. */
function compactStep(s: StepRecord): string {
  const acts = s.actions.map((a) => actionLine(a, false)).join('; ');
  const notes = s.notes.length ? ` | ${s.notes.map((n) => cut(n, 150)).join(' | ')}` : '';
  return `Step ${s.n}: ${acts || s.error || 'no actions'}${notes}`;
}

/**
 * История для промпта: последние шаги подробно, более старые — одной строкой,
 * а при нехватке места самые старые выбрасываются. Сохранённые заметки (extract) идут всегда.
 */
export function buildHistory(steps: readonly StepRecord[], extracted: readonly string[], opts: HistoryOptions = DEFAULT_HISTORY): string {
  const parts: string[] = [];
  if (extracted.length) parts.push(`Saved notes (from extract):\n${extracted.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  if (steps.length === 0) return parts.join('\n\n');

  const split = Math.max(0, steps.length - opts.detailed);
  const recent = steps.slice(split).map(detailedStep);
  const older = steps.slice(0, split).map(compactStep);

  const fixed = [...parts, recent.join('\n')].join('\n\n');
  let budget = opts.maxChars - fixed.length - 60;
  const keptOlder: string[] = [];
  for (let i = older.length - 1; i >= 0 && budget > 0; i--) {
    const line = older[i]!;
    if (line.length + 1 > budget) break;
    keptOlder.unshift(line);
    budget -= line.length + 1;
  }
  const dropped = older.length - keptOlder.length;
  const olderBlock = [dropped > 0 ? `(${dropped} earlier steps omitted)` : '', ...keptOlder].filter(Boolean).join('\n');

  const out = [...parts, olderBlock, recent.join('\n')].filter(Boolean).join('\n\n');
  return out.length > opts.maxChars ? `…${out.slice(out.length - opts.maxChars + 1)}` : out;
}

/**
 * Короткая сводка вместо истории — «сброс контекста»: заметки из extract целиком, пройденные страницы
 * и два последних шага. Строится без обращения к модели, поэтому токенов не тратит.
 */
export function buildDigest(steps: readonly StepRecord[], extracted: readonly string[], keep = 2, maxChars = DEFAULT_HISTORY.maxChars): string {
  const parts: string[] = [];
  if (extracted.length) parts.push(`Saved notes (from extract):\n${extracted.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  if (steps.length === 0) return parts.join('\n\n');
  const pages = [...new Set(steps.map((s) => cut(s.url, 80)).filter(Boolean))].slice(-6);
  const failed = steps.filter((s) => s.error || s.actions.some((a) => a.result && !a.result.ok)).length;
  parts.push(
    `Earlier context was reset to save space. So far: ${steps.length} steps (${failed} with problems).${pages.length ? ` Pages visited, oldest first: ${pages.join(' → ')}.` : ''}`,
  );
  parts.push(steps.slice(-keep).map(compactStep).join('\n'));
  const out = parts.filter(Boolean).join('\n\n');
  // Как и история, не длиннее лимита: иначе «сброс» с длинными заметками extract раздул бы промпт.
  return out.length > maxChars ? `…${out.slice(out.length - maxChars + 1)}` : out;
}
