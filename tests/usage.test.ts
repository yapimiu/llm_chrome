import { describe, expect, it, vi } from 'vitest';
import { chatStream, resetFormatCache, type FetchFn } from '@/lib/llm/client';
import { exportUsage, formatRunUsage, modelIdentity, summarizeRunUsage, type HttpAttempt } from '@/lib/llm/usage';
import { DEFAULT_SETTINGS } from '@/lib/settings';
const profile = { ...DEFAULT_SETTINGS.profiles.fast, baseUrl: 'http://example.test/?key=SECRET', model: 'requested' };
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
const call = (fetchImpl: FetchFn, attempts: HttpAttempt[], patch = {}) => chatStream({ profile, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], fetchImpl, onAttempt: (a) => attempts.push(a), ...patch });

describe('transport usage', () => {
  it('counts format and lean fallback; preserves cumulative partial usage and model override', async () => {
    resetFormatCache();
    const attempts: HttpAttempt[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('json_schema PRIVATE_BODY', { status: 400 })).mockResolvedValueOnce(new Response('stream_options PRIVATE_BODY', { status: 400 })).mockResolvedValueOnce(sse([
      { model: 'reported', usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } } },
      { usage: { completion_tokens: 0 } },
    ]));
    await call(fetchImpl, attempts, { profile: { ...profile, extraBody: '{"model":"override"}' }, schema: {} });
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attemptInChat)).toEqual([1, 2, 3]);
    expect(summarizeRunUsage({ steps: [{ usage: { attempts, parseRetries: 0 } }] }).transportRetries).toBe(2);
    expect(attempts.map((a) => [a.format, a.lean, a.outcome])).toEqual([['json_schema', false, 'http-error'], ['json_object', false, 'http-error'], ['json_object', true, 'success']]);
    expect(attempts[2]).toMatchObject({ requestedModel: 'override', reportedModel: 'reported', inputTokens: 10, outputTokens: 0, cachedInputTokens: 3 });
    expect(JSON.stringify(attempts)).not.toMatch(/PRIVATE|SECRET|example\.test/);
  });
  it('counts transient failures without real waits', async () => {
    vi.useFakeTimers();
    try {
      const attempts: HttpAttempt[] = [];
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(sse([]));
      const pending = call(fetchImpl, attempts);
      await vi.runAllTimersAsync();
      await pending;
      expect(attempts).toHaveLength(2);
      expect(attempts.every((a) => a.inputTokens === null)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('retains reported usage when a stream subsequently fails', async () => {
    const attempts: HttpAttempt[] = [];
    await expect(call(vi.fn(async () => sse([{ usage: { prompt_tokens: 0 } }, { error: { message: 'PRIVATE_BODY' } }])), attempts)).rejects.toThrow();
    expect(attempts[0]).toMatchObject({ outcome: 'stream-error', inputTokens: 0, outputTokens: null });
    expect(JSON.stringify(attempts)).not.toContain('PRIVATE');
  });
  it('records aborted fetch and ignores observer exceptions', async () => {
    const ctrl = new AbortController();
    const attempts: HttpAttempt[] = [];
    await expect(call(vi.fn(async () => { ctrl.abort(); throw ctrl.signal.reason; }), attempts, { signal: ctrl.signal })).rejects.toThrow();
    expect(attempts[0]?.outcome).toBe('aborted');
    await expect(call(vi.fn(async () => sse([])), [], { onAttempt: () => { throw new Error('observer'); } })).resolves.toBeDefined();
  });
  it('does not count invalid configuration as an HTTP attempt', async () => {
    const attempts: HttpAttempt[] = [];
    const fetchImpl = vi.fn();
    await expect(call(fetchImpl, attempts, { profile: { ...profile, extraBody: '{' } })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
  });
});

describe('task usage summary and isolated export', () => {
  it('only accepts bounded model identifiers', () => {
    for (const value of ['https://host/key', 'a b', 'a\nbody', 'x'.repeat(257)]) expect(modelIdentity(value)).toBeUndefined();
    expect(modelIdentity('org/model-v1.2')).toBe('org/model-v1.2');
    expect(modelIdentity('qwen3:14b')).toBe('qwen3:14b');
    expect(modelIdentity('namespace/model:tag')).toBe('namespace/model:tag');
  });
  const attempt = (patch: Partial<HttpAttempt> = {}): HttpAttempt => ({ provider: 'local', requestedModel: 'a', format: 'none', lean: false, outcome: 'success', elapsedMs: 1, inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, ...patch });
  it('sums mixed models; cached tokens remain a subset; rates absent means unknown cost', () => {
    const state = { steps: [{ n: 1, usage: { attempts: [attempt(), attempt({ reportedModel: 'b' })], parseRetries: 1 }, observation: 'PRIVATE' }] };
    expect(summarizeRunUsage(state)).toMatchObject({ httpAttempts: 2, input: { reported: 20, unknownAttempts: 0 }, output: { reported: 4 }, cachedInput: { reported: 6 }, models: ['a', 'b'], cost: { status: 'unknown', reason: 'missing-rates', amount: null } });
    expect(JSON.stringify(exportUsage(state))).not.toContain('PRIVATE');
  });
  it('keeps unknown attempts and legacy steps distinct from reported zero', () => {
    const state = { steps: [{ n: 1 }, { n: 2, usage: { attempts: [attempt({ inputTokens: 0 }), attempt({ inputTokens: null, outputTokens: null, cachedInputTokens: null })], parseRetries: 0 } }] };
    expect(summarizeRunUsage(state)).toMatchObject({ unmeasuredSteps: 1, input: { reported: 0, unknownAttempts: 1 }, output: { reported: 2, unknownAttempts: 1 } });
  });
});


describe('usage diagnostics and legacy completeness', () => {
  const attempt: HttpAttempt = { provider: 'local', requestedModel: 'qwen3:14b', format: 'none', lean: false, outcome: 'success', elapsedMs: 1, inputTokens: 0, outputTokens: null, cachedInputTokens: 0 };
  it('exports only accounting fields and safe status, with unknown legacy parse counters', () => {
    const state = { status: 'failed', task: 'PRIVATE_TASK', result: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR', profileLabel: 'PRIVATE_LABEL', steps: [{ n: 1, observation: 'PRIVATE_PAGE', usage: { attempts: [attempt], parseRetries: 0, chatCalls: 1 } }, { n: 2 }] };
    const exported = exportUsage(state);
    expect(exported.summary).toMatchObject({ status: 'failed', chatCalls: 1, unknownChatCallSteps: 1, parseErrors: { reported: 0, unknownSteps: 2 }, input: { reported: 0, unknownAttempts: 0 }, output: { reported: 0, unknownAttempts: 1 } });
    expect(exported.steps[0]?.parseErrors).toBeNull();
    expect(JSON.stringify(exported)).not.toContain('PRIVATE');
    expect(formatRunUsage(state)).not.toContain('PRIVATE');
    expect(formatRunUsage(state)).toContain('Стоимость неизвестна: тарифы не заданы');
    expect(exportUsage({ ...state, status: 'PRIVATE_STATUS' }).summary.status).toBeNull();
  });
  it('keeps parse errors, parse retries and HTTP outcomes separate', () => {
    const state = { status: 'done', steps: [{ n: 1, usage: { attempts: [attempt, { ...attempt, outcome: 'http-error' as const, attemptInChat: 2 }, { ...attempt, outcome: 'aborted' as const }, { ...attempt, outcome: 'network-error' as const }, { ...attempt, outcome: 'stream-error' as const }], parseErrors: 3, parseRetries: 2, chatCalls: 3, unmeasuredChatCalls: 0 } }] };
    expect(summarizeRunUsage(state)).toMatchObject({ status: 'done', httpAttempts: 5, chatCalls: 3, transportRetries: 1, parseRetries: 2, parseErrors: { reported: 3, unknownSteps: 0 }, outcomes: { success: 1, httpError: 1, aborted: 1, networkError: 1, streamError: 1 } });
  });
});
