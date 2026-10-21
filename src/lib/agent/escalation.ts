import type { StepRecord } from './types';

/** Одна ступень цепочки моделей: базовая — под номером 0, сильнее — дальше. */
export interface ModelLevel {
  id: string;
  label: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** Понимает картинки — можно слать скриншоты. */
  vision: boolean;
  /** Данные страниц уходят за пределы своей сети. */
  external: boolean;
}

export interface EscalationConfig {
  /** Ступени по порядку: [базовая, …сильнее]. Одна ступень — автосмена выключена. */
  levels: ModelLevel[];
  /** Неудачных шагов подряд до перехода на следующую модель. */
  failStreak: number;
  /** Удачных шагов подряд на сильной модели до возврата на базовую. */
  returnAfter: number;
}

export interface EscalationState {
  /** Номер текущей ступени. */
  level: number;
  /** Неудачных шагов подряд на этой ступени. */
  fails: number;
  /** Удачных шагов подряд на этой ступени. */
  goods: number;
}

export const INITIAL_ESCALATION: EscalationState = { level: 0, fails: 0, goods: 0 };

export type Health = 'good' | 'bad' | 'neutral';

export interface Verdict {
  health: Health;
  reason: string;
  /** Сильный сигнал (зацикливание, застревание): переходим сразу, не дожидаясь серии. */
  severe?: boolean;
}

export interface LevelChange {
  from: number;
  to: number;
  reason: string;
}

const STUCK_NOTE = /^(AUTO-SCROLL|STUCK)/;

/**
 * Как прошёл шаг для модели. Сбой сервиса — не вина модели (нейтрально): иначе перегрузка облака
 * перебрасывала бы задачу на платную модель.
 */
export function judgeStep(record: StepRecord, outcome: 'ok' | 'model-error' | 'service-error'): Verdict {
  if (outcome === 'service-error') return { health: 'neutral', reason: 'service error' };
  if (outcome === 'model-error') return { health: 'bad', reason: 'the model did not give a valid answer' };
  if (record.warnings.some((w) => w.startsWith('LOOP'))) return { health: 'bad', reason: 'looping on the same actions', severe: true };
  if (record.notes.some((n) => STUCK_NOTE.test(n))) return { health: 'bad', reason: 'stuck on the same page without progress', severe: true };
  const executed = record.actions.filter((a) => a.result);
  if (executed.some((a) => !a.result!.ok)) return { health: 'bad', reason: 'an action failed' };
  if (executed.some((a) => /nothing on the page changed/.test(a.result!.message))) return { health: 'bad', reason: 'an action changed nothing on the page' };
  return executed.length > 0 ? { health: 'good', reason: 'ok' } : { health: 'neutral', reason: 'no actions executed' };
}

/**
 * Следующее состояние после шага. Неудачи копятся: failStreak подряд (или одна сильная) — шаг вверх по
 * цепочке. На сильной модели returnAfter удачных подряд — возврат на базовую. Выше последней ступени не идём.
 */
export function advance(state: EscalationState, cfg: EscalationConfig, verdict: Verdict): { state: EscalationState; change: LevelChange | null } {
  const top = cfg.levels.length - 1;
  if (top <= 0 || verdict.health === 'neutral') return { state, change: null };
  const s = { ...state };
  if (verdict.health === 'bad') {
    s.goods = 0;
    s.fails = verdict.severe ? cfg.failStreak : s.fails + 1;
    if (s.fails >= cfg.failStreak && s.level < top) {
      return { state: { level: s.level + 1, fails: 0, goods: 0 }, change: { from: s.level, to: s.level + 1, reason: verdict.reason } };
    }
    return { state: s, change: null };
  }
  s.fails = 0;
  s.goods += 1;
  if (s.level > 0 && s.goods >= cfg.returnAfter) {
    return { state: { level: 0, fails: 0, goods: 0 }, change: { from: s.level, to: 0, reason: `${cfg.returnAfter} good steps in a row` } };
  }
  return { state: s, change: null };
}

export function isEscalationEnabled(cfg: EscalationConfig | undefined): cfg is EscalationConfig {
  return !!cfg && cfg.levels.length > 1;
}

/**
 * Возобновление после перезапуска: цепочка берётся из текущих настроек (облако могли запретить,
 * профиль — удалить или перенаправить), а запуск остаётся на той же модели, если она в цепочке ещё есть.
 * Иначе — обратно на базовую.
 */
export function remapLevel(state: EscalationState | undefined, before: readonly ModelLevel[] | undefined, after: readonly ModelLevel[]): EscalationState | undefined {
  if (!state) return state;
  const id = before?.[state.level]?.id;
  const level = id === undefined ? -1 : after.findIndex((l) => l.id === id);
  return level > 0 ? { ...state, level } : { ...INITIAL_ESCALATION };
}

