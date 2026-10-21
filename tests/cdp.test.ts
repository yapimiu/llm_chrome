import { describe, expect, it } from 'vitest';
import { CdpDriver, mouseMotion, type Point } from '@/lib/exec/cdp';

function fakeDriver(opts: { platform?: 'mac' | 'other' } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const driver = new CdpDriver(
    async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    { sleep: async () => {}, random: () => 0.5, platform: opts.platform ?? 'other' },
  );
  return { driver, calls };
}

/** Детерминированный генератор [0, 1). */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Отклонение точки от прямой from→to (со знаком) и доля пути вдоль неё. */
function lateral(from: Point, to: Point, p: Point): { across: number; along: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  return { across: ((p.x - from.x) * -dy + (p.y - from.y) * dx) / d, along: ((p.x - from.x) * dx + (p.y - from.y) * dy) / (d * d) };
}

describe('mouseMotion — траектория руки', () => {
  const from = { x: 0, y: 0 };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it('заканчивается ровно в цели, моменты точек не убывают', () => {
    for (const seed of seeds) {
      const m = mouseMotion(from, { x: 300, y: 120 }, seeded(seed));
      expect(m.points.at(-1)).toMatchObject({ x: 300, y: 120 });
      for (let i = 1; i < m.points.length; i++) expect(m.points[i]!.t).toBeGreaterThanOrEqual(m.points[i - 1]!.t);
      expect(m.totalMs).toBeGreaterThanOrEqual(m.points.at(-1)!.t);
    }
  });

  it('на 100 px: чистое движение 50–150 мс, всё событие 200–400 мс', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const m = mouseMotion(from, { x: 100, y: 0 }, seeded(seed * 7919));
      expect(m.moveMs).toBeGreaterThanOrEqual(50);
      expect(m.moveMs).toBeLessThanOrEqual(150);
      expect(m.totalMs).toBeGreaterThanOrEqual(200);
      expect(m.totalMs).toBeLessThanOrEqual(400);
    }
  });

  it('1–3 микрокоррекции, все три значения встречаются; на коротком перемещении коррекций нет', () => {
    const counts = new Set(seeds.concat([13, 14, 15, 16, 17, 18]).map((seed) => mouseMotion(from, { x: 400, y: 0 }, seeded(seed)).corrections));
    expect([...counts].sort()).toEqual([1, 2, 3]);
    expect(mouseMotion(from, { x: 12, y: 0 }, seeded(1)).corrections).toBe(0);
  });

  it('путь почти прямой: поперечное отклонение мало, без зигзагов и дуг', () => {
    for (const seed of seeds) {
      const to = { x: 1000, y: 0 };
      const m = mouseMotion(from, to, seeded(seed));
      const main = m.points.filter((p) => p.t <= m.moveMs);
      const dev = main.map((p) => lateral(from, to, p).across);
      expect(Math.max(...dev.map(Math.abs))).toBeLessThanOrEqual(8);
      // Знак отклонения меняется не чаще двух раз (S-образный дрейф), а не колеблется.
      const signs = dev.filter((d) => Math.abs(d) > 0.4).map(Math.sign);
      const changes = signs.filter((s, i) => i > 0 && s !== signs[i - 1]).length;
      expect(changes).toBeLessThanOrEqual(2);
    }
  });

  it('скорость колоколом: разгон, максимум в средней части, торможение у цели', () => {
    for (const seed of seeds) {
      const to = { x: 600, y: 0 };
      const m = mouseMotion(from, to, seeded(seed));
      const main = m.points.filter((p) => p.t <= m.moveMs);
      const speeds = main.slice(1).map((p, i) => Math.hypot(p.x - main[i]!.x, p.y - main[i]!.y) / (p.t - main[i]!.t));
      const peak = Math.max(...speeds);
      const at = speeds.indexOf(peak) / (speeds.length - 1);
      expect(at).toBeGreaterThan(0.3);
      expect(at).toBeLessThan(0.7);
      expect(speeds[0]!).toBeLessThan(peak * 0.3);
      expect(speeds.at(-1)!).toBeLessThan(peak * 0.3);
    }
  });

  it('без телепортации: между соседними событиями небольшие шаги, коррекции — в пару пикселей', () => {
    for (const seed of seeds) {
      const m = mouseMotion(from, { x: 800, y: 300 }, seeded(seed));
      const steps = m.points.slice(1).map((p, i) => Math.hypot(p.x - m.points[i]!.x, p.y - m.points[i]!.y));
      expect(Math.max(...steps.slice(0, -3 * m.corrections))).toBeLessThan(0.25 * 854);
      expect(Math.max(...steps.slice(-3 * m.corrections))).toBeLessThanOrEqual(8);
    }
  });

  it('движение идёт вперёд: вдоль пути позиция не отскакивает назад до коррекций', () => {
    const to = { x: 700, y: 0 };
    const m = mouseMotion(from, to, seeded(5));
    const main = m.points.filter((p) => p.t <= m.moveMs).map((p) => lateral(from, to, p).along);
    for (let i = 1; i < main.length; i++) expect(main[i]!).toBeGreaterThanOrEqual(main[i - 1]! - 1e-9);
  });

  it('на месте — одна точка', () => {
    expect(mouseMotion({ x: 5, y: 5 }, { x: 6, y: 5 }, () => 0.5).points).toEqual([{ x: 6, y: 5, t: 0 }]);
  });
});

