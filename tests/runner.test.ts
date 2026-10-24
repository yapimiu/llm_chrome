import { describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '@/lib/agent/actions';
import { AgentRunner, MAX_DEFER_STREAK, MAX_SERVICE_ERRORS, type RunConfig, type RunDeps } from '@/lib/agent/runner';
import { DEFAULT_RISK_RULES } from '@/lib/agent/risk';
import type { ActionResult, DeferredItem, RunState } from '@/lib/agent/types';
import type { ElementFlag } from '@/lib/dom/types';
import { HttpError, type ChatResult } from '@/lib/llm/client';

const cfg: RunConfig = {
  task: 'Найди цену',
  systemTemplate: 'SYS',
  boundary: 'b',
  maxSteps: 10,
  maxActions: 4,
  loopThreshold: 2,
  stepTimeoutSec: 5,
  approveEachStep: false,
  contextTokens: 32768,
  maxOutputTokens: 1024,
  profileLabel: 'Быстрый',
  model: 'qwen3',
  siteNotes: [],
  autonomous: false,
  riskRules: DEFAULT_RISK_RULES,
  approvalWindowSec: 0,
  autoScrollAfter: 0,
};

const reply = (actions: unknown[], reasoning = 'r'): ChatResult => ({
  content: JSON.stringify({ reasoning, expected_outcome: 'e', actions }),
  reasoning: '',
  format: 'json_schema',
  totalMs: 1,
  ttftMs: 1,
});

interface Harness {
  deps: RunDeps;
  executed: AgentAction[];
  states: RunState[];
  chats: number;
  deferred: DeferredItem[];
  alerts: string[];
  /** Что лежало в чекпоинте перед каждым действием. */
  checkpoints: RunState[];
}

interface HarnessOpts {
  pages?: string[];
  exec?: (a: AgentAction) => ActionResult;
  url?: string;
  flags?: Record<number, ElementFlag[]>;
  /** sleep, который никогда не кончается, — окно подтверждения не истекает само. */
  slowSleep?: boolean;
}

function harness(replies: (ChatResult | Error)[], opts: HarnessOpts = {}): Harness {
  const h: Harness = { executed: [], states: [], chats: 0, deferred: [], alerts: [], checkpoints: [], deps: undefined as unknown as RunDeps };
  let page = 0;
  h.deps = {
    observe: vi.fn(async (o?: { maxChars?: number }) => {
      const text = opts.pages?.[Math.min(page++, opts.pages.length - 1)] ?? `[1] button "В корзину"\n[2] input "Поиск"\npage ${page}`;
      return {
        observation: o?.maxChars ? text.slice(0, o.maxChars) : text,
        tabs: [],
        handle: { frames: [{ frameId: 0, snapshotId: page }], owner: {}, nodes: [], flags: opts.flags },
        url: opts.url ?? 'https://shop.example/',
      };
    }),
    chat: vi.fn(async () => {
      h.chats++;
      const r = replies.shift();
      if (!r) throw new Error('no more replies');
      if (r instanceof Error) throw r;
      return r;
    }),
    execute: vi.fn(async (a: AgentAction) => {
      h.executed.push(a);
      return opts.exec?.(a) ?? { ok: true, message: 'ok' };
    }),
    onState: (s) => h.states.push(structuredClone(s)),
    onProgress: () => {},
    persistRun: vi.fn(async () => {}),
    persistStep: vi.fn(async () => {}),
    checkpoint: async (s) => {
      h.checkpoints.push(structuredClone(s));
    },
    defer: async (item) => {
      h.deferred.push(item);
    },
    alert: (m) => h.alerts.push(m),
    now: () => 1000,
    sleep: opts.slowSleep ? () => new Promise(() => {}) : async () => {},
    newId: () => 'run-1',
  };
  return h;
}

/** Ждём, пока runner перейдёт в нужный статус (для сценариев с ожиданием человека). */
async function until(runner: AgentRunner, status: RunState['status'], steps?: number): Promise<void> {
  const reached = () => runner.state.status === status && (steps === undefined || runner.state.steps.length === steps);
  for (let i = 0; i < 200 && !reached(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(runner.state.status).toBe(status);
}

describe('AgentRunner', () => {
  it('выполняет действия и завершается по done', async () => {
    const h = harness([reply([{ action: 'type', index: 2, text: 'ноутбук', submit: true }]), reply([{ action: 'extract', note: 'Цена 50 000' }, { action: 'done', result: 'Ноутбук стоит 50 000 ₽' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('done');
    expect(state.result).toBe('Ноутбук стоит 50 000 ₽');
    expect(state.extracted).toEqual(['Цена 50 000']);
    expect(h.executed).toEqual([{ action: 'type', index: 2, text: 'ноутбук', submit: true }]);
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]!.actions[0]!.target).toBe('input "Поиск"');
    expect(h.deps.persistStep).toHaveBeenCalledTimes(2);
  });

  it('заметки для сайта попадают в промпт по URL страницы', async () => {
    const h = harness([reply([{ action: 'done', result: 'ok' }])]);
    await new AgentRunner({ ...cfg, siteNotes: [{ pattern: 'shop.example', notes: '«Купить» = положить в корзину', hide: '', risk: 'ask', safe: '', next: '' }] }, h.deps).run();
    const prompt = vi.mocked(h.deps.chat).mock.calls[0]![0].at(-1)!.content;
    expect(prompt).toContain('«Купить» = положить в корзину\n\nReply with the JSON object');
    const detail = vi.mocked(h.deps.persistStep).mock.calls[0]![2];
    expect(detail.siteNotes).toBe('«Купить» = положить в корзину');
  });

  it('история предыдущих шагов уходит в следующий промпт', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
    await new AgentRunner(cfg, h.deps).run();
    const secondPrompt = vi.mocked(h.deps.chat).mock.calls[1]![0].at(-1)!.content;
    expect(secondPrompt).toContain('HISTORY:\nStep 1 (https://shop.example/):');
    expect(secondPrompt).toContain('click [1] (button "В корзину") → ok');
  });

  it('ошибка действия обрывает цепочку, остальное помечается пропущенным', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }]), reply([{ action: 'done', result: '' }])], {
      exec: (a) => (a.action === 'click' && a.index === 1 ? { ok: false, message: 'element [1] is gone' } : { ok: true, message: 'ok' }),
    });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(h.executed).toHaveLength(1);
    expect(state.steps[0]!.actions[1]!.skipped).toBe('previous action failed');
  });

  it('после перехода на другую страницу остаток цепочки не выполняется', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }]), reply([{ action: 'done', result: '' }])], {
      exec: () => ({ ok: true, message: 'page changed', navigated: true }),
    });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(h.executed).toHaveLength(1);
    expect(state.steps[0]!.actions[1]!.skipped).toMatch(/page changed/);
  });

  it('лимит шагов', async () => {
    const replies = Array.from({ length: 5 }, (_, i) => reply([{ action: 'scroll', direction: 'down', amount: 1 }], `шаг ${i}`));
    const h = harness(replies, { pages: ['p1', 'p2', 'p3', 'p4', 'p5'] });
    const state = await new AgentRunner({ ...cfg, maxSteps: 3 }, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/лимит шагов \(3\)/);
    expect(state.steps).toHaveLength(3);
  });

  it('детектор зацикливания: предупреждает модель, затем останавливает', async () => {
    const same = () => reply([{ action: 'click', index: 1 }]);
    const h = harness([same(), same(), same(), same(), same()], { pages: ['одна и та же страница'] });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/Зацикливание/);
    expect(state.steps[1]!.warnings.join()).toMatch(/^LOOP/);
    expect(h.executed).toHaveLength(3);
    const third = vi.mocked(h.deps.chat).mock.calls[2]![0].at(-1)!.content;
    expect(third).toContain('warning: LOOP');
  });

  it('цикл ловится, даже если всплывающие элементы меняют список, а номер элемента сдвигается', async () => {
    const pages = [1, 2, 3, 4, 5, 6].map((i) => `URL: https://practicum/lesson\n${i % 2 ? '' : '[1] div "Скопировано"\n'}[${i % 2 ? 13 : 14}] div "<!-- ссылка -->"`);
    const replies = [1, 2, 3, 4, 5, 6].map((i) => reply([{ action: 'click', index: i % 2 ? 13 : 14 }]));
    const h = harness(replies, { pages });
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/Зацикливание/);
    expect(state.steps).toHaveLength(4);
  });

  it('три ошибки модели подряд — остановка', async () => {
    const h = harness([new Error('HTTP 500'), new Error('HTTP 500'), new Error('HTTP 500')]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/3 раза подряд/);
    expect(state.steps.every((s) => s.error)).toBe(true);
  });

  it('перегрузка сервиса терпится дольше, чем негодные ответы модели', async () => {
    const down = () => new HttpError(503, 'This model is currently experiencing high demand.', 'u');
    // Столько же отказов, сколько убивает запуск при ошибках модели, — но запуск продолжается.
    const h = harness([down(), down(), down(), reply([{ action: 'done', result: 'ok' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('done');
    expect(state.steps.filter((s) => s.error).length).toBe(3);

    // Пока сервис не поднимется — ждём с растущей паузой и только потом сдаёмся.
    const h2 = harness(Array.from({ length: MAX_SERVICE_ERRORS + 2 }, down));
    const waits: number[] = [];
    h2.deps.sleep = async (ms) => void waits.push(ms);
    const dead = await new AgentRunner(cfg, h2.deps).run();
    expect(dead.status).toBe('failed');
    expect(dead.error).toMatch(/Сервис модели недоступен 8 раз подряд/);
    expect(waits).toEqual([5000, 15_000, 45_000, 120_000, 120_000, 120_000, 120_000]);
  });

  it('ошибка модели не фатальна, если следующий шаг удался', async () => {
    const h = harness([new Error('timeout'), reply([{ action: 'done', result: 'ok' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.status).toBe('done');
  });

  it('пошаговый режим: одобрение выполняет, отказ — нет и сообщает модели', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'click', index: 2 }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner({ ...cfg, approveEachStep: true }, h.deps);
    const done = runner.run();
    await until(runner, 'awaiting_approval');
    expect(runner.state.pendingApproval?.actions[0]!.action).toEqual({ action: 'click', index: 1 });
    runner.approve(false);
    await until(runner, 'awaiting_approval', 2);
    runner.approve(true);
    const state = await done;
    expect(state.status).toBe('done');
    expect(h.executed).toEqual([{ action: 'click', index: 2 }]);
    expect(state.steps[0]!.notes[0]).toMatch(/rejected/);
    // done не требует одобрения
    expect(state.steps[2]!.actions[0]!.result?.ok).toBe(true);
  });

  it('ask_user: ждёт ответа и передаёт его модели', async () => {
    const h = harness([reply([{ action: 'ask_user', question: 'Какой город?' }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner(cfg, h.deps);
    const done = runner.run();
    await until(runner, 'asking_user');
    expect(runner.state.question).toBe('Какой город?');
    runner.answer('Казань');
    const state = await done;
    expect(state.steps[0]!.notes).toEqual(['User answered: Казань']);
    expect(vi.mocked(h.deps.chat).mock.calls[1]![0].at(-1)!.content).toContain('note: User answered: Казань');
  });

  it('пауза вступает в силу перед действием, продолжить — выполняет', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
    const runner = new AgentRunner(cfg, h.deps);
    runner.pause();
    const done = runner.run();
    await until(runner, 'paused');
    expect(h.executed).toHaveLength(0);
    runner.resume();
    expect((await done).status).toBe('done');
  });

  it('стоп во время ожидания одобрения', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }])]);
    const runner = new AgentRunner({ ...cfg, approveEachStep: true }, h.deps);
    const done = runner.run();
    await until(runner, 'awaiting_approval');
    runner.stop();
    const state = await done;
    expect(state.status).toBe('stopped');
    expect(h.executed).toHaveLength(0);
    expect(state.pendingApproval).toBeUndefined();
  });

  it('таймаут действия превращается в ошибку действия', async () => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: '' }])]);
    h.deps.execute = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const done = new AgentRunner({ ...cfg, stepTimeoutSec: 1 }, h.deps).run();
      await vi.advanceTimersByTimeAsync(1500);
      const state = await done;
      expect(state.steps[0]!.actions[0]!.result).toEqual({ ok: false, message: 'click timed out after 1s' });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('этап 6: рискованные действия', () => {
    const payPage = ['[1] button "Оплатить 500 ₽"\n[2] input "Комментарий"'];
    const payAndDone = () => [
      reply([{ action: 'type', index: 2, text: 'Спасибо', submit: false }, { action: 'click', index: 1 }]),
      reply([{ action: 'done', result: 'Готово' }]),
    ];

    it('обычный режим: рискованный шаг ждёт одобрения, даже если пошаговый режим выключен', async () => {
      const h = harness(payAndDone(), { pages: payPage });
      const runner = new AgentRunner(cfg, h.deps);
      const done = runner.run();
      await until(runner, 'awaiting_approval');
      const pending = runner.state.pendingApproval!;
      expect(pending.deadline).toBeUndefined();
      expect(pending.actions[0]!.risk).toBeUndefined();
      expect(pending.actions[1]!.risk?.[0]?.kind).toBe('payment');
      expect(h.executed).toHaveLength(0);
      runner.approve(true);
      const state = await done;
      expect(state.status).toBe('done');
      expect(h.executed).toHaveLength(2);
      expect(h.deferred).toHaveLength(0);
    });

    it('обычный режим: безопасные шаги идут без остановок', async () => {
      const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner(cfg, h.deps).run();
      expect(state.status).toBe('done');
      expect(h.states.some((s) => s.status === 'awaiting_approval')).toBe(false);
    });

    it('флаг risky от модели тоже требует одобрения', async () => {
      const step = { reasoning: 'r', expected_outcome: 'e', risky: true, actions: [{ action: 'click', index: 1 }] };
      const h = harness([{ ...reply([]), content: JSON.stringify(step) }, reply([{ action: 'done', result: 'ok' }])]);
      const runner = new AgentRunner(cfg, h.deps);
      const done = runner.run();
      await until(runner, 'awaiting_approval');
      expect(runner.state.pendingApproval!.actions[0]!.risk?.[0]?.kind).toBe('model');
      runner.approve(false);
      expect((await done).steps[0]!.actions[0]!.skipped).toBe('rejected by the user');
    });

    it('автономный режим: сигнал, безопасная часть цепочки выполняется, рискованное — в очередь', async () => {
      const h = harness(payAndDone(), { pages: payPage });
      const state = await new AgentRunner({ ...cfg, autonomous: true }, h.deps).run();
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toContain('Оплатить');
      expect(h.executed).toEqual([{ action: 'type', index: 2, text: 'Спасибо', submit: false }]);
      expect(h.deferred).toHaveLength(1);
      const item = h.deferred[0]!;
      expect(item).toMatchObject({ runId: 'run-1', task: cfg.task, step: 1, url: 'https://shop.example/', status: 'pending' });
      expect(item.actions.map((a) => a.action)).toEqual([{ action: 'click', index: 1 }]);
      expect(state.steps[0]!.actions[1]!.skipped).toMatch(/postponed/);
      expect(vi.mocked(h.deps.chat).mock.calls[1]![0].at(-1)!.content).toContain('note: POSTPONED: click [1]');
      expect(state.status).toBe('done');
      expect(state.result).toBe('Готово\n\n⏸ Ждут вашего подтверждения в очереди: 1.');
    });

    it('автономный режим: одно и то же не откладывается дважды, а упорство завершает запуск', async () => {
      const pay = () => reply([{ action: 'click', index: 1 }]);
      const h = harness(Array.from({ length: 6 }, pay), { pages: payPage });
      const state = await new AgentRunner({ ...cfg, autonomous: true, loopThreshold: 10 }, h.deps).run();
      expect(h.deferred).toHaveLength(1);
      expect(h.alerts).toHaveLength(1);
      expect(state.status).toBe('deferred');
      expect(state.steps).toHaveLength(MAX_DEFER_STREAK);
      expect(state.steps[1]!.actions[0]!.skipped).toMatch(/already postponed/);
      expect(state.result).toMatch(/Ждут подтверждения в очереди: 1/);
    });

    it('автономный режим: если человек успел нажать «Выполнить» за окно ожидания — выполняется', async () => {
      const h = harness(payAndDone(), { pages: payPage, slowSleep: true });
      const runner = new AgentRunner({ ...cfg, autonomous: true, approvalWindowSec: 120 }, h.deps);
      const done = runner.run();
      await until(runner, 'awaiting_approval');
      expect(runner.state.pendingApproval!.deadline).toBe(1000 + 120_000);
      runner.approve(true);
      const state = await done;
      expect(h.executed).toHaveLength(2);
      expect(h.deferred).toHaveLength(0);
      expect(state.result).toBe('Готово');
    });

    it('автономный режим: окно ожидания истекло — в очередь', async () => {
      const h = harness(payAndDone(), { pages: payPage });
      const state = await new AgentRunner({ ...cfg, autonomous: true, approvalWindowSec: 120 }, h.deps).run();
      expect(h.states.some((s) => s.status === 'awaiting_approval' && s.pendingApproval?.deadline)).toBe(true);
      expect(h.deferred).toHaveLength(1);
      expect(state.status).toBe('done');
    });

    it('автономный режим: пошаговый режим не действует, ask_user — модель решает сама', async () => {
      const h = harness([reply([{ action: 'click', index: 2 }]), reply([{ action: 'ask_user', question: 'Какой цвет?' }]), reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner({ ...cfg, autonomous: true, approveEachStep: true }, h.deps).run();
      expect(state.status).toBe('done');
      expect(h.executed).toHaveLength(1);
      expect(state.steps[1]!.notes[0]).toMatch(/asleep/);
      expect(h.states.some((s) => s.status === 'asking_user' || s.status === 'awaiting_approval')).toBe(false);
    });

    it('запрет на сайте: действие не выполняется, модель узнаёт об этом', async () => {
      const siteNotes = [{ pattern: 'shop.example', notes: '', hide: '', risk: 'block' as const, safe: '', next: '' }];
      const h = harness(payAndDone(), { pages: payPage });
      const state = await new AgentRunner({ ...cfg, siteNotes }, h.deps).run();
      expect(h.executed).toHaveLength(1); // только ввод комментария
      expect(state.steps[0]!.actions[1]!.result?.ok).toBe(false);
      expect(state.steps[0]!.notes[0]).toMatch(/^BLOCKED/);
      expect(h.deferred).toHaveLength(0);
    });

    it('разрешение на сайте: выполняется без подтверждения', async () => {
      const siteNotes = [{ pattern: 'shop.example', notes: '', hide: '', risk: 'allow' as const, safe: '', next: '' }];
      const h = harness(payAndDone(), { pages: payPage });
      const state = await new AgentRunner({ ...cfg, siteNotes }, h.deps).run();
      expect(state.status).toBe('done');
      expect(h.executed).toHaveLength(2);
    });

    it('ввод пароля определяется по флагам элемента', async () => {
      const h = harness([reply([{ action: 'type', index: 2, text: 'secret', submit: false }])], { flags: { 2: ['secret'] } });
      const runner = new AgentRunner(cfg, h.deps);
      const done = runner.run();
      await until(runner, 'awaiting_approval');
      expect(runner.state.pendingApproval!.actions[0]!.risk?.[0]?.kind).toBe('secret');
      runner.stop();
      await done;
    });
  });

  describe('этап 6: чекпоинты', () => {
    it('перед действием в чекпоинте записано, какое действие выполняется', async () => {
      const h = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }]), reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner(cfg, h.deps).run();
      expect(h.checkpoints.map((c) => c.inFlight)).toEqual([
        { step: 1, action: 0 },
        { step: 1, action: 1 },
      ]);
      expect(state.inFlight).toBeUndefined();
      expect(state.loop?.count).toBe(1);
    });

    it('продолжение после перезапуска: прерванное действие помечено, модель предупреждена', async () => {
      // Первый запуск «умер» посреди второго действия.
      const first = harness([reply([{ action: 'click', index: 1 }, { action: 'click', index: 2 }, { action: 'scroll', direction: 'down', amount: 1 }])]);
      first.deps.execute = vi.fn(async (a: AgentAction) => (a.action === 'click' && a.index === 2 ? new Promise<ActionResult>(() => {}) : { ok: true, message: 'ok' }));
      void new AgentRunner({ ...cfg, stepTimeoutSec: 3600 }, first.deps).run();
      for (let i = 0; i < 50 && first.checkpoints.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
      const saved = first.checkpoints.at(-1)!;
      expect(saved.inFlight).toEqual({ step: 1, action: 1 });

      const second = harness([reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner(cfg, second.deps, structuredClone(saved)).run();
      expect(state.status).toBe('done');
      expect(state.restarts).toBe(1);
      const acts = state.steps[0]!.actions;
      expect(acts[0]!.result?.ok).toBe(true);
      expect(acts[1]!.result).toEqual({ ok: false, message: 'interrupted by a restart — it may or may not have happened' });
      expect(acts[2]!.skipped).toBe('not executed: the agent was restarted');
      const prompt = vi.mocked(second.deps.chat).mock.calls[0]![0].at(-1)!.content;
      expect(prompt).toContain('note: The agent was restarted');
      expect(prompt).toContain('interrupted by a restart');
    });

    it('шаг, ждущий одобрения или ответа, попадает в чекпоинт до ожидания', async () => {
      const h = harness([reply([{ action: 'click', index: 1 }])], { pages: ['[1] button "Удалить"'] });
      const runner = new AgentRunner(cfg, h.deps);
      const done = runner.run();
      await until(runner, 'awaiting_approval');
      const cp = h.checkpoints.at(-1)!;
      expect(cp.status).toBe('awaiting_approval');
      expect(cp.steps).toHaveLength(1);
      runner.stop();
      await done;

      const h2 = harness([reply([{ action: 'ask_user', question: 'Какой?' }])]);
      const r2 = new AgentRunner(cfg, h2.deps);
      const d2 = r2.run();
      await until(r2, 'asking_user');
      expect(h2.checkpoints.at(-1)).toMatchObject({ status: 'asking_user', question: 'Какой?' });
      r2.stop();
      await d2;
    });

    it('после перезапуска незаданный вопрос ask_user ждёт ответа, одобрение — перепланируется', async () => {
      const base: RunState = {
        id: 'old',
        task: cfg.task,
        profileLabel: 'Быстрый',
        model: 'qwen3',
        status: 'asking_user',
        question: 'Какой город?',
        startedAt: 1,
        maxSteps: 10,
        extracted: ['цена 100'],
        steps: [{ n: 1, startedAt: 1, url: 'https://shop.example/', reasoning: '', expectedOutcome: '', actions: [{ action: { action: 'ask_user', question: 'Какой город?' }, result: { ok: true, message: 'question shown to the user' } }], warnings: [], notes: [] }],
      };
      const h = harness([reply([{ action: 'done', result: 'ok' }])]);
      const runner = new AgentRunner(cfg, h.deps, structuredClone(base));
      const done = runner.run();
      await until(runner, 'asking_user');
      runner.answer('Казань');
      const state = await done;
      expect(state.id).toBe('old');
      expect(state.extracted).toEqual(['цена 100']);
      expect(state.steps[0]!.notes).toEqual([expect.stringMatching(/restarted/), 'User answered: Казань']);

      const pending: RunState = { ...structuredClone(base), status: 'awaiting_approval', question: undefined, pendingApproval: { actions: [], reasoning: '' } };
      delete pending.question;
      const h2 = harness([reply([{ action: 'done', result: 'ok' }])]);
      const s2 = await new AgentRunner(cfg, h2.deps, pending).run();
      expect(s2.status).toBe('done');
      expect(s2.pendingApproval).toBeUndefined();
    });

    it('ночью прерванный вопрос не ждёт ответа', async () => {
      const base: RunState = {
        id: 'old', task: cfg.task, profileLabel: '', model: '', status: 'asking_user', question: '?', startedAt: 1, maxSteps: 10, extracted: [],
        steps: [{ n: 1, startedAt: 1, url: '', reasoning: '', expectedOutcome: '', actions: [], warnings: [], notes: [] }],
      };
      const h = harness([reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner({ ...cfg, autonomous: true }, h.deps, base).run();
      expect(state.status).toBe('done');
      expect(state.steps[0]!.notes.join('\n')).toMatch(/asleep/);
    });
  });

  describe('застревание: принудительная прокрутка вниз', () => {
    // Как на тренажёре Практикума: код вставлен, «Проверить» неактивна, модель вставляет код снова.
    const lesson = 'URL: https://practicum.yandex.ru/learn/x\nScroll: y=0 of 2000 (0%), viewport 1200x800\n[21] code-editor lines="19"\n[22] button "Проверить" disabled';
    const typeCode = { action: 'type', index: 21, text: '<!DOCTYPE html>', submit: false };
    const exec = (a: AgentAction): ActionResult =>
      a.action === 'click' ? { ok: false, message: 'element [22] is disabled' } : a.action === 'scroll' ? { ok: true, message: 'scrolled' } : { ok: true, message: 'typed' };

    it('после N шагов без пользы агент сам прокручивает вниз и говорит об этом модели', async () => {
      const h = harness(
        [reply([typeCode, { action: 'click', index: 22 }]), reply([typeCode]), reply([{ action: 'done', result: 'ok' }])],
        { pages: [lesson, lesson, lesson.replace('y=0', 'y=800')], exec },
      );
      const state = await new AgentRunner({ ...cfg, autoScrollAfter: 2 }, h.deps).run();
      expect(h.executed.map((a) => a.action)).toEqual(['type', 'click', 'type', 'scroll']);
      expect(state.steps[0]!.notes).toEqual([]);
      expect(state.steps[1]!.notes[0]).toMatch(/^AUTO-SCROLL/);
      expect(vi.mocked(h.deps.chat).mock.calls[2]![0].at(-1)!.content).toContain('note: AUTO-SCROLL');
    });

    it('внизу страницы не крутит, а прямо говорит, что модель ходит по кругу', async () => {
      const bottom = lesson.replace('y=0 of 2000 (0%)', 'y=2000 of 2000 (100%)');
      const h = harness([reply([typeCode, { action: 'click', index: 22 }]), reply([typeCode]), reply([{ action: 'done', result: 'ok' }])], { pages: [bottom], exec });
      const state = await new AgentRunner({ ...cfg, autoScrollAfter: 2 }, h.deps).run();
      expect(h.executed.map((a) => a.action)).not.toContain('scroll');
      expect(state.steps[1]!.notes[0]).toMatch(/^STUCK/);
    });

    it('полезные шаги на той же странице (заполнение формы) не считаются застреванием', async () => {
      const form = 'URL: https://x.example/form\nScroll: y=0 of 2000 (0%)\n[1] input "Имя"\n[2] input "Город"';
      const h = harness(
        [reply([{ action: 'type', index: 1, text: 'Илья', submit: false }]), reply([{ action: 'type', index: 2, text: 'Воронеж', submit: false }]), reply([{ action: 'done', result: 'ok' }])],
        { pages: [form] },
      );
      await new AgentRunner({ ...cfg, autoScrollAfter: 2 }, h.deps).run();
      expect(h.executed.map((a) => a.action)).toEqual(['type', 'type']);
    });
  });

  describe('авточтение страницы', () => {
    const readCalls = (h: Harness) => h.executed.filter((a) => a.action === 'read');

    it('выключено — read не вызывается', async () => {
      const h = harness([reply([{ action: 'done', result: 'ok' }])]);
      await new AgentRunner(cfg, h.deps).run();
      expect(readCalls(h)).toHaveLength(0);
    });

    it('включено — новая страница читается до выбора действия, затем наблюдение берётся заново, с пометкой в шаге', async () => {
      const h = harness([reply([{ action: 'done', result: 'ok' }])]);
      const runner = new AgentRunner({ ...cfg, autoRead: true }, h.deps);
      const state = await runner.run();
      expect(readCalls(h)).toEqual([{ action: 'read' }]);
      expect(h.deps.observe).toHaveBeenCalledTimes(2);
      expect(state.steps[0]!.notes.some((n) => n.startsWith('AUTO-READ:'))).toBe(true);
    });

    it('один адрес читается один раз за запуск; новый адрес — снова', async () => {
      let url = 'https://a.example/';
      const h = harness([
        reply([{ action: 'click', index: 1 }]),
        reply([{ action: 'click', index: 1 }]),
        reply([{ action: 'done', result: 'ok' }]),
      ]);
      const baseObserve = h.deps.observe;
      h.deps.observe = vi.fn(async (o) => ({ ...(await baseObserve(o)), url }));
      const execute = h.deps.execute;
      h.deps.execute = vi.fn(async (a, handle, signal) => {
        if (a.action === 'click') url = 'https://b.example/';
        return execute(a, handle, signal);
      });
      await new AgentRunner({ ...cfg, autoRead: true }, h.deps).run();
      expect(readCalls(h)).toHaveLength(2);
    });

    it('сбой чтения (нет отладчика) не мешает шагу и попадает в пометку', async () => {
      const h = harness([reply([{ action: 'done', result: 'ok' }])], { exec: (a) => (a.action === 'read' ? { ok: false, message: 'needs debugger' } : { ok: true, message: 'ok' }) });
      const state = await new AgentRunner({ ...cfg, autoRead: true }, h.deps).run();
      expect(state.status).toBe('done');
      expect(state.steps[0]!.notes).toContain('AUTO-READ skipped: needs debugger');
      expect(h.deps.observe).toHaveBeenCalledTimes(1);
    });
  });

  describe('автосмена моделей', () => {
    const lvl = (id: string, external = false, vision = false) => ({ id, label: id, model: `${id}-m`, contextTokens: 16000, maxOutputTokens: 700, vision, external });
    const esc = { levels: [lvl('qwen'), lvl('big'), lvl('cloud', true)], failStreak: 2, returnAfter: 2 };
    const fail = (a: AgentAction): ActionResult => (a.action === 'click' ? { ok: false, message: 'covered' } : { ok: true, message: 'ok' });

    it('без настройки работает одна модель: chat без профиля ступени', async () => {
      const h = harness([reply([{ action: 'done', result: 'ok' }])]);
      await new AgentRunner(cfg, h.deps).run();
      expect((h.deps.chat as ReturnType<typeof vi.fn>).mock.calls[0]![5]).toBeUndefined();
    });

    it('две неудачи подряд — следующий шаг идёт на сильной модели, с заметкой о смене; потом возврат', async () => {
      const click = { action: 'click', index: 1 };
      const h = harness(
        [reply([click]), reply([click]), reply([{ action: 'type', index: 2, text: 'a', submit: false }]), reply([{ action: 'type', index: 2, text: 'b', submit: false }]), reply([{ action: 'type', index: 2, text: 'c', submit: false }]), reply([{ action: 'done', result: 'ok' }])],
        { exec: fail },
      );
      const state = await new AgentRunner({ ...cfg, escalation: esc, loopThreshold: 9 }, h.deps).run();
      const used = (h.deps.chat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[5]);
      expect(used).toEqual(['qwen', 'qwen', 'big', 'big', 'qwen', 'qwen']);
      expect(state.steps[2]!.notes.some((n) => n.startsWith('MODEL SWITCH: qwen → big'))).toBe(true);
      expect(state.steps[4]!.notes.some((n) => n.startsWith('MODEL SWITCH: big → qwen'))).toBe(true);
      expect(state.steps[2]!.llm).toMatchObject({ model: 'big-m', profile: 'big' });
      expect(state.profileLabel).toBe('qwen');
    });

    it('переход на внешнюю модель сопровождается уведомлением; на внутреннюю — нет', async () => {
      const click = { action: 'click', index: 1 };
      const h = harness([reply([click]), reply([click]), reply([click]), reply([click]), reply([{ action: 'done', result: 'ok' }])], { exec: fail });
      await new AgentRunner({ ...cfg, escalation: esc, loopThreshold: 9 }, h.deps).run();
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toMatch(/cloud/);
    });

    it('зацикливание переводит на сильную модель сразу и даёт ей чистый счётчик повторов', async () => {
      const same = reply([{ action: 'click', index: 1 }]);
      const h = harness([same, same, reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner({ ...cfg, escalation: esc, loopThreshold: 2 }, h.deps).run();
      const used = (h.deps.chat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[5]);
      expect(used[0]).toBe('qwen');
      expect(used.at(-1)).toBe('big');
      expect(state.status).toBe('done');
    });

    it('ступень запоминается в состоянии — после перезапуска запуск продолжается на той же модели', async () => {
      const click = { action: 'click', index: 1 };
      const h = harness([reply([click]), reply([click]), reply([{ action: 'done', result: 'ok' }])], { exec: fail });
      const state = await new AgentRunner({ ...cfg, escalation: esc, loopThreshold: 9 }, h.deps).run();
      expect(state.escalation?.level).toBe(1);
    });

    it('картинки — только если модель текущей ступени их понимает', async () => {
      const withVision = { levels: [lvl('qwen', false, false), lvl('big', false, true)], failStreak: 1, returnAfter: 9 };
      const click = { action: 'click', index: 1 };
      const h = harness([reply([click]), reply([{ action: 'done', result: 'ok' }])], { exec: fail });
      await new AgentRunner({ ...cfg, screenshots: 'always', escalation: withVision, loopThreshold: 9 }, h.deps).run();
      const shots = (h.deps.observe as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { screenshot: boolean }).screenshot);
      expect(shots).toEqual([false, true]);
    });
  });

  describe('автосброс контекста', () => {
    const big = `[1] button "В корзину"\n${'длинный текст страницы '.repeat(900)}`;

    it('страница не влезает в бюджет — снимается заново покороче, в шаге заметка, счётчик сбросов растёт', async () => {
      const h = harness([reply([{ action: 'done', result: 'ok' }])], { pages: [big] });
      const state = await new AgentRunner({ ...cfg, contextTokens: 6000, maxOutputTokens: 500, contextResetPercent: 85 }, h.deps).run();
      const calls = (h.deps.observe as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { maxChars?: number } | undefined)?.maxChars);
      expect(calls[0]).toBeUndefined();
      expect(typeof calls[1]).toBe('number');
      expect(state.steps[0]!.notes.some((n) => n.startsWith('CONTEXT RESET: page text shortened'))).toBe(true);
      expect(state.contextResets).toBeGreaterThanOrEqual(1);
    });

    it('выключено (0) или всё влезает — сброса нет', async () => {
      const off = harness([reply([{ action: 'done', result: 'ok' }])], { pages: [big] });
      const s1 = await new AgentRunner({ ...cfg, contextTokens: 6000, contextResetPercent: 0 }, off.deps).run();
      expect(s1.contextResets).toBeUndefined();
      const fits = harness([reply([{ action: 'done', result: 'ok' }])]);
      const s2 = await new AgentRunner({ ...cfg, contextResetPercent: 85 }, fits.deps).run();
      expect(s2.contextResets).toBeUndefined();
    });
  });

  describe('read: потолок времени и пошаговый режим', () => {
    it('зависшее чтение обрывается по потолку, и прокрутке подаётся сигнал остановки', async () => {
      let signal: AbortSignal | undefined;
      const h = harness([reply([{ action: 'read' }]), reply([{ action: 'done', result: 'ok' }])]);
      h.deps.execute = vi.fn(async (a: AgentAction, _handle, s?: AbortSignal) => {
        if (a.action !== 'read') return { ok: true, message: 'ok' };
        signal = s;
        return new Promise<ActionResult>(() => {});
      });
      const state = await new AgentRunner({ ...cfg, readTimeoutSec: 0.05 }, h.deps).run();
      expect(state.steps[0]!.actions[0]!.result).toMatchObject({ ok: false, message: expect.stringMatching(/read timed out/) });
      expect(signal?.aborted).toBe(true);
      expect(state.status).toBe('done');
    });

    it('в пошаговом режиме read не требует подтверждения, как и scroll', async () => {
      const h = harness([reply([{ action: 'read' }]), reply([{ action: 'done', result: 'ok' }])]);
      const state = await new AgentRunner({ ...cfg, approveEachStep: true }, h.deps).run();
      expect(state.status).toBe('done');
      expect(h.executed.map((a) => a.action)).toEqual(['read']);
    });
  });
});


describe('transport accounting integration', () => {
  it('marks mock/legacy chat implementations without callbacks as unmeasured', async () => {
    const h = harness([reply([{ action: 'done', result: 'ok' }])]);
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.steps[0]?.usage).toMatchObject({ chatCalls: 1, unmeasuredChatCalls: 1, attempts: [] });
  });

  const transport = { provider: 'local', requestedModel: 'qwen3', format: 'none' as const, lean: false, outcome: 'success' as const, elapsedMs: 1, inputTokens: 10, outputTokens: 2, cachedInputTokens: null };
  it('retains all parse retries and model identity in step accounting', async () => {
    const h = harness([]);
    let calls = 0;
    h.deps.chat = async (_m, _s, _d, _r, _signal, _id, onAttempt) => {
      onAttempt?.({ ...transport });
      calls++;
      return calls < 3 ? { ...reply([]), content: 'invalid' } : reply([{ action: 'done', result: 'ok' }]);
    };
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.steps[0]?.usage).toMatchObject({ parseRetries: 2, chatCalls: 3, unmeasuredChatCalls: 0, attempts: [transport, transport, transport] });
  });
  it('persists failure accounting before ending the step', async () => {
    const h = harness([]);
    h.deps.chat = async (_m, _s, _d, _r, _signal, _id, onAttempt) => {
      onAttempt?.({ ...transport, outcome: 'http-error', status: 401, inputTokens: null, outputTokens: null });
      throw new HttpError(401, 'PRIVATE_BODY', 'PRIVATE_URL');
    };
    const state = await new AgentRunner(cfg, h.deps).run();
    expect(state.steps[0]?.usage?.attempts[0]).toMatchObject({ status: 401, inputTokens: null });
    expect(h.deps.persistStep).toHaveBeenCalled();
  });
  it('persists an in-flight attempt on stop', async () => {
    const h = harness([]);
    const runner = new AgentRunner(cfg, h.deps);
    h.deps.chat = async (_m, _s, _d, _r, signal, _id, onAttempt) => {
      runner.stop();
      onAttempt?.({ ...transport, outcome: 'aborted' });
      signal.throwIfAborted();
      return reply([]);
    };
    const state = await runner.run();
    expect(state.status).toBe('stopped');
    expect(state.steps[0]?.usage?.attempts[0]?.outcome).toBe('aborted');
    expect(h.deps.persistStep).toHaveBeenCalled();
  });
});

