import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRequestBody,
  chatStream,
  HttpError,
  isOptionalFieldRejection,
  isTransientError,
  resetFormatCache,
  transientDelay,
  TRANSIENT_ATTEMPTS,
  type FetchFn,
} from '@/lib/llm/client';
import { serviceBackoffMs } from '@/lib/agent/runner';
import { bareModelId, checkConnection, describeError, resolveModel } from '@/lib/llm/connection';
import { PROVIDERS, providerInfo } from '@/lib/llm/providers';
import { apiUrl, normalizeBaseUrl } from '@/lib/llm/url';
import { DEFAULT_SETTINGS, sanitizeSettings, type LlmProfile } from '@/lib/settings';

const gemini = (patch: Partial<LlmProfile> = {}): LlmProfile => ({ ...DEFAULT_SETTINGS.profiles.cloud, apiKey: 'AIza-test', ...patch });
const local = (patch: Partial<LlmProfile> = {}): LlmProfile => ({ ...DEFAULT_SETTINGS.profiles.fast, ...patch });
const msgs = [{ role: 'user' as const, content: 'hi' }];
const schema = { type: 'object' };

beforeEach(() => resetFormatCache());

describe('адрес Gemini', () => {
  it('префикс API подставляется по провайдеру', () => {
    expect(apiUrl('https://generativelanguage.googleapis.com', '/chat/completions', PROVIDERS.google.apiPrefix)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(apiUrl('http://h:1', '/models')).toBe('http://h:1/v1/models');
  });

  it('вставленный целиком адрес из документации даёт тот же эндпоинт', () => {
    for (const given of [
      'https://generativelanguage.googleapis.com',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    ]) {
      expect(apiUrl(normalizeBaseUrl(given)!, '/chat/completions', PROVIDERS.google.apiPrefix)).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
    }
  });

  it('любой сторонний OpenAI-совместимый сервис — адрес с ключом и без провайдера', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-my-key');
      return new Response(JSON.stringify({ data: [{ id: 'some-model' }] }), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as FetchFn;

    const report = await checkConnection(local({ baseUrl: 'https://vyceai.com/v1', apiKey: 'sk-my-key', model: 'some-model' }), fetchImpl);
    expect(report.ok).toBe(true);
    expect(urls).toEqual(['https://vyceai.com/v1/models']); // без лишних /api/version и /props
    expect(report.endpoint).toBe('https://vyceai.com/v1/chat/completions');
    expect(report.resolvedModel).toBe('some-model');
  });

  it('свой сервер в локальной сети по-прежнему опрашивается на Ollama и llama.cpp', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3:14b' }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }) as unknown as FetchFn;
    await checkConnection(local({ baseUrl: 'http://192.168.1.10:11434', model: 'qwen3:14b' }), fetchImpl);
    expect(urls).toContain('http://192.168.1.10:11434/api/version');
    expect(urls).toContain('http://192.168.1.10:11434/props');

    // тот же сервер, но адрес вписан вместе с /v1 — служебные пути всё равно от корня
    urls.length = 0;
    await checkConnection(local({ baseUrl: 'http://192.168.1.10:11434/v1', model: 'qwen3:14b' }), fetchImpl);
    expect(urls).toEqual(['http://192.168.1.10:11434/v1/models', 'http://192.168.1.10:11434/api/version', 'http://192.168.1.10:11434/props']);
  });

  it('неизвестный провайдер в настройках — свой сервер', () => {
    expect(providerInfo('что-то').id).toBe('openai');
    expect(providerInfo(undefined).apiPrefix).toBe('/v1');
  });
});

describe('тело запроса к Gemini', () => {
  it('рассуждения выключаются через reasoning_effort, без полей локальных серверов', () => {
    const body = buildRequestBody(gemini({ thinking: false }), msgs, 'json_schema', schema);
    expect(body).toMatchObject({ model: 'gemini-3.8-flash', reasoning_effort: 'none', stream: true });
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('think');
  });

  it('с включёнными рассуждениями не шлём ничего лишнего', () => {
    expect(buildRequestBody(gemini({ thinking: true }), msgs, 'none')).not.toHaveProperty('reasoning_effort');
  });

  it('lean выбрасывает необязательные поля, обязательные оставляет', () => {
    const lean = buildRequestBody(gemini({ thinking: false }), msgs, 'json_object', schema, 100, true);
    expect(lean).not.toHaveProperty('stream_options');
    expect(lean).not.toHaveProperty('reasoning_effort');
    expect(lean).toMatchObject({ stream: true, max_tokens: 100, response_format: { type: 'json_object' } });
    expect(buildRequestBody(local({ thinking: false }), msgs, 'none', undefined, 100, true)).not.toHaveProperty('chat_template_kwargs');
  });
});

