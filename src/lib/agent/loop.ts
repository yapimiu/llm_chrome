import type { ExecutedAction } from './types';

export type LoopVerdict = 'ok' | 'warn' | 'stop';

/** FNV-1a — быстрый отпечаток наблюдения; криптостойкость не нужна. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Отпечаток «места», где выбирают действие: только URL и прокрутка. Текст и даже список
 * элементов не учитываются — таймеры, всплывающие «скопировано» и реклама меняют их постоянно,
 * и детектор не замечал бы, что модель жмёт одну и ту же бесполезную кнопку.
 */
export function pageSignature(observation: string): string {
  return observation
    .split('\n')
    .filter((l) => l.startsWith('URL: ') || l.startsWith('Scroll: '))
    .join('\n');
}

/** Действия шага с элементами по описанию, а не по номеру: номера пересчитываются каждый шаг. */
export function actionSignature(actions: readonly ExecutedAction[]): string {
  return JSON.stringify(
    actions.map((a) => {
      const by = 'index' in a.action ? { ...a.action, index: a.target ?? a.action.index } : a.action;
      return a.action.action === 'drag' || a.action.action === 'read' ? { ...by, to_index: a.toTarget ?? a.action.to_index } : by;
    }),
  );
}

/**
 * Детектор зацикливания: одно и то же действие на одной и той же странице N раз подряд.
 * На N — предупреждение (модель получит его в истории), на 2N — остановка.
 */
export interface LoopSnapshot {
  last: { signature: string; page: string } | null;
  count: number;
}

export class LoopDetector {
  private last: { signature: string; page: string } | null = null;
  private count = 0;

  constructor(
    private readonly threshold: number,
    restore?: LoopSnapshot,
  ) {
    if (restore) {
      this.last = restore.last;
      this.count = restore.count;
    }
  }

  /** Состояние для чекпоинта. */
  snapshot(): LoopSnapshot {
    return { last: this.last, count: this.count };
  }

  /** Смена модели — новая попытка: прежние повторы ей не засчитываются. */
  reset(): void {
    this.last = null;
    this.count = 0;
  }

  get repeats(): number {
    return this.count;
  }

  /** signature — действия шага, page — отпечаток наблюдения, на котором их выбрали. */
  record(signature: string, page: string): LoopVerdict {
    if (this.last && this.last.signature === signature && this.last.page === page) this.count++;
    else this.count = 1;
    this.last = { signature, page };
    if (this.count >= this.threshold * 2) return 'stop';
    if (this.count >= this.threshold) return 'warn';
    return 'ok';
  }
}
