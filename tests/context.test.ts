import { describe, expect, it, vi } from 'vitest';
import { charsForTokens, isContextOverflow, MIN_OBSERVATION_CHARS, updateTokenRatio } from '@/lib/agent/context';
import { buildDigest } from '@/lib/agent/history';
import { runStep, type StepDeps, type StepInput } from '@/lib/agent/step';
import type { StepRecord } from '@/lib/agent/types';
import { HttpError, type ChatMessage, type ChatResult } from '@/lib/llm/client';

const OK = '{"reasoning":"r","expected_outcome":"e","actions":[{"action":"click","index":1}]}';
const reply = (): ChatResult => ({ content: OK, reasoning: '', format: 'json_schema', finishReason: 'stop', totalMs: 1, ttftMs: 1 });

const input: StepInput = { task: 'Найди цену', systemTemplate: 'SYS', boundary: 'b', maxActions: 3, maxRetries: 1, contextTokens: 4000, maxOutputTokens: 500, history: 'H'.repeat(3000), digest: 'DIGEST' };

/** Страница длиной n символов; maxChars режет её, как настоящий сборщик. */
function deps(pageChars: number, chat?: StepDeps['chat']): StepDeps & { observed: (number | undefined)[]; sent: ChatMessage[][] } {
  const observed: (number | undefined)[] = [];
  const sent: ChatMessage[][] = [];
  return {
    observed,
    sent,
    observe: vi.fn(async (o) => {
      observed.push(o?.maxChars);
      return { observation: 'P'.repeat(Math.min(pageChars, o?.maxChars ?? Infinity)), tabs: [] };
    }),
    chat: vi.fn(chat ?? (async (m) => (sent.push(structuredClone(m)), reply()))),
  };
}

const text = (m: ChatMessage[]) => m.map((x) => (typeof x.content === 'string' ? x.content : '')).join('\n');

describe('сброс контекста в runStep', () => {
  it('влезает в порог — ничего не трогаем', async () => {
    const d = deps(1000);
    const out = await runStep({ ...input, history: 'short', resetPercent: 85 }, d);
    expect(out.resets).toEqual([]);
    expect(d.observed).toEqual([undefined]);
    expect(text(out.messages)).toContain('short');
  });

  it('автосброс выключен (0) — промпт уходит как есть, даже если не влезает', async () => {
    const d = deps(20000);
    const out = await runStep({ ...input, resetPercent: 0 }, d);
    expect(out.resets).toEqual([]);
    expect(text(out.messages)).toContain('HHHH');
    expect(out.warnings.some((w) => w.includes('больше бюджета'))).toBe(true);
  });

  it('не влезло: сначала история заменяется сводкой; если хватило — страницу не трогаем', async () => {
    const d = deps(7000);
    const out = await runStep({ ...input, resetPercent: 85 }, d);
    expect(out.resets).toHaveLength(1);
    expect(out.resets[0]).toMatch(/history replaced with a short digest/);
    expect(text(out.messages)).toContain('DIGEST');
    expect(text(out.messages)).not.toContain('HHHH');
    expect(d.observed).toEqual([undefined]);
  });

  it('и сводки мало: страница снимается заново покороче и промпт укладывается в порог', async () => {
    const d = deps(60000);
    const out = await runStep({ ...input, resetPercent: 85 }, d);
    expect(out.resets).toHaveLength(2);
    expect(out.resets[1]).toMatch(/page text shortened/);
    expect(d.observed).toHaveLength(2);
    expect(d.observed[1]).toBeGreaterThanOrEqual(MIN_OBSERVATION_CHARS);
    expect(out.observation.length).toBe(d.observed[1]);
    expect(Math.ceil(out.promptTokensEstimate) + input.maxOutputTokens).toBeLessThanOrEqual(Math.floor(input.contextTokens * 0.85) + 50);
    expect(out.warnings.some((w) => w.includes('больше бюджета'))).toBe(false);
  });

  it('поправка токенайзера делает сброс строже: если токенов реально больше, срабатывает раньше', async () => {
    const page = 6000;
    const base = await runStep({ ...input, history: 'short', resetPercent: 85, tokenRatio: 1 }, deps(page));
    const dense = await runStep({ ...input, history: 'short', resetPercent: 85, tokenRatio: 2 }, deps(page));
    expect(base.resets).toEqual([]);
    expect(dense.resets.length).toBeGreaterThan(0);
  });

  it('сервер отверг запрос как слишком большой: сбрасываем жёстче и повторяем один раз', async () => {
    let calls = 0;
    const d = deps(30000, async (m) => {
      calls++;
      if (calls === 1) throw new HttpError(400, 'request (9000 tokens) exceeds the available context size (4096 tokens)', 'http://s/v1');
      d.sent.push(structuredClone(m));
      return reply();
    });
    const out = await runStep({ ...input, resetPercent: 0 }, d);
    expect(out.step?.actions).toHaveLength(1);
    expect(out.resets.some((r) => /rejected the request as too large/.test(r))).toBe(true);
    expect(calls).toBe(2);
    expect(text(d.sent[0]!)).toContain('DIGEST');
  });

  it('если сжимать уже нечего или это другая ошибка — исключение не глотается', async () => {
    const tiny = deps(100, async () => {
      throw new HttpError(400, 'exceeds the available context size', 'u');
    });
    await expect(runStep({ ...input, history: undefined, digest: undefined, resetPercent: 0 }, tiny)).rejects.toBeInstanceOf(HttpError);
    const other = deps(100, async () => {
      throw new HttpError(401, 'bad key', 'u');
    });
    await expect(runStep(input, other)).rejects.toBeInstanceOf(HttpError);
  });

  it('повтор после отказа не зацикливается: второй отказ — исключение', async () => {
    const d = deps(30000, async () => {
      throw new HttpError(400, 'exceeds the available context size', 'u');
    });
    await expect(runStep({ ...input, resetPercent: 0 }, d)).rejects.toBeInstanceOf(HttpError);
    expect(d.chat).toHaveBeenCalledTimes(2);
  });
});