describe('повтор без необязательных полей', () => {
  it('отличает отказ по неизвестному полю от прочих ошибок', () => {
    expect(isOptionalFieldRejection(new HttpError(400, 'Unknown name "stream_options"', 'u'))).toBe(true);
    expect(isOptionalFieldRejection(new HttpError(400, 'reasoning_effort is not supported for this model', 'u'))).toBe(true);
    expect(isOptionalFieldRejection(new HttpError(400, 'context length exceeded', 'u'))).toBe(false);
    expect(isOptionalFieldRejection(new HttpError(500, 'stream_options', 'u'))).toBe(false);
  });

  it('сервер отверг stream_options → запрос повторяется без них и запоминается', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return new Response('Unknown name "stream_options" at \'generate_content_request\'', { status: 400 });
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as FetchFn;

    const profile = gemini({ thinking: false });
    const res = await chatStream({ profile, messages: msgs, fetchImpl });
    expect(res.content).toBe('OK');
    expect(JSON.parse(bodies[0]!)).toHaveProperty('stream_options');
    expect(JSON.parse(bodies[1]!)).not.toHaveProperty('stream_options');

    // следующий запрос сразу идёт без них
    await chatStream({ profile, messages: msgs, fetchImpl });
    expect(bodies).toHaveLength(3);
    expect(JSON.parse(bodies[2]!)).not.toHaveProperty('stream_options');
  });

  it('ошибка не про поля запроса повтора без них не вызывает', async () => {
    const fetchImpl = vi.fn(async () => new Response('model not found', { status: 404 })) as unknown as FetchFn;
    await expect(chatStream({ profile: gemini(), messages: msgs, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('перегрузка сервиса', () => {
  const overloaded = () =>
    new Response(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }), { status: 503 });

  it('503, 429 и сбой сети — временные; 400 и 404 — нет', () => {
    expect(isTransientError(new HttpError(503, 'high demand', 'u'))).toBe(true);
    expect(isTransientError(new HttpError(429, 'quota', 'u'))).toBe(true);
    expect(isTransientError(new HttpError(502, '', 'u'))).toBe(true);
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientError(new HttpError(404, 'no model', 'u'))).toBe(false);
    expect(isTransientError(new HttpError(400, 'API key not valid', 'u'))).toBe(false);
    // отказ от response_format обрабатывает своя ветка, повторять как перегрузку нельзя
    expect(isTransientError(new HttpError(500, 'failed to parse grammar', 'u'))).toBe(false);
  });

  it('Retry-After важнее базовой паузы, но не дольше минуты', () => {
    expect(transientDelay(1)).toBeGreaterThanOrEqual(1600);
    expect(transientDelay(1)).toBeLessThanOrEqual(2400);
    expect(transientDelay(1, 30_000)).toBeGreaterThan(20_000);
    expect(transientDelay(1, 600_000)).toBeLessThanOrEqual(60_000);
    expect(transientDelay(1, 100)).toBeGreaterThanOrEqual(1600); // слишком короткое указание не ускоряет
  });

  it('503 переживается повтором внутри шага, о паузе сообщают наружу', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n++;
        if (n < 3) return overloaded();
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }) as unknown as FetchFn;
      const retries: { attempt: number; waitMs: number }[] = [];
      const p = chatStream({ profile: gemini(), messages: msgs, fetchImpl, onRetry: (i) => retries.push(i) });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await p).content).toBe('OK');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
      expect(retries[1]!.waitMs).toBeGreaterThan(retries[0]!.waitMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('если сервис лежит всё время — ошибка после TRANSIENT_ATTEMPTS попыток', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => overloaded()) as unknown as FetchFn;
      const p = chatStream({ profile: gemini(), messages: msgs, fetchImpl }).catch((e: unknown) => describeError(e));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toMatch(/503: сервис перегружен/);
      expect(fetchImpl).toHaveBeenCalledTimes(TRANSIENT_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('пауза перед повтором растёт и ограничена сверху', () => {
    expect([1, 2, 3, 4, 8].map(serviceBackoffMs)).toEqual([5000, 15_000, 45_000, 120_000, 120_000]);
  });
});

describe('проверка связи с Gemini', () => {
  const listUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/models';

  it('ходит по адресу Gemini, не опрашивает Ollama и llama.cpp, снимает приставку models/', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer AIza-test');
      if (url !== listUrl) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.5-flash-lite' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as FetchFn;

    const report = await checkConnection(gemini(), fetchImpl);
    expect(report.ok).toBe(true);
    expect(report.models).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    expect(report.resolvedModel).toBe('gemini-3.8-flash');
    expect(report.server.kind).toBe('google');
    expect(urls).toEqual([listUrl]);
    expect(report.warnings).toEqual([]);
  });

  it('без ключа предупреждает, неверный ключ объясняет', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.8-flash' }] }), { headers: { 'Content-Type': 'application/json' } })) as unknown as FetchFn;
    const report = await checkConnection(gemini({ apiKey: '' }), ok);
    expect(report.warnings.join()).toMatch(/нужен API-ключ/);
    expect(describeError(new HttpError(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 'u'))).toMatch(
      /Неверный API-ключ/,
    );
  });

  it('bareModelId и поиск модели с приставкой и без', () => {
    expect(bareModelId('models/gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(resolveModel('models/gemini-3.8-flash', ['gemini-3.8-flash'])).toBe('gemini-3.8-flash');
    expect(resolveModel('qwen3', ['qwen3:latest'])).toBe('qwen3:latest');
  });
});

describe('профиль «Облако» в настройках', () => {
  it('есть по умолчанию и настроен на Gemini', () => {
    expect(DEFAULT_SETTINGS.profiles.cloud).toMatchObject({ provider: 'google', baseUrl: PROVIDERS.google.baseUrl, model: PROVIDERS.google.model, apiKey: '' });
    expect(DEFAULT_SETTINGS.profiles.fast.provider).toBe('openai');
  });

  it('старые настройки без поля provider получают значение по умолчанию, мусор отбрасывается', () => {
    const s = sanitizeSettings({ profiles: { fast: { model: 'qwen3:14b' }, cloud: { provider: 'нет такого', apiKey: ' k ' } } });
    expect(s.profiles.fast?.provider).toBe('openai');
    expect(s.profiles.cloud?.provider).toBe('google');
    expect(s.profiles.cloud?.apiKey).toBe('k');
    expect(sanitizeSettings({ profiles: { slow: { provider: 'google' } } }).profiles.slow?.provider).toBe('google');
  });

  it('профиль можно выбрать активным', () => {
    expect(sanitizeSettings({ activeProfile: 'cloud' }).activeProfile).toBe('cloud');
  });
});
