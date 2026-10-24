import { describe, expect, it } from 'vitest';
import { observationMode, observationLimits } from '@/lib/agent/observation-mode';
import { sanitizeSettings } from '@/lib/settings';
import type { StepRecord } from '@/lib/agent/types';
const previous: StepRecord = { n: 1, startedAt: 0, url: 'https://example.test/', reasoning: '', expectedOutcome: '', actions: [{ action: { action: 'click', index: 1 }, result: { ok: true, message: 'clicked' } }], warnings: [], notes: [] };
const observed = { url: previous.url, chars: 500, complete: true };
describe('observation mode policy', () => {
  it('migrates missing/invalid config to Standard and preserves the user cap', () => {
    expect(sanitizeSettings({}).agent.observationMode).toBe('standard');
    expect(sanitizeSettings({ agent: { observationMode: 'invalid' } }).agent.observationMode).toBe('standard');
    for (const mode of ['minimal', 'standard', 'detailed', 'adaptive']) expect(sanitizeSettings({ agent: { observationMode: mode } }).agent.observationMode).toBe(mode);
    expect(observationLimits('standard', 12000)).toEqual({ maxChars: 12000, maxTextPerElement: 80 });
    expect(observationLimits('minimal', 12000)).toEqual({ maxChars: 4000, maxTextPerElement: 80 });
    expect(observationLimits('detailed', 1000)).toEqual({ maxChars: 1000, maxTextPerElement: 160 });
    expect(observationLimits('minimal', 1000).maxChars).toBe(1000);
  });
  it('only opts into Minimal after a healthy known complete same-page step', () => {
    expect(observationMode(undefined, previous, observed)).toBe('standard');
    expect(observationMode('adaptive')).toBe('standard');
    expect(observationMode('adaptive', previous)).toBe('standard');
    expect(observationMode('adaptive', previous, observed)).toBe('minimal');
    expect(observationMode('adaptive', previous, { ...observed, complete: false })).toBe('standard');
    expect(observationMode('adaptive', previous, { ...observed, chars: 4001 })).toBe('standard');
    expect(observationMode('adaptive', previous, { ...observed, url: 'https://elsewhere.test/' })).toBe('standard');
    expect(observationMode('adaptive', { ...previous, actions: [{ ...previous.actions[0]!, result: { ok: true, message: 'ok', navigated: true } }] }, observed)).toBe('standard');
  });
  it('uses Detailed on failures, no effect, loops, rejection, stuck and escalation', () => {
    for (const record of [{ ...previous, error: 'failed' }, { ...previous, warnings: ['LOOP: repeat'] }, { ...previous, notes: ['STUCK: no progress'] }, { ...previous, notes: ['The user rejected action'] }, { ...previous, actions: [{ ...previous.actions[0]!, result: { ok: true, message: 'nothing on the page changed' } }] }]) expect(observationMode('adaptive', record, observed)).toBe('detailed');
    expect(observationMode('adaptive', previous, observed, true)).toBe('detailed');
    expect(observationMode('standard', previous, observed, true)).toBe('standard');
  });
});
