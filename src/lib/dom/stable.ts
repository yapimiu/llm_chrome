export interface StableOptions {
  /** Сколько миллисекунд без изменений DOM считать «успокоился». */
  quietMs: number;
  /** Дольше не ждём: бесконечные анимации, тикеры, чаты. */
  timeoutMs: number;
}

export interface StableResult {
  mutations: number;
  timedOut: boolean;
  ms: number;
}

export const DEFAULT_STABLE: StableOptions = { quietMs: 400, timeoutMs: 4000 };

/** Ждёт, пока DOM перестанет меняться (MutationObserver), но не дольше timeoutMs. */
export function waitForStable(doc: Document, opts: StableOptions = DEFAULT_STABLE): Promise<StableResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let mutations = 0;
    let quiet: ReturnType<typeof setTimeout>;
    const finish = (timedOut: boolean) => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve({ mutations, timedOut, ms: Math.round(performance.now() - started) });
    };
    const observer = new MutationObserver((records) => {
      mutations += records.length;
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(false), opts.quietMs);
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(() => finish(false), opts.quietMs);
    const hard = setTimeout(() => finish(true), opts.timeoutMs);
  });
}

/** Анимации длиннее этого (и бесконечные — спиннеры, бегущие строки) не ждём. */
const MAX_ANIMATION_MS = 5000;

/**
 * Ждёт окончания CSS-переходов и анимаций (document.getAnimations), но не дольше timeoutMs.
 * DOM в это время не меняется, поэтому waitForStable их не видит, а снимок посреди анимации
 * ловит полусвёрнутые блоки: нажатая реплика ещё видна и попадает в список — модель жмёт её снова.
 * Возвращает, сколько анимаций ещё шло, когда ждать перестали.
 */
export async function waitForAnimations(doc: Pick<Document, 'getAnimations'>, timeoutMs = 1500): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = (doc.getAnimations?.() ?? []).filter((a) => {
      if (a.playState !== 'running') return false;
      const end = Number(a.effect?.getComputedTiming().endTime ?? Infinity);
      return Number.isFinite(end) && end <= MAX_ANIMATION_MS;
    });
    const left = deadline - Date.now();
    if (running.length === 0 || left <= 0) return running.length;
    await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, left))]);
  }
}

