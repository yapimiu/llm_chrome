import { exportUsage } from '@/lib/llm/usage';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { addDeferred, exportRun, getDeferred, getStepDetail, listDeferred, listRuns, loadRun, pruneDeferred, pruneRuns, resetLogDb, saveRun, saveStep, setDeferredStatus } from '@/lib/log/db';
import { postLog } from '@/lib/log/remote';
import { normalizeNavigateUrl } from '@/lib/tab-actions';
import type { DeferredItem, RunState, StepRecord } from '@/lib/agent/types';

const run = (id: string, startedAt: number, patch: Partial<RunState> = {}): RunState => ({
  id,
  task: `Задача ${id}`,
  profileLabel: 'Быстрый',
  model: 'qwen3',
  status: 'running',
  startedAt,
  maxSteps: 10,
  steps: [],
  extracted: [],
  ...patch,
});
const step = (n: number): StepRecord => ({ n, startedAt: n, url: 'https://e.com', reasoning: 'r', expectedOutcome: '', actions: [], warnings: [], notes: [] });

afterEach(async () => {
  await resetLogDb();
  indexedDB.deleteDatabase('agent-log');
});

describe('журнал IndexedDB', () => {
  it('сохраняет запуск, шаги и детали; экспорт собирает всё вместе', async () => {
    const r = run('a', 100, { steps: [step(1), step(2)] });
    await saveRun(r);
    await saveStep('a', step(1), { runId: 'a', n: 1, observation: 'obs1', history: '', responses: [{ content: '{}', reasoning: 'думаю' }] });
    await saveStep('a', step(2));
    expect(await getStepDetail('a', 1)).toMatchObject({ observation: 'obs1' });
    expect(await getStepDetail('a', 2)).toBeUndefined();

    const exported = await exportRun('a');
    expect(exported?.run).toMatchObject({ id: 'a', task: 'Задача a', stepCount: 2 });
    expect(exported?.run).not.toHaveProperty('steps');
    expect(exported?.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(exported?.steps[0]).toMatchObject({ observation: 'obs1', responses: [{ content: '{}', reasoning: 'думаю' }] });
    expect(await exportRun('нет')).toBeNull();
  });

  it('список — свежие сверху; обновление статуса перезаписывает запись', async () => {
    await saveRun(run('old', 1));
    await saveRun(run('new', 2));
    await saveRun(run('old', 1, { status: 'done', result: 'ok' }));
    const list = await listRuns();
    expect(list.map((r) => [r.id, r.status])).toEqual([
      ['new', 'running'],
      ['old', 'done'],
    ]);
  });

  it('pruneRuns удаляет старые запуски вместе с шагами', async () => {
    for (let i = 1; i <= 4; i++) {
      await saveRun(run(`r${i}`, i));
      await saveStep(`r${i}`, step(1), { runId: `r${i}`, n: 1, observation: 'o', history: '', responses: [] });
    }
    expect(await pruneRuns(2)).toBe(2);
    expect((await listRuns()).map((r) => r.id)).toEqual(['r4', 'r3']);
    expect(await getStepDetail('r1', 1)).toBeUndefined();
    expect(await exportRun('r2')).toBeNull();
  });
});

describe('postLog', () => {
  const event = { type: 'run' as const, runId: 'a', task: 't', status: 'done' as const, at: 'now' };
  it('POST JSON; ошибки не бросает, а возвращает', async () => {
    let body = '';
    const ok = await postLog('http://log.lan/x', event, async (_u, init) => {
      body = String(init?.body);
      return new Response(null, { status: 204 });
    });
    expect(ok).toBeNull();
    expect(JSON.parse(body)).toMatchObject({ runId: 'a', status: 'done' });
    expect(await postLog('http://log.lan/x', event, async () => new Response('', { status: 500 }))).toBe('HTTP 500');
    expect(
      await postLog('http://log.lan/x', event, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe('Failed to fetch');
  });
});

describe('normalizeNavigateUrl', () => {
  it.each([
    ['ya.ru', 'https://ya.ru/'],
    ['https://hh.ru/search?q=python', 'https://hh.ru/search?q=python'],
    ['http://192.168.0.3:8080', 'http://192.168.0.3:8080/'],
    ['  example.com/path ', 'https://example.com/path'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeNavigateUrl(input)).toBe(expected);
  });
  it.each(['', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi'])('отклоняет %j', (input) => {
    expect(normalizeNavigateUrl(input)).toBeNull();
  });
});

describe('этап 6: загрузка запуска и очередь', () => {
  const item = (id: string, createdAt: number, status: DeferredItem['status'] = 'pending'): DeferredItem => ({
    id,
    runId: 'a',
    task: 'Купить слона',
    createdAt,
    step: 3,
    url: 'https://shop.example/checkout',
    title: 'Оплата',
    actions: [{ action: { action: 'click', index: 7 }, target: 'button "Оплатить"', risk: [{ kind: 'payment', why: '«Оплатить»' }] }],
    reasoning: 'r',
    expectedOutcome: 'e',
    extracted: ['цена 100'],
    status,
  });

  it('loadRun возвращает запуск со всеми шагами по порядку', async () => {
    await saveRun(run('a', 100, { steps: [step(1), step(2)], inFlight: { step: 2, action: 0 } }));
    await saveStep('a', step(2));
    await saveStep('a', step(1));
    const r = await loadRun('a');
    expect(r?.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(r?.inFlight).toEqual({ step: 2, action: 0 });
    expect(r).not.toHaveProperty('stepCount');
    expect(r?.steps[0]).not.toHaveProperty('runId');
    expect(await loadRun('нет')).toBeNull();
  });

  it('очередь: ждущие сверху, смена статуса, чистка старых разобранных', async () => {
    await addDeferred(item('old-done', 1, 'dismissed'));
    await addDeferred(item('p1', 10));
    await addDeferred(item('p2', 20));
    await addDeferred(item('r1', 30, 'resumed'));
    expect((await listDeferred()).map((i) => i.id)).toEqual(['p2', 'p1', 'r1', 'old-done']);
    await setDeferredStatus('p2', 'dismissed');
    expect((await getDeferred('p2'))?.status).toBe('dismissed');
    expect(await getDeferred('нет')).toBeNull();
    expect(await pruneDeferred(10 + 14 * 24 * 3600 * 1000)).toBe(1);
    expect((await listDeferred()).map((i) => i.id)).toEqual(['p1', 'r1', 'p2']);
  });
});

describe('additive usage persistence', () => {
  it('roundtrips usage alongside legacy records without schema migration', async () => {
    await saveRun(run('usage', 1));
    const measured = { ...step(2), usage: { parseRetries: 1, attempts: [{ provider: 'local', requestedModel: 'model', format: 'none' as const, lean: false, outcome: 'success' as const, elapsedMs: 2, inputTokens: 0, outputTokens: null, cachedInputTokens: null }] } };
    await saveStep('usage', step(1));
    await saveStep('usage', measured);
    expect((await loadRun('usage'))?.steps[0]?.usage).toBeUndefined();
    expect((await loadRun('usage'))?.steps[1]?.usage).toEqual(measured.usage);
    expect((await exportRun('usage'))?.steps[1]?.usage).toEqual(measured.usage);
  });
});


it('exports light loaded accounting without loading heavy step details', async () => {
  await saveRun(run('usage-only', 1, { status: 'failed', task: 'PRIVATE_TASK' }));
  await saveStep('usage-only', { ...step(1), usage: { attempts: [], parseRetries: 2, parseErrors: 3, chatCalls: 3, unmeasuredChatCalls: 3 } }, { runId: 'usage-only', n: 1, observation: 'PRIVATE_PAGE', history: 'PRIVATE_HISTORY', responses: [{ content: 'PRIVATE_RESPONSE', reasoning: '' }] });
  const loaded = await loadRun('usage-only');
  expect(loaded).not.toBeNull();
  const safe = exportUsage(loaded!);
  expect(safe.summary).toMatchObject({ status: 'failed', parseErrors: { reported: 3, unknownSteps: 0 }, parseRetries: 2, chatCalls: 3 });
  expect(JSON.stringify(safe)).not.toContain('PRIVATE');
});
