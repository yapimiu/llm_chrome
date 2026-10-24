import type { StepRecord } from './types';
export type ObservationMode = 'minimal' | 'standard' | 'detailed' | 'adaptive';
export const OBSERVATION_MODES: ObservationMode[] = ['minimal', 'standard', 'detailed', 'adaptive'];
export interface PreviousObservation { url: string; chars: number; complete: boolean }
export function observationMode(mode: ObservationMode | undefined, previous?: StepRecord, observed?: PreviousObservation, switched = false): Exclude<ObservationMode, 'adaptive'> {
  if (mode !== 'adaptive') return mode ?? 'standard';
  if (switched || previous?.error || previous?.actions.some((a) => a.skipped || (a.result && (!a.result.ok || /nothing on the page changed/.test(a.result.message)))) || previous?.warnings.some((w) => w.startsWith('LOOP')) || previous?.notes.some((n) => /STUCK|reject|MODEL SWITCH/i.test(n))) return 'detailed';
  if (previous && observed?.complete && observed.chars <= 4000 && previous.url === observed.url && !previous.actions.some((a) => a.result?.navigated || ['navigate', 'new_tab', 'switch_tab', 'go_back'].includes(a.action.action))) return 'minimal';
  return 'standard';
}
export function observationLimits(mode: Exclude<ObservationMode, 'adaptive'>, cap: number) {
  return { maxChars: mode === 'minimal' ? Math.min(cap, 4000) : cap, maxTextPerElement: mode === 'detailed' ? 160 : 80 };
}
