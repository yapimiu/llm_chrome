import { formatAction } from '../agent/actions';
import { RISK_LABELS } from '../agent/risk';
import type { RunState } from '../agent/types';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Текст запроса подтверждения для Telegram: что, где и почему рискованно. */
export function approvalText(state: RunState, url: string): string {
  const p = state.pendingApproval;
  if (!p) return '';
  const risky = p.actions.some((a) => a.risk);
  const lines = [risky ? '⚠️ Агенту нужно подтверждение рискованного действия' : '🤖 Агент хочет сделать шаг', `Задача: ${cut(state.task, 300)}`];
  if (url) lines.push(`Страница: ${cut(url, 200)}`);
  if (p.reasoning) lines.push('', cut(p.reasoning, 500));
  lines.push('');
  p.actions.forEach((a, i) => {
    lines.push(`${i + 1}. ${formatAction(a.action)}${a.target ? ` → ${cut(a.target, 120)}` : ''}`);
    for (const r of a.risk ?? []) lines.push(`   ⚠ ${RISK_LABELS[r.kind]}: ${r.why}`);
  });
  if (p.deadline) lines.push('', `Без ответа через ${Math.max(0, Math.round((p.deadline - Date.now()) / 1000))} с действие уйдёт в очередь на утро.`);
  return lines.join('\n');
}

export function questionText(state: RunState): string {
  return `❓ Агент спрашивает\nЗадача: ${cut(state.task, 300)}\n\n${state.question ?? ''}`;
}

const FINISH: Partial<Record<RunState['status'], string>> = {
  done: '✅ Задача выполнена',
  failed: '❌ Задача не выполнена',
  stopped: '⏹ Задача остановлена',
  deferred: '⏸ Задача ждёт утра',
};

export function finishText(state: RunState): string {
  const body = state.status === 'done' || state.status === 'deferred' ? state.result : state.error;
  return [`${FINISH[state.status] ?? state.status} (шагов: ${state.steps.length})`, `Задача: ${cut(state.task, 300)}`, body ? `\n${cut(body, 3000)}` : ''].filter(Boolean).join('\n');
}
