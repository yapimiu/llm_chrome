import { describe, expect, it } from 'vitest';
import { serializePage } from '@/lib/dom/serialize';
import type { ElementInfo, PageSnapshot } from '@/lib/dom/types';
import { buildDigest, buildHistory } from '@/lib/agent/history';
import type { StepRecord } from '@/lib/agent/types';
import { runStep } from '@/lib/agent/step';
import { estimateTokens } from '@/lib/agent/prompt';

describe('synthetic measurement baseline (estimates, not provider usage)', () => {
  it('retains a later short button after an oversized first element', () => {
    const element = (index: number, name: string, attrs: [string, string][] = []): ElementInfo => ({ index, tag: 'button', name, attrs, states: [], zone: 'visible', distance: 0, rect: { x: 0, y: 0, width: 10, height: 10 } });
    const page: PageSnapshot = { url: 'https://example.test/', title: 'Fixture', scroll: { x: 0, y: 0, maxY: 0, viewportWidth: 800, viewportHeight: 600 }, elements: [element(1, 'Long', Array.from({ length: 20 }, (_, i) => [`data-${i}`, 'x'.repeat(80)])), element(2, 'Continue')], text: '', stats: { nodesVisited: 2, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 } };
    const blocked = serializePage(page, { maxChars: 600 });
    const control = serializePage({ ...page, elements: page.elements.slice(1) }, { maxChars: 600 });
    expect(blocked.shownIndices).toEqual([2]);
    expect(blocked.omittedElements).toBe(1);
    expect(control.shownIndices).toEqual([2]);
    console.info('DOM baseline', { chars: blocked.text.length, shown: blocked.shownIndices.length, omitted: blocked.omittedElements, controlShown: control.shownIndices.length });
  });

  it('measures retained extract, old blocked/error markers under pressure', () => {
    const steps: StepRecord[] = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, startedAt: i, url: 'https://example.test/', reasoning: 'r'.repeat(300), expectedOutcome: 'e'.repeat(200), actions: [{ action: { action: 'click', index: 1 }, result: { ok: true, message: 'clicked '.repeat(40) } }], warnings: [], notes: i === 0 ? ['BLOCKED_SENTINEL: do not submit'] : [], ...(i === 1 ? { error: 'ERROR_SENTINEL' } : {}) }));
    for (const [name, text] of [['history', buildHistory(steps, ['EXTRACT_SENTINEL'], { detailed: 3, maxChars: 600 })], ['digest', buildDigest(steps, ['EXTRACT_SENTINEL'], 2, 600)]] as const) {
      const result = { chars: text.length, extract: text.includes('EXTRACT_SENTINEL'), blocked: text.includes('BLOCKED_SENTINEL'), error: text.includes('ERROR_SENTINEL') };
      expect(result.chars).toBeLessThanOrEqual(600);
      expect(result).toMatchObject({ extract: true, blocked: true, error: true });
      console.info(name, result);
    }
  });

  it('measures healthy history reduction against the pre-change detailed fixture', () => {
    const steps: StepRecord[] = Array.from({ length: 3 }, (_, i) => ({ n: i + 1, startedAt: i, url: 'https://example.test/', reasoning: 'r'.repeat(300), expectedOutcome: 'e'.repeat(200), actions: [{ action: { action: 'click', index: 1 }, target: 'button "Continue"', result: { ok: true, message: 'clicked' } }], warnings: [], notes: [] }));
    const before = steps.map((s) => `Step ${s.n} (${s.url}):\n  reasoning: ${s.reasoning}\n  expected: ${s.expectedOutcome}\n  - click [1] (button "Continue") → clicked`).join('\n');
    const after = buildHistory(steps, []);
    const measured = { beforeChars: before.length, afterChars: after.length, beforeEstimatedTokens: estimateTokens([{ role: 'user', content: before }]), afterEstimatedTokens: estimateTokens([{ role: 'user', content: after }]) };
    expect(after).not.toContain('reasoning:');
    expect(after).not.toContain('expected:');
    expect(after).toContain('button "Continue"');
    expect(measured.afterChars).toBeLessThan(measured.beforeChars);
    console.info('healthy history reduction', measured);
  });

  it('measures sent prompt estimates for two invalid replies then success', async () => {
    const estimates: number[] = [];
    const replies = ['invalid '.repeat(200), 'invalid '.repeat(200), '{"actions":[{"action":"done","result":"ok"}]}'];
    const outcome = await runStep({ task: 'Synthetic task', systemTemplate: 'SYS', boundary: 'baseline', maxActions: 3, maxRetries: 2, contextTokens: 32000, maxOutputTokens: 500 }, {
      observe: async () => ({ observation: '[1] button "Continue"', tabs: [] }),
      chat: async (messages) => { estimates.push(estimateTokens(messages)); return { content: replies.shift()!, reasoning: '', format: 'none', totalMs: 1 }; },
    });
    expect(outcome.step).toBeDefined();
    expect(estimates).toHaveLength(3);
    expect(estimates[1]).toBeGreaterThan(estimates[0]!);
    expect(estimates).toEqual([67, 297, 297]);
    console.info('parse retry measurement', { requests: estimates.length, invalidReplies: outcome.attempts.filter((a) => a.parseError).length, successfulTasks: outcome.step ? 1 : 0, estimatedInputTokens: estimates, summedEstimatedInputTokens: estimates.reduce((a, b) => a + b, 0) });
  });
});
