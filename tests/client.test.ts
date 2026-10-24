import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRequestBody, chatStream, HttpError, isFormatRejection, resetFormatCache, type FetchFn } from '@/lib/llm/client';
import { DEFAULT_SETTINGS, type LlmProfile } from '@/lib/settings';

const profile = (patch: Partial<LlmProfile> = {}): LlmProfile => ({
  ...DEFAULT_SETTINGS.profiles.fast,
  baseUrl: 'http://llm.lan:8080',
  model: 'qwen3',
  ...patch,
});
const msgs = [{ role: 'user' as const, content: 'hi' }];
const schema = { type: 'object' };

function sseResponse(chunks: unknown[]): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = (d: Record<string, string>, finish?: string) => ({ choices: [{ index: 0, delta: d, finish_reason: finish ?? null }] });

beforeEach(() => resetFormatCache());

describe('buildRequestBody', () => {
  it('json_schema, стрим и выключенные рассуждения', () => {
    const body = buildRequestBody(profile({ thinking: false, temperature: 0.1, maxOutputTokens: 500 }), msgs, 'json_schema', schema);
    expect(body).toMatchObject({
      model: 'qwen3',
      stream: true,
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { name: 'agent_step', strict: true, schema } },
      chat_template_kwargs: { enable_thinking: false },
      think: false,
    });
  });

  it('json_object / none; рассуждения включены — без переключателей', () => {
    expect(buildRequestBody(profile({ thinking: true }), msgs, 'json_object', schema)).toMatchObject({ response_format: { type: 'json_object' } });
    const none = buildRequestBody(profile({ thinking: true }), msgs, 'none', schema);
    expect(none).not.toHaveProperty('response_format');
    expect(none).not.toHaveProperty('think');
    expect(none).not.toHaveProperty('chat_template_kwargs');
  });

  it('extraBody вмешивается поверх и может переопределить поля', () => {
    const body = buildRequestBody(profile({ extraBody: '{"top_k":20,"temperature":0.7}' }), msgs, 'none');
    expect(body).toMatchObject({ top_k: 20, temperature: 0.7 });
  });

  it('битый extraBody — понятная ошибка', () => {
    expect(() => buildRequestBody(profile({ extraBody: '{top_k:20}' }), msgs, 'none')).toThrow(/не JSON/);
    expect(() => buildRequestBody(profile({ extraBody: '[1]' }), msgs, 'none')).toThrow(/JSON-объектом/);
  });
});

describe('isFormatRejection', () => {
  it('отличает отказ от response_format от прочих ошибок', () => {
    expect(isFormatRejection(new HttpError(400, 'response_format type json_schema not supported', 'u'))).toBe(true);
    expect(isFormatRejection(new HttpError(500, 'failed to parse grammar', 'u'))).toBe(true);
    expect(isFormatRejection(new HttpError(401, 'invalid json key', 'u'))).toBe(false);
    expect(isFormatRejection(new HttpError(400, 'context length exceeded', 'u'))).toBe(false);
    expect(isFormatRejection(new Error('x'))).toBe(false);
  });
});

describe('chatStream', () => {
  it('собирает content, reasoning, finish_reason и usage', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        delta({ reasoning_content: 'хм' }),
        delta({ content: '{"a"' }),
        delta({ content: ':1}' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } },
      ]),
    ) as unknown as FetchFn;
    const deltas: string[] = [];
    const r = await chatStream({ profile: profile(), messages: msgs, schema, fetchImpl, onDelta: (d) => deltas.push(d.content || d.reasoning) });
    expect(r).toMatchObject({ content: '{"a":1}', reasoning: 'хм', finishReason: 'stop', format: 'json_schema', usage: { promptTokens: 120, completionTokens: 7 } });
    expect(deltas).toEqual(['хм', '{"a"', ':1}']);
  });

  it('auto: при отказе от json_schema пробует json_object и запоминает его', async () => {
    const formats: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      const f = body.response_format?.type ?? 'none';
      formats.push(f);
      if (f === 'json_schema') return new Response('{"error":"json_schema is not supported"}', { status: 400 });
      return sseResponse([delta({ content: '{}' }, 'stop')]);
    }) as unknown as FetchFn;

    const r1 = await chatStream({ profile: profile(), messages: msgs, schema, fetchImpl });
    expect(r1.format).toBe('json_object');
    await chatStream({ profile: profile(), messages: msgs, schema, fetchImpl });
    expect(formats).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('явный режим json_schema не откатывается', async () => {
    const fetchImpl = vi.fn(async () => new Response('json_schema unsupported', { status: 400 })) as unknown as FetchFn;
    await expect(chatStream({ profile: profile({ structuredOutput: 'json_schema' }), messages: msgs, schema, fetchImpl })).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('без схемы формат не запрашивается', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([delta({ content: 'OK' })]);
    }) as unknown as FetchFn;
    const r = await chatStream({ profile: profile(), messages: msgs, fetchImpl });
    expect(r.format).toBe('none');
    expect(sent).not.toHaveProperty('response_format');
  });

  it('отмена через signal', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      ctrl.abort();
      init?.signal?.throwIfAborted();
      return sseResponse([]);
    }) as unknown as FetchFn;
    await expect(chatStream({ profile: profile(), messages: msgs, fetchImpl, signal: ctrl.signal })).rejects.toThrow();
  });
});

it('does not fall back for an unrelated invalid JSON request body', async () => {
  const body = 'invalid JSON request body';
  const originalAutoFormats = ['json_schema', 'json_object', 'none'];
  const originalAttempts = originalAutoFormats.filter(() => /response_format|json_schema|schema|grammar|json/i.test(body)).length;
  expect(originalAttempts).toBe(3);
  const fetchImpl = vi.fn(async () => new Response('invalid JSON request body', { status: 400 })) as unknown as FetchFn;
  await expect(chatStream({ profile: profile(), messages: msgs, schema, fetchImpl })).rejects.toBeInstanceOf(HttpError);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  console.info('unrelated request JSON rejection transport fixture', { originalAttempts, afterAttempts: 1, successfulTasks: 0 });
});
