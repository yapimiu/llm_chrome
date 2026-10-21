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
  /** Часы для расписания событий мыши (мс); по умолчанию performance.now. */
  now?: () => number;
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

/** Один «щелчок» колеса мыши и предел их числа за одно действие (большие прокрутки — крупнее щелчки). */
const WHEEL_TICK_PX = 100;
const MAX_WHEEL_TICKS = 30;

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

export interface TimedPoint extends Point {
  /** Когда выдать точку, мс от начала движения. */
  t: number;
}

export interface Motion {
  points: TimedPoint[];
  /** Полная длительность события (с остановкой на цели после микрокоррекций), мс. */
  totalMs: number;
  /** Длительность чистого движения до первой остановки (без коррекций), мс. */
  moveMs: number;
  /** Сколько микрокоррекций перед остановкой (0 на коротких перемещениях). */
  corrections: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const lerp = (lo: number, hi: number, t: number) => lo + (hi - lo) * t;
/** Профиль минимального рывка: скорость колоколом — разгон, максимум в середине, торможение у цели. */
const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Коррекции начинаются с этого расстояния: на коротких перемещениях рука не «доводит» курсор. */
const MIN_CORRECTION_DIST = 25;
/** Интервал событий мыши ≈ 125 Гц, с небольшим разбросом. */
const SAMPLE_MS: readonly [number, number] = [6, 10];
/** Полное событие (движение + коррекции + остановка на цели), мс. */
const FULL_MS: readonly [number, number] = [200, 400];

/**
 * Движение мыши от from к to, как у руки:
 *  - путь почти прямой, с лёгким низкочастотным дрейфом поперёк (до 2% длины, не больше 6 px),
 *    без зигзагов, дуг и скачков;
 *  - скорость колоколом: плавный разгон, максимум в середине, торможение у цели;
 *  - чистое движение на 100 px — 50–150 мс (дальше медленнее, по закону Фиттса), перед остановкой
 *    1–3 микрокоррекции в пару пикселей, всё событие целиком — 200–400 мс.
 * Калибровка: 100 px при 1600 DPI — это около 1,6 мм хода мыши.
 * Последняя точка — ровно цель; моменты точек — в t (мс от начала).
 */
export function mouseMotion(from: Point, to: Point, random: () => number): Motion {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return { points: [{ ...to, t: 0 }], totalMs: 12, moveMs: 0, corrections: 0 };

  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;
  const at = (base: Point, along: number, across = 0): Point => ({ x: base.x + ux * along + nx * across, y: base.y + uy * along + ny * across });

  // Чистое движение: закон Фиттса — 100 px ≈ 100 мс при разбросе ±40%.
  const moveMs = clamp(50 + 50 * Math.log2(1 + dist / 100), 50, 260) * lerp(0.6, 1.4, random());
  const corrections = dist < MIN_CORRECTION_DIST ? 0 : 1 + Math.floor(random() * 3);
  // Рука чуть перелетает или недолетает; дальше коррекции сходятся к цели.
  const miss = corrections ? (random() < 0.5 ? -1 : 1) * clamp(0.025 * dist, 1.5, 5) : 0;
  const landing = at(to, miss, corrections ? lerp(-1, 1, random()) : 0);

  // Дрейф поперёк: плавная кривая нулевая на концах, одна-две «волны» без резких разворотов.
  const amp = lerp(-1, 1, random()) * Math.min(0.02 * dist, 6);
  const drift = (tau: number) => amp * (0.7 * Math.sin(Math.PI * tau) + 0.3 * Math.sin(2 * Math.PI * tau));

  const points: TimedPoint[] = [];
  let t = 0;
  while (t < moveMs) {
    t = Math.min(moveMs, t + lerp(SAMPLE_MS[0], SAMPLE_MS[1], random()));
    const tau = t / moveMs;
    const s = minJerk(tau);
    const line: Point = { x: from.x + (landing.x - from.x) * s, y: from.y + (landing.y - from.y) * s };
    points.push({ ...at(line, 0, drift(tau)), t });
  }
  points[points.length - 1] = { ...landing, t: moveMs };

  // Микрокоррекции: короткие поправки с паузой после каждой; последняя приводит ровно в цель.
  const stops = [at(to, -0.45 * miss), at(to, 0.18 * miss)].slice(0, Math.max(0, corrections - 1));
  stops.push({ ...to });
  let cur = landing;
  for (const stop of stops) {
    const legMs = lerp(20, 52, random());
    const legStart = t;
    for (let step = 1; step <= 3; step++) {
      const k = smooth(step / 3);
      points.push({ x: cur.x + (stop.x - cur.x) * k, y: cur.y + (stop.y - cur.y) * k, t: legStart + (legMs * step) / 3 });
    }
    t = legStart + legMs + lerp(8, 28, random());
    cur = stop;
  }
  points[points.length - 1] = { ...to, t: points[points.length - 1]!.t };

  // Курсор «замирает» на цели до полного времени события (прицеливание перед нажатием).
  return { points, totalMs: Math.max(t, lerp(FULL_MS[0], FULL_MS[1], random())), moveMs, corrections };
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

  /**
   * Ведёт мышь к точке по траектории mouseMotion: события mouseMoved идут по расписанию (≈125 Гц) —
   * срабатывают hover-меню и подсказки. Если мышь ещё не двигалась, она «приходит» сверху-слева,
   * а не появляется на цели.
   */
  async moveTo(to: Point, from?: Point, pressed = false): Promise<void> {
    const r = this.opts.random;
    const start = from ?? this.pos ?? { x: Math.max(1, to.x - lerp(150, 300, r())), y: Math.max(1, to.y - lerp(80, 200, r())) };
    const extra = pressed ? { button: 'left', buttons: 1 } : {};
    const now = this.opts.now ?? (() => performance.now());
    const motion = mouseMotion(start, to, r);
    const t0 = now();
    let last = from ?? this.pos ? null : start;
    if (last) await this.mouse('mouseMoved', start, extra);
    for (const p of motion.points) {
      await this.opts.sleep(Math.max(0, p.t - (now() - t0)));
      // Одинаковые целые координаты подряд не шлём: у настоящей мыши их нет.
      if (last && Math.round(last.x) === Math.round(p.x) && Math.round(last.y) === Math.round(p.y)) continue;
      await this.mouse('mouseMoved', p, extra);
      last = p;
    }
    await this.opts.sleep(Math.max(0, motion.totalMs - (now() - t0)));
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

  /**
   * Прокрутка колесом мыши над точкой at: мышь подъезжает, затем идут «щелчки» колеса по ~100px
   * с короткими паузами — как у руки. Браузер сам выбирает, что прокручивать (вложенный блок,
   * затем страница), и страница получает настоящие wheel/scroll-события. deltaY > 0 — вниз.
   */
  async wheel(at: Point, deltaY: number, deltaX = 0): Promise<void> {
    await this.moveTo(at);
    const total = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    if (total < 1) return;
    const ticks = Math.min(MAX_WHEEL_TICKS, Math.max(1, Math.ceil(total / WHEEL_TICK_PX)));
    let sentX = 0;
    let sentY = 0;
    for (let i = 1; i <= ticks; i++) {
      // Целые накопленные значения: сумма тиков ровно равна запрошенной.
      const x = Math.round((deltaX * i) / ticks);
      const y = Math.round((deltaY * i) / ticks);
      await this.mouse('mouseWheel', at, { deltaX: x - sentX, deltaY: y - sentY });
      sentX = x;
      sentY = y;
      if (i < ticks) await this.opts.sleep(14 + Math.round(this.opts.random() * 16));
    }
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