describe('CdpDriver', () => {
  it('клик: движение к цели, нажатие и отпускание левой кнопки в точке', async () => {
    const { driver, calls } = fakeDriver();
    await driver.click({ x: 300, y: 200 }, { x: 0, y: 0 });
    const types = calls.map((c) => c.params?.type);
    expect(types.filter((t) => t === 'mouseMoved').length).toBeGreaterThanOrEqual(6);
    expect(types.slice(-2)).toEqual(['mousePressed', 'mouseReleased']);
    expect(calls.at(-2)!.params).toMatchObject({ x: 300, y: 200, button: 'left', clickCount: 1 });
    expect(driver.position).toEqual({ x: 300, y: 200 });
  });

  it('moveTo идёт по расписанию: на 100 px всё событие 200–400 мс, события ≈125 Гц', async () => {
    let clock = 0;
    const times: number[] = [];
    const driver = new CdpDriver(
      async (_m, params) => {
        if (params?.type === 'mouseMoved') times.push(clock);
        return {};
      },
      { sleep: async (ms) => void (clock += ms), now: () => clock, random: seeded(3), platform: 'other' },
    );
    await driver.moveTo({ x: 100, y: 0 }, { x: 0, y: 0 });
    expect(clock).toBeGreaterThanOrEqual(200);
    expect(clock).toBeLessThanOrEqual(400);
    const gaps = times.slice(1, 8).map((x, i) => x - times[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(12);
    expect(times.length).toBeGreaterThan(8);
  });

  it('первое движение приходит сверху-слева, а не появляется на цели', async () => {
    const { driver, calls } = fakeDriver();
    await driver.moveTo({ x: 500, y: 400 });
    const first = calls[0]!.params as { x: number; y: number };
    expect(first.x).toBeLessThan(400);
    expect(first.y).toBeLessThan(400);
    expect(calls.at(-1)!.params).toMatchObject({ x: 500, y: 400 });
  });

  it('координаты — CSS-пиксели как есть, без умножения на масштаб страницы', async () => {
    const { driver, calls } = fakeDriver();
    await driver.click({ x: 100.4, y: 80.6 }, { x: 100.4, y: 80.6 });
    expect(calls.at(-1)!.params).toMatchObject({ x: 100, y: 81 });
  });

  it('выделить всё: Cmd на mac, Ctrl на остальных, с командой selectAll', async () => {
    const mac = fakeDriver({ platform: 'mac' });
    await mac.driver.selectAll();
    expect(mac.calls[0]!.params).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] });
    const win = fakeDriver({ platform: 'other' });
    await win.driver.selectAll();
    expect(win.calls[0]!.params).toMatchObject({ modifiers: 2 });
  });

  it('ввод текста и Enter', async () => {
    const { driver, calls } = fakeDriver();
    await driver.insertText('<img src="x">');
    await driver.pressEnter();
    expect(calls[0]).toEqual({ method: 'Input.insertText', params: { text: '<img src="x">' } });
    expect(calls.slice(1).map((c) => c.params?.type)).toEqual(['rawKeyDown', 'char', 'keyUp']);
    expect(calls[2]!.params).toMatchObject({ text: '\r', key: 'Enter' });
  });
});

