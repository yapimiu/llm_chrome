import { describe, expect, it } from 'vitest';
import { advance, INITIAL_ESCALATION, isEscalationEnabled, judgeStep, remapLevel, type EscalationConfig, type EscalationState, type Verdict } from '@/lib/agent/escalation';
import type { ExecutedAction, StepRecord } from '@/lib/agent/types';

const level = (id: string, external = false) => ({ id, label: id, model: `${id}-model`, contextTokens: 8192, maxOutputTokens: 512, vision: false, external });
const cfg: EscalationConfig = { levels: [level('qwen'), level('big'), level('cloud', true)], failStreak: 2, returnAfter: 3 };

const good: Verdict = { health: 'good', reason: 'ok' };
const bad: Verdict = { health: 'bad', reason: 'an action failed' };
const severe: Verdict = { health: 'bad', reason: 'looping', severe: true };
const neutral: Verdict = { health: 'neutral', reason: 'service error' };

function run(verdicts: Verdict[], c = cfg, from: EscalationState = INITIAL_ESCALATION) {
  let state = from;
  const changes: string[] = [];
  for (const v of verdicts) {
    const r = advance(state, c, v);
    state = r.state;
    if (r.change) changes.push(`${r.change.from}→${r.change.to}`);
  }
  return { state, changes };
}

describe('advance — цепочка моделей', () => {
  it('одна неудача не повод менять модель, две подряд — переход на следующую', () => {
    expect(run([bad]).state.level).toBe(0);
    const r = run([bad, bad]);
    expect(r.state).toEqual({ level: 1, fails: 0, goods: 0 });
    expect(r.changes).toEqual(['0→1']);
  });

  it('удача между неудачами обнуляет серию', () => {
    expect(run([bad, good, bad]).state.level).toBe(0);
  });

  it('сильный сигнал (зацикливание) переводит сразу', () => {
    expect(run([severe]).changes).toEqual(['0→1']);
  });

  it('идёт вверх по ступеням по порядку и останавливается на последней', () => {
    const r = run([bad, bad, bad, bad, bad, bad, bad, bad]);
    expect(r.changes).toEqual(['0→1', '1→2']);
    expect(r.state.level).toBe(2);
  });

  it('на сильной модели returnAfter удачных подряд — возврат на базовую', () => {
    const r = run([good, good, good], cfg, { level: 1, fails: 0, goods: 0 });
    expect(r.state).toEqual({ level: 0, fails: 0, goods: 0 });
    expect(r.changes).toEqual(['1→0']);
  });

  it('неудача на сильной модели сбрасывает серию удач; два сбоя — ещё выше', () => {
    expect(run([good, good, bad, good], cfg, { level: 1, fails: 0, goods: 0 }).state.level).toBe(1);
    expect(run([bad, bad], cfg, { level: 1, fails: 0, goods: 0 }).changes).toEqual(['1→2']);
  });

  it('на базовой удачи ничего не меняют; нейтральные шаги (сбой сервиса) — тоже', () => {
    expect(run([good, good, good, good]).state).toEqual({ level: 0, fails: 0, goods: 4 });
    expect(run([bad, neutral, bad]).changes).toEqual(['0→1']);
    expect(run([neutral, neutral, neutral]).state).toEqual(INITIAL_ESCALATION);
  });

  it('одна ступень — автосмены нет', () => {
    const one: EscalationConfig = { ...cfg, levels: [level('qwen')] };
    expect(run([severe, bad, bad], one).state).toEqual(INITIAL_ESCALATION);
    expect(isEscalationEnabled(one)).toBe(false);
    expect(isEscalationEnabled(cfg)).toBe(true);
    expect(isEscalationEnabled(undefined)).toBe(false);
  });
});

const rec = (patch: Partial<StepRecord> = {}, actions: ExecutedAction[] = []): StepRecord => ({
  n: 1,
  startedAt: 0,
  url: '',
  reasoning: '',
  expectedOutcome: '',
  actions,
  warnings: [],
  notes: [],
  ...patch,
});
const act = (ok: boolean, message = 'ok'): ExecutedAction => ({ action: { action: 'click', index: 1 }, result: { ok, message } });

describe('judgeStep — как прошёл шаг для модели', () => {
  it('негодный ответ модели — неудача; сбой сервиса — нейтрально', () => {
    expect(judgeStep(rec(), 'model-error').health).toBe('bad');
    expect(judgeStep(rec(), 'service-error').health).toBe('neutral');
  });

  it('зацикливание и застревание — сильный сигнал', () => {
    expect(judgeStep(rec({ warnings: ['LOOP: these exact actions…'] }), 'ok')).toMatchObject({ health: 'bad', severe: true });
    expect(judgeStep(rec({ notes: ['STUCK: …'] }), 'ok')).toMatchObject({ health: 'bad', severe: true });
    expect(judgeStep(rec({ notes: ['AUTO-SCROLL: …'] }), 'ok')).toMatchObject({ health: 'bad', severe: true });
  });

  it('провалившееся действие и «ничего не изменилось» — неудача', () => {
    expect(judgeStep(rec({}, [act(false, 'covered')]), 'ok').health).toBe('bad');
    expect(judgeStep(rec({}, [act(true, 'clicked, nothing on the page changed')]), 'ok').health).toBe('bad');
  });

  it('все действия удались — удача; действий не было — нейтрально', () => {
    expect(judgeStep(rec({}, [act(true), act(true, 'typed')]), 'ok').health).toBe('good');
    expect(judgeStep(rec(), 'ok').health).toBe('neutral');
  });
});

describe('remapLevel — возобновление после перезапуска', () => {
  const old = [level('qwen'), level('big'), level('cloud', true)];

  it('модель ещё в цепочке — остаёмся на ней (даже если сдвинулся номер)', () => {
    expect(remapLevel({ level: 2, fails: 1, goods: 0 }, old, [level('qwen'), level('cloud', true)])).toEqual({ level: 1, fails: 1, goods: 0 });
  });

  it('облако запретили или профиль удалили — возвращаемся на базовую', () => {
    expect(remapLevel({ level: 2, fails: 0, goods: 1 }, old, [level('qwen'), level('big')])).toEqual(INITIAL_ESCALATION);
    expect(remapLevel({ level: 1, fails: 0, goods: 0 }, old, [level('qwen')])).toEqual(INITIAL_ESCALATION);
  });

  it('старый чекпоинт без цепочки или без состояния', () => {
    expect(remapLevel({ level: 1, fails: 0, goods: 0 }, undefined, old)).toEqual(INITIAL_ESCALATION);
    expect(remapLevel(undefined, old, old)).toBeUndefined();
  });
});

