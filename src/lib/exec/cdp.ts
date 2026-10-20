export interface Point {
  x: number;
  y: number;
}

/** Отправка команды Chrome DevTools Protocol в вкладку. */
export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface CdpDriverOptions {
  sleep: (ms: number) => Promise<void>;
  /** Источник случайности [0, 1) — подменяется в тестах. */
  random: () => number;
  /** На mac «выделить всё» — Cmd+A, иначе Ctrl+A. */
  platform: 'mac' | 'other';
}

/** Описание клавиши для символа: латиница и цифры — с кодом клавиши, остальное (кириллица, знаки) — только key. */
export function keyFor(ch: string): { key: string; code?: string; windowsVirtualKeyCode?: number; nativeVirtualKeyCode?: number } {
  if (/^[a-z]$/i.test(ch)) {
    const vk = ch.toUpperCase().charCodeAt(0);
    return { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  }
  if (/^[0-9]$/.test(ch)) {
    const vk = ch.charCodeAt(0);
    return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  }
  if (ch === ' ') return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  return { key: ch };
}

const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

/** Навигационные клавиши для press_key: key, code и виртуальный код. */
const NAV_KEYS: Record<string, { key: string; code: string; vk: number }> = {
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Траектория мыши от from к to: плавный разгон/торможение и лёгкий изгиб, как у руки.
 * Последняя точка — ровно цель. Количество шагов растёт с расстоянием (6–20).
 */
export function mousePath(from: Point, to: Point, random: () => number): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [to];
  const steps = Math.max(6, Math.min(20, Math.round(dist / 40)));
  // Изгиб перпендикулярно направлению — до 8% длины пути.
  const bend = (random() - 0.5) * 0.16 * dist;
  const nx = -dy / dist;
  const ny = dx / dist;
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = easeInOut(t);
    const arc = Math.sin(Math.PI * t) * bend;
    points.push(i === steps ? { ...to } : { x: from.x + dx * e + nx * arc, y: from.y + dy * e + ny * arc });
  }
  return points;
}

/**
 * Настоящие (isTrusted) события мыши и клавиатуры через CDP Input.*.
 * Координаты принимает в CSS-пикселях вьюпорта верхней страницы — в них же их ждёт
 * Input.dispatchMouseEvent при любом масштабе страницы (умножать на zoom нельзя: клик уедет).
 */
export class CdpDriver {
  private pos: Point | null = null;

  constructor(
    private readonly send: CdpSend,
    private readonly opts: CdpDriverOptions,
  ) {}

  /** Где сейчас «мышь» (CSS-пиксели); null — ещё не двигалась. */
  get position(): Point | null {
    return this.pos;
  }

  private mouse(type: string, p: Point, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), ...extra });
  }

  /** Плавно ведёт мышь к точке (события mouseMoved) — срабатывают hover-меню и подсказки. */
  async moveTo(to: Point, from?: Point, pressed = false): Promise<void> {
    const start = from ?? this.pos ?? to;
    for (const p of mousePath(start, to, this.opts.random)) {
      await this.mouse('mouseMoved', p, pressed ? { button: 'left', buttons: 1 } : {});
      await this.opts.sleep(8 + Math.round(this.opts.random() * 8));
    }
    this.pos = { ...to };
  }

  async click(at: Point, from?: Point): Promise<void> {
    await this.moveTo(at, from);
    await this.mouse('mousePressed', at, { button: 'left', buttons: 1, clickCount: 1 });
    await this.opts.sleep(40 + Math.round(this.opts.random() * 70));
    await this.mouse('mouseReleased', at, { button: 'left', buttons: 0, clickCount: 1 });
  }

  /**
   * Перетаскивание мышью: нажать, сдвинуть на несколько пикселей (иначе библиотеки не начнут drag),
   * довести до цели с зажатой кнопкой, отпустить. Работает для drag-n-drop на pointer/mouse-событиях.
   */
  async drag(from: Point, to: Point): Promise<void> {
    await this.moveTo(from);
    await this.mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
    await this.opts.sleep(120);
    const nudge = { x: from.x + 6, y: from.y + 6 };
    await this.mouse('mouseMoved', nudge, { button: 'left', buttons: 1 });
    await this.moveTo(to, nudge, true);
    await this.opts.sleep(120);
    await this.mouse('mouseMoved', to, { button: 'left', buttons: 1 });
    await this.mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Навигационная клавиша (Escape, Tab, Shift+Tab, стрелки…) в элемент с фокусом. */
  async pressKey(name: string): Promise<void> {
    const shift = name.startsWith('Shift+');
    const def = NAV_KEYS[shift ? name.slice(6) : name];
    if (!def) throw new Error(`key "${name}" is not supported`);
    const key = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: shift ? MODIFIER_SHIFT : 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  /** Вставка текста в сфокусированное поле — как ввод с клавиатуры (beforeinput/input). */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /**
   * Ввод по одному символу: keyDown с текстом (браузер сам вставит символ) и keyUp — у страницы
   * на каждую букву срабатывают keydown → keypress → beforeinput/input → keyup, как с клавиатуры.
   * Перевод строки — Enter, табуляция — вставкой (Tab увёл бы фокус).
   */
  async typeChars(text: string, delayMs: number): Promise<void> {
    for (const ch of text) {
      if (ch === '\n') await this.pressEnter();
      else if (ch === '\r') continue;
      else if (ch === '\t') await this.insertText(ch);
      else {
        const key = keyFor(ch);
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: ch, unmodifiedText: ch });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      }
      if (delayMs > 0) await this.opts.sleep(delayMs);
    }
  }

  /** Cmd/Ctrl+A с командой редактора selectAll — работает и в редакторах кода. */
  async selectAll(): Promise<void> {
    const modifiers = this.opts.platform === 'mac' ? MODIFIER_META : MODIFIER_CTRL;
    const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['selectAll'] });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async pressBackspace(): Promise<void> {
    const key = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async pressEnter(): Promise<void> {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'char', ...key, text: '\r', unmodifiedText: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }
}