describe('CdpDriver.typeChars — ввод по буквам', () => {
  it('на каждый символ keyDown с текстом и keyUp; латиница с кодом клавиши, кириллица — только key', async () => {
    const { driver, calls } = fakeDriver();
    await driver.typeChars('a1 ж', 0);
    const keys = calls.map((c) => [c.params?.type, c.params?.key, c.params?.code ?? '', c.params?.text ?? '']);
    expect(keys).toEqual([
      ['keyDown', 'a', 'KeyA', 'a'],
      ['keyUp', 'a', 'KeyA', ''],
      ['keyDown', '1', 'Digit1', '1'],
      ['keyUp', '1', 'Digit1', ''],
      ['keyDown', ' ', 'Space', ' '],
      ['keyUp', ' ', 'Space', ''],
      ['keyDown', 'ж', '', 'ж'],
      ['keyUp', 'ж', '', ''],
    ]);
  });

  it('перевод строки — Enter, табуляция — вставкой, пауза между буквами', async () => {
    const pauses: number[] = [];
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const driver = new CdpDriver(async (method, params) => void calls.push({ method, params }), {
      sleep: async (ms) => void pauses.push(ms),
      random: () => 0.5,
      platform: 'other',
    });
    await driver.typeChars('x\n\ty', 25);
    expect(calls.some((c) => c.params?.key === 'Enter')).toBe(true);
    expect(calls.find((c) => c.method === 'Input.insertText')?.params).toEqual({ text: '\t' });
    expect(pauses).toEqual([25, 25, 25, 25]);
  });

  it('drag: нажать, сдвинуть с зажатой кнопкой, отпустить над целью', async () => {
    const { driver, calls } = fakeDriver();
    await driver.drag({ x: 10, y: 10 }, { x: 200, y: 50 });
    const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params!);
    const pressAt = mouse.findIndex((p) => p.type === 'mousePressed');
    expect(mouse[pressAt]).toMatchObject({ x: 10, y: 10 });
    expect(mouse.slice(pressAt + 1, -1).every((p) => p.type === 'mouseMoved' && p.buttons === 1)).toBe(true);
    expect(mouse.at(-1)).toMatchObject({ type: 'mouseReleased', x: 200, y: 50 });
  });

  it('pressKey: навигационные клавиши, Shift+Tab с модификатором', async () => {
    const { driver, calls } = fakeDriver();
    await driver.pressKey('Shift+Tab');
    expect(calls[0]!.params).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 });
    await expect(driver.pressKey('Enter')).rejects.toThrow(/not supported/);
  });

  it('wheel: мышь подъезжает, затем щелчки колеса по ~100px; сумма равна запрошенной', async () => {
    const { driver, calls } = fakeDriver();
    await driver.wheel({ x: 400, y: 300 }, 720, 0);
    const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params!);
    const wheel = mouse.filter((p) => p.type === 'mouseWheel');
    expect(mouse.some((p) => p.type === 'mouseMoved')).toBe(true);
    expect(mouse.indexOf(wheel[0]!)).toBeGreaterThan(mouse.findIndex((p) => p.type === 'mouseMoved'));
    expect(wheel.length).toBe(8);
    expect(wheel.every((p) => p.x === 400 && p.y === 300)).toBe(true);
    expect(wheel.reduce((a, p) => a + (p.deltaY as number), 0)).toBe(720);
    expect(wheel.every((p) => Math.abs(p.deltaY as number) <= 100)).toBe(true);
  });

  it('wheel: вверх — отрицательный deltaY; огромная прокрутка укладывается в предел щелчков', async () => {
    const { driver, calls } = fakeDriver();
    await driver.wheel({ x: 10, y: 10 }, -50_000);
    const wheel = calls.map((c) => c.params!).filter((p) => p.type === 'mouseWheel');
    expect(wheel.length).toBe(30);
    expect(wheel.reduce((a, p) => a + (p.deltaY as number), 0)).toBe(-50_000);
    expect(wheel.every((p) => (p.deltaY as number) < 0)).toBe(true);
  });

  it('wheel: нулевая прокрутка колесо не вращает', async () => {
    const { driver, calls } = fakeDriver();
    await driver.wheel({ x: 10, y: 10 }, 0);
    expect(calls.some((c) => c.params?.type === 'mouseWheel')).toBe(false);
  });
});
