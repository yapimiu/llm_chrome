import { describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '@/lib/agent/actions';
import { elementKey, findElement, handoffTask, macroFromRun, nthOf, observationLines, Replayer, type Macro, type ReplayObservation } from '@/lib/agent/macro';
import { assessAction, DEFAULT_RISK_RULES, type RiskReason } from '@/lib/agent/risk';
import type { ElementBrief, RunState, StepRecord } from '@/lib/agent/types';

const brief = (index: number, line: string): ElementBrief => ({ index, line, y: index * 10, disabled: false, next: false, clickable: true });

describe('описание элемента', () => {
  it('без значения поля и состояний', () => {
    expect(elementKey('input[type=text] "Имя" value="Миша"')).toBe('input[type=text] "Имя"');
    expect(elementKey('button "Далее" disabled')).toBe('button "Далее"');
    expect(elementKey('button "🔬" ← NEXT')).toBe('button "🔬"');
  });

  it('поиск: точная строка, затем без изменчивого, затем тег и имя; среди одинаковых — n-й', () => {
    const els = [brief(1, 'button "Купить"'), brief(2, 'input[type=text] "Имя" value="старое"'), brief(3, 'button "Купить"'), brief(4, 'a "Помощь" href="/help?x=1"')];
    expect(findElement(els, 'button "Купить"', 1)?.index).toBe(3);
    expect(findElement(els, 'input[type=text] "Имя" value=""')?.index).toBe(2);
    expect(findElement(els, 'a "Помощь" href="/help"')?.index).toBe(4);
    expect(findElement(els, 'button "Купить"', 5)?.index).toBe(3);
    expect(findElement(els, 'button "Удалить"')).toBeNull();
  });

  it('порядковый номер среди одинаковых по наблюдению', () => {
    const lines = observationLines('URL: x\n[3] button "Ок"\n[7] button "Ок" disabled\n[9] a "Ок"');
    expect(nthOf(lines, 7, 'button "Ок" disabled')).toBe(1);
    expect(nthOf(lines, 9, 'a "Ок"')).toBe(0);
  });
});

function run(steps: Partial<StepRecord>[]): RunState {
  return {
    id: 'r1',
    task: 'Войти и купить',
    profileLabel: 'p',
    model: 'm',
    status: 'done',
    startedAt: 0,
    maxSteps: 10,
    extracted: [],
    steps: steps.map((s, i) => ({ n: i + 1, startedAt: 0, url: 'https://shop.example/', reasoning: '', expectedOutcome: '', actions: [], warnings: [], notes: [], ...s })),
  };
}

describe('macroFromRun', () => {
  it('берёт только выполненные действия, пароль не сохраняет', () => {
    const r = run([
      {
        url: 'https://shop.example/login',
        actions: [
          { action: { action: 'type', index: 2, text: 'me@x.ru', submit: false }, target: 'input[type=email] "Почта" value=""', result: { ok: true, message: 'typed' } },
          { action: { action: 'type', index: 3, text: 'hunter2', submit: false }, target: 'input[type=password] "Пароль" value=""', result: { ok: true, message: 'typed' }, risk: [{ kind: 'secret', why: 'ввод в поле пароля или карты' }] },
          { action: { action: 'click', index: 5 }, target: 'button "Войти"', result: { ok: false, message: 'covered' } },
        ],
      },
      { actions: [{ action: { action: 'click', index: 8 }, target: 'button "Купить"', result: { ok: true, message: 'clicked' } }, { action: { action: 'done', result: 'ok' }, result: { ok: true, message: '' } }] },
    ]);
    const obs = new Map([[2, '[4] button "Купить"\n[8] button "Купить"']]);
    const m = macroFromRun(r, obs, '  ', 'id1', 5);
    expect(m.name).toBe('Войти и купить');
    expect(m.startUrl).toBe('https://shop.example/login');
    expect(m.steps.map((s) => s.action.action)).toEqual(['type', 'type', 'click']);
    expect(m.steps[1]).toMatchObject({ secret: true, action: { text: '' } });
    expect(JSON.stringify(m)).not.toContain('hunter2');
    expect(m.steps[2]).toMatchObject({ target: 'button "Купить"', nth: 1 });
  });
});

describe('Replayer', () => {
  const macro: Macro = {
    id: 'm1',
    name: 'Покупка',
    task: 'Купи',
    createdAt: 0,
    startUrl: 'https://shop.example/',
    steps: [
      { action: { action: 'type', index: 1, text: '', submit: false }, target: 'input[type=password] "Пароль" value=""', url: '', secret: true },
      { action: { action: 'click', index: 9 }, target: 'button "Оплатить"', nth: 0, url: '' },
    ],
  };
  const page: ReplayObservation = { url: 'https://shop.example/', elements: [brief(4, 'input[type=password] "Пароль" value="•••"'), brief(6, 'button "Оплатить"')], handle: { frames: [], owner: {}, nodes: [] } };

  function deps(opts: { confirm?: boolean; secret?: string | null; elements?: ElementBrief[] } = {}) {
    const executed: AgentAction[] = [];
    const asked: string[] = [];
    const replay = new Replayer(
      macro,
      {
        observe: async () => ({ ...page, elements: opts.elements ?? page.elements }),
        execute: async (a) => (executed.push(a), { ok: true, message: 'ok' }),
        assess: (a): RiskReason[] => (a.action === 'click' ? [{ kind: 'payment', why: 'оплата' }] : []),
        confirm: async (t) => (asked.push(t), opts.confirm ?? true),
        ask: async () => (opts.secret === undefined ? 'pa$$' : opts.secret),
        sleep: async () => {},
        onState: () => {},
      },
      { findAttempts: 2, findDelayMs: 0, settleMs: 0 },
    );
    return { replay, executed, asked };
  }

  it('подставляет новые номера, спрашивает пароль и подтверждение оплаты', async () => {
    const { replay, executed, asked } = deps();
    expect((await replay.run()).status).toBe('done');
    expect(executed).toEqual([
      { action: 'type', index: 4, text: 'pa$$', submit: false },
      { action: 'click', index: 6 },
    ]);
    expect(asked[0]).toMatch(/Оплатить/);
  });

  it('отказ в подтверждении — стоп, ничего рискованного не выполнено', async () => {
    const { replay, executed } = deps({ confirm: false });
    expect((await replay.run()).status).toBe('stopped');
    expect(executed.map((a) => a.action)).toEqual(['type']);
  });

  it('элемента нет — failed с понятной причиной и задачей для нейросети', async () => {
    const { replay } = deps({ elements: [brief(1, 'a "Главная"')] });
    const st = await replay.run();
    expect(st.status).toBe('failed');
    expect(st.message).toMatch(/нет элемента/);
    expect(handoffTask(macro, st)).toMatch(/дошёл до шага 1 из 2/);
  });
});


it('replays safe steps with fresh indices, handles and real risk assessment without model requests', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const macro: Macro = { id: 'safe', name: 'safe', task: 'next', createdAt: 0, startUrl: 'https://example.test/', steps: [1, 2, 3].map((index) => ({ action: { action: 'click' as const, index }, target: 'button "Continue"', url: '' })) };
  let count = 0;
  const trace: string[] = [];
  const replay = new Replayer(macro, {
    observe: async () => { count++; trace.push(`observe:${count}`); return { url: 'https://example.test/', elements: [brief(count * 10, 'button "Continue"')], handle: { frames: [{ frameId: 0, snapshotId: count }], owner: { [count * 10]: 0 }, nodes: [] } }; },
    assess: (action, target, toTarget, obs) => {
      trace.push(`assess:${obs.handle.frames[0]!.snapshotId}:${'index' in action ? action.index : 0}`);
      return assessAction({ action, target, toTarget, url: obs.url, flags: [], modelFlag: false, rules: DEFAULT_RISK_RULES, policy: { mode: 'ask', safe: [] } });
    },
    execute: async (action, handle) => { trace.push(`execute:${handle.frames[0]!.snapshotId}:${'index' in action ? action.index : 0}`); return { ok: true, message: 'ok' }; },
    confirm: async () => { throw new Error('safe replay should not need confirmation'); },
    ask: async () => null, sleep: async () => {}, onState: () => {},
  }, { findAttempts: 1, findDelayMs: 0, settleMs: 0 });
  expect((await replay.run()).status).toBe('done');
  expect(trace).toEqual(['observe:1', 'assess:1:10', 'execute:1:10', 'observe:2', 'assess:2:20', 'execute:2:20', 'observe:3', 'assess:3:30', 'execute:3:30']);
  expect(fetchSpy).not.toHaveBeenCalled();
});