describe('сброс не раздувает промпт', () => {
  it('сводка длиннее истории — история остаётся, ужимается страница', async () => {
    const d = deps(60000);
    const out = await runStep({ ...input, history: 'short history', digest: 'D'.repeat(3000), resetPercent: 85 }, d);
    expect(out.resets.some((r) => /digest/.test(r))).toBe(false);
    expect(out.resets.some((r) => /page text shortened/.test(r))).toBe(true);
    expect(out.history).toBe('short history');
  });

  it('в итоге шага — история, которая реально ушла модели', async () => {
    const out = await runStep({ ...input, resetPercent: 85 }, deps(7000));
    expect(out.history).toBe('DIGEST');
  });

  it('в попытке — оценка ровно тех сообщений, что ушли (с переспросом — больше)', async () => {
    const bad: ChatResult = { content: 'not json', reasoning: '', format: 'json_schema', finishReason: 'stop', totalMs: 1 };
    const replies = [bad, reply()];
    const out = await runStep({ ...input, history: 'h' }, deps(100, async () => replies.shift()!));
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[1]!.promptTokensEstimate).toBeGreaterThan(out.attempts[0]!.promptTokensEstimate);
  });
});

describe('isContextOverflow', () => {
  it.each([
    [400, 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it'],
    [400, "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens"],
    [400, '{"error":{"code":"context_length_exceeded"}}'],
    [413, 'Request too large'],
    [500, 'prompt is too long: 20000 tokens > 8192 maximum'],
  ])('%s %s → да', (status, body) => expect(isContextOverflow(new HttpError(status, body, 'u'))).toBe(true));

  it.each([
    [401, 'invalid api key'],
    [429, 'rate limit'],
    [400, 'unknown field response_format'],
  ])('%s %s → нет', (status, body) => expect(isContextOverflow(new HttpError(status, body, 'u'))).toBe(false));

  it('не HTTP-ошибка — нет', () => expect(isContextOverflow(new Error('exceeds the available context size'))).toBe(false));
});

describe('буфер токенов', () => {
  it('charsForTokens: ~3 символа на токен, не меньше минимума, плотнее токенайзер — меньше символов', () => {
    expect(charsForTokens(2000, 1)).toBe(6000);
    expect(charsForTokens(2000, 2)).toBe(3000);
    expect(charsForTokens(10, 1)).toBe(MIN_OBSERVATION_CHARS);
  });

  it('updateTokenRatio: подстраивается к реальному расходу плавно и в пределах', () => {
    expect(updateTokenRatio(1, undefined, 1000)).toBe(1);
    expect(updateTokenRatio(1, 2000, 1000)).toBeCloseTo(1.5);
    expect(updateTokenRatio(1, 100000, 1000)).toBe(3);
    expect(updateTokenRatio(1, 10, 1000)).toBe(0.505);
  });

  it('updateTokenRatio: устойчиво — при точной поправке не уползает', () => {
    let r = 2;
    for (let i = 0; i < 10; i++) r = updateTokenRatio(r, 2000, 1000);
    expect(r).toBeCloseTo(2);
  });
});

describe('buildDigest', () => {
  const step = (n: number, url: string, extra: Partial<StepRecord> = {}): StepRecord => ({ n, startedAt: 0, url, reasoning: '', expectedOutcome: '', actions: [{ action: { action: 'click', index: n }, result: { ok: true, message: 'clicked' } }], warnings: [], notes: [], ...extra });

  it('заметки целиком, страницы по порядку без повторов, два последних шага; пусто — пусто', () => {
    const steps = [step(1, 'https://a.example/'), step(2, 'https://b.example/'), step(3, 'https://a.example/'), step(4, 'https://c.example/', { error: 'boom' })];
    const out = buildDigest(steps, ['цена 5000']);
    expect(out).toContain('1. цена 5000');
    expect(out).toContain('reset to save space');
    expect(out).toContain('4 steps (1 with problems)');
    expect(out).toContain('https://a.example/ → https://b.example/ → https://c.example/');
    expect(out).toContain('Step 3:');
    expect(out).toContain('Step 4:');
    expect(out).not.toContain('Step 1:');
    expect(buildDigest([], [])).toBe('');
  });

  it('не длиннее лимита истории, даже с огромными заметками extract', () => {
    const out = buildDigest([step(1, 'https://a.example/')], ['x'.repeat(20000)]);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('Step 1:');
  });
});
