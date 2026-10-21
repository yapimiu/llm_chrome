import { describe, expect, it } from 'vitest';
import { waitForAnimations } from '@/lib/dom/stable';

/** Поддельная анимация: закончится через ms (или никогда), длительность end мс. */
function anim(end: number, finishInMs: number | null) {
  let state: AnimationPlayState = 'running';
  const finished = new Promise<void>((resolve) => {
    if (finishInMs !== null)
      setTimeout(() => {
        state = 'finished';
        resolve();
      }, finishInMs);
  });
  return {
    get playState() {
      return state;
    },
    effect: { getComputedTiming: () => ({ endTime: end }) },
    finished,
  } as unknown as Animation;
}

const docWith = (list: Animation[]) => ({ getAnimations: () => list.filter((a) => a.playState === 'running') });

describe('waitForAnimations — снимок не посреди анимации', () => {
  it('анимаций нет — сразу', async () => {
    const t = Date.now();
    expect(await waitForAnimations(docWith([]))).toBe(0);
    expect(Date.now() - t).toBeLessThan(20);
  });

  it('сворачивание блока (переход 120 мс) — ждём, пока закончится', async () => {
    const t = Date.now();
    expect(await waitForAnimations(docWith([anim(300, 120)]), 1500)).toBe(0);
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
  });

  it('бесконечный спиннер и очень длинные анимации не ждём', async () => {
    const t = Date.now();
    expect(await waitForAnimations(docWith([anim(Infinity, null), anim(60_000, null)]), 1500)).toBe(0);
    expect(Date.now() - t).toBeLessThan(20);
  });

  it('не дольше таймаута: незаконченные возвращаются числом', async () => {
    const t = Date.now();
    expect(await waitForAnimations(docWith([anim(3000, null)]), 100)).toBe(1);
    expect(Date.now() - t).toBeLessThan(400);
  });

  it('браузер без getAnimations — не мешает', async () => {
    expect(await waitForAnimations({} as Pick<Document, 'getAnimations'>)).toBe(0);
  });
});
