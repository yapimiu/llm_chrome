import { describe, expect, it } from 'vitest';
import { CdpDriver, mousePath } from '@/lib/exec/cdp';

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

describe('mousePath', () => {
  it('заканчивается ровно в цели, длинный путь — больше шагов', () => {
    const short = mousePath({ x: 0, y: 0 }, { x: 100, y: 0 }, () => 0.9);
    const long = mousePath({ x: 0, y: 0 }, { x: 1000, y: 600 }, () => 0.9);
    expect(short.at(-1)).toEqual({ x: 100, y: 0 });
    expect(long.at(-1)).toEqual({ x: 1000, y: 600 });
    expect(short.length).toBeGreaterThanOrEqual(6);
    expect(long.length).toBeGreaterThan(short.length);
    expect(long.length).toBeLessThanOrEqual(20);
  });

  it('движется вперёд без рывков назад по главной оси', () => {
    const path = mousePath({ x: 0, y: 0 }, { x: 800, y: 0 }, () => 0.1);
    for (let i = 1; i < path.length; i++) expect(path[i]!.x).toBeGreaterThanOrEqual(path[i - 1]!.x);
  });

  it('на месте — одна точка', () => {
    expect(mousePath({ x: 5, y: 5 }, { x: 6, y: 5 }, () => 0.5)).toEqual([{ x: 6, y: 5 }]);
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
});