describe('adaptive observations always bind fresh handles', () => {
  it.each(['incomplete', 'navigation'])('reobserves Standard before LLM when Minimal has %s', async (reason) => {
    const h = harness([reply([{ action: 'click', index: 1 }]), reply([{ action: 'click', index: 1 }]), reply([{ action: 'done', result: 'ok' }])]);
    const original = h.deps.observe;
    let count = 0;
    const options: { maxChars?: number; maxTextPerElement?: number }[] = [];
    h.deps.observe = async (opts) => {
      count++;
      options.push(opts ?? {});
      const obs = await original(opts);
      return { ...obs, complete: count === 2 ? reason !== 'incomplete' : true, url: count === 2 && reason === 'navigation' ? 'https://new.example/' : obs.url, handle: { ...obs.handle, frames: [{ frameId: 0, snapshotId: count }] } };
    };
    const handles: number[] = [];
    h.deps.execute = async (_a, handle) => { handles.push(handle.frames[0]!.snapshotId); return { ok: true, message: 'ok' }; };
    await new AgentRunner({ ...cfg, observationMode: 'adaptive', maxObservationChars: 12000 }, h.deps).run();
    expect(options.slice(0, 3).map((o) => o.maxChars)).toEqual([12000, 4000, 12000]);
    expect(handles.slice(0, 2)).toEqual([1, 3]);
    expect(h.chats).toBe(3);
  });
});


it('preserves the current dependency cap for restored configs without an observation cap', async () => {
  const h = harness([reply([{ action: 'done', result: 'ok' }])]);
  const original = h.deps.observe;
  h.deps.observe = async (opts) => ({ ...await original(opts), observation: 'x'.repeat(Math.min(25000, opts?.maxChars ?? Infinity)) });
  await new AgentRunner({ ...cfg, contextTokens: 64000 }, h.deps).run();
  const sent = vi.mocked(h.deps.chat).mock.calls[0]![0];
  expect(JSON.stringify(sent)).toContain('x'.repeat(25000));
});


it('counts the final exhausted invalid reply as a parse error without an extra retry', async () => {
  const invalid = { ...reply([]), content: 'invalid' };
  const h = harness([invalid, invalid, invalid, reply([{ action: 'done', result: 'ok' }])]);
  const state = await new AgentRunner(cfg, h.deps).run();
  expect(state.steps[0]?.usage).toMatchObject({ parseErrors: 3, parseRetries: 2, chatCalls: 3 });
  expect(state.steps[1]?.usage).toMatchObject({ parseErrors: 0, parseRetries: 0, chatCalls: 1 });
});
