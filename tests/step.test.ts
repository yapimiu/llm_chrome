import { describe, expect, it, vi } from 'vitest';
import { runStep, type StepDeps, type StepEvent, type StepInput } from '@/lib/agent/step';
import { estimateTokens } from '@/lib/agent/prompt';
import type { ChatMessage, ChatResult } from '@/lib/llm/client';

const input: StepInput = {
  task: 'Нажми «Войти»',
  systemTemplate: 'SYS {{MAX_ACTIONS}}',
  boundary: 'b1',
  maxActions: 3,
  maxRetries: 2,
  contextTokens: 16384,
  maxOutputTokens: 1024,
};

const reply = (content: string, finishReason = 'stop'): ChatResult => ({ content, reasoning: '', format: 'json_schema', finishReason, totalMs: 10, ttftMs: 5 });

function deps(replies: ChatResult[]): StepDeps & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    observe: vi.fn(async () => ({ observation: '[1] button "Войти"', tabs: [] })),
    chat: vi.fn(async (messages: ChatMessage[], _schema, onDelta) => {
      calls.push(structuredClone(messages));
      const r = replies.shift()!;
      onDelta({ content: r.content, reasoning: '' });
      return r;
    }),
  };
}

describe('runStep', () => {
  it('удачный шаг с первой попытки', async () => {
    const d = deps([reply('{"reasoning":"r","expected_outcome":"e","actions":[{"action":"click","index":1}]}')]);
    const events: StepEvent[] = [];
    const out = await runStep(input, d, (e) => events.push(e));
    expect(out.step?.actions).toEqual([{ action: 'click', index: 1 }]);
    expect(out.error).toBeUndefined();
    expect(out.attempts).toHaveLength(1);
    expect(out.observation).toBe('[1] button "Войти"');
    expect(events.map((e) => e.phase)).toEqual(['observe', 'llm', 'delta']);
    expect(d.calls[0]![0]).toEqual({ role: 'system', content: 'SYS 3' });
  });

  it('переспрашивает с текстом ошибки и принимает исправленный ответ', async () => {
    const d = deps([reply('Нажму кнопку войти'), reply('{"actions":[{"action":"click","index":1}]}')]);
    const events: StepEvent[] = [];
    const out = await runStep(input, d, (e) => events.push(e));
    expect(out.step?.actions).toEqual([{ action: 'click', index: 1 }]);
    expect(out.attempts.map((a) => a.parseError)).toEqual(['no valid JSON object found in the reply', undefined]);
    const second = d.calls[1]!;
    expect(second.at(-2)).toEqual({ role: 'assistant', content: 'Нажму кнопку войти' });
    expect(second.at(-1)!.content).toContain('no valid JSON object');
    expect(events.some((e) => e.phase === 'parse-error')).toBe(true);
  });

  it('обрыв по лимиту токенов подсказывает сократить рассуждения', async () => {
    const d = deps([reply('{"reasoning":"очень длинно', 'length'), reply('{"actions":[{"action":"go_back"}]}')]);
    await runStep(input, d);
    expect(d.calls[1]!.at(-1)!.content).toContain('cut off by the token limit');
  });

  it('сдаётся после maxRetries+1 попыток', async () => {
    const d = deps([reply('нет'), reply('нет'), reply('нет')]);
    const out = await runStep(input, d);
    expect(out.step).toBeUndefined();
    expect(out.attempts).toHaveLength(3);
    expect(out.error).toMatch(/за 3 попыток/);
  });

  it('предупреждает о переполнении контекста', async () => {
    const d = deps([reply('{"actions":[{"action":"go_back"}]}')]);
    const out = await runStep({ ...input, contextTokens: 1024, maxOutputTokens: 1000 }, d);
    expect(out.warnings.join()).toMatch(/больше бюджета контекста/);
  });

  it('предупреждения парсера попадают в результат', async () => {
    const d = deps([reply('{"actions":[{"action":"done","result":"ok"},{"action":"click","index":1}]}')]);
    const out = await runStep(input, d);
    expect(out.warnings.join()).toMatch(/dropped 1 action/);
  });
});

describe('bounded parse retry payloads', () => {
  it('sends the base plus only the last invalid excerpt; estimates match actual payload', async () => {
    const d = deps([reply('FIRST '.repeat(4000)), reply('SECOND '.repeat(4000)), reply('{"actions":[{"action":"done","result":"ok"}]}')]);
    const out = await runStep(input, d);
    const base = d.calls[0]!;
    expect(d.calls[1]!.slice(0, base.length)).toEqual(base);
    expect(d.calls[2]!.slice(0, base.length)).toEqual(base);
    expect(d.calls[1]).toHaveLength(base.length + 2);
    expect(d.calls[2]).toHaveLength(base.length + 2);
    expect(d.calls[2]!.at(-2)!.content).toBe('SECOND '.repeat(4000).slice(0, 512));
    expect(JSON.stringify(d.calls[2])).not.toContain('FIRST');
    expect(out.messages).toEqual(d.calls[2]);
    out.attempts.forEach((attempt, i) => expect(attempt.promptTokensEstimate).toBe(estimateTokens(d.calls[i]!)));
    expect(out.promptTokensEstimate).toBe(estimateTokens(out.messages));
    expect(d.observe).toHaveBeenCalledTimes(1);
  });
  it.each(['', '<think>reasoning only', '<think>hidden</think>not JSON'])('handles empty/thinking reply %s and length guidance', async (content) => {
    const d = deps([reply(content, 'length'), reply('{"actions":[{"action":"go_back"}]}')]);
    await runStep(input, d);
    expect(d.calls[1]!.at(-2)!.content).toBe(content.endsWith('not JSON') ? 'not JSON' : '(empty)');
    expect(d.calls[1]!.at(-1)!.content).toContain('cut off by the token limit');
    expect(JSON.stringify(d.calls[1])).not.toContain('hidden');
  });
  it('bounds parser error excerpts and does not add an unsent correction after exhaustion', async () => {
    const invalid = JSON.stringify({ actions: [{ action: 'click', index: 'invalid'.repeat(2000) }] });
    const d = deps([reply(invalid), reply(invalid), reply(invalid)]);
    const out = await runStep(input, d);
    expect(out.error).toBeDefined();
    expect(out.messages).toEqual(d.calls.at(-1));
    expect(d.calls).toHaveLength(3);
    expect(String(d.calls[2]!.at(-1)!.content).length).toBeLessThan(600);
  });
  it('retains one base image per payload and local JSON repair avoids a retry', async () => {
    const d = deps([reply('bad'), reply('{“actions”:[{“action”:“go_back”},],}')]);
    d.observe = async () => ({ observation: '[1] button "Continue"', tabs: [], image: 'data:image/png;base64,fixture' });
    const out = await runStep(input, d);
    expect(out.step?.actions).toEqual([{ action: 'go_back' }]);
    expect(d.calls).toHaveLength(2);
    for (const call of d.calls) expect(call.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0)).toBe(1);
  });
});
