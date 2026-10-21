const HOST_TAG = 'llm-agent-cursor';
const MAX_Z = '2147483647';

/** Стрелка курсора: белая с тёмной обводкой, читается на любом фоне. */
const ARROW_SVG = `
<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z"
        fill="#fff" stroke="#1c1f24" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

/**
 * Визуальный курсор агента — чистая косметика: плавно едет к точке клика и «нажимает».
 * Не перехватывает события (pointer-events: none), поэтому не мешает ни CDP-кликам, ни сборщику.
 */
export class CursorOverlay {
  private host: HTMLElement | null = null;
  private pointer: HTMLElement | null = null;
  private ripple: HTMLElement | null = null;
  private pos = { x: -40, y: -40 };
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly doc: Document) {}

  isOwn(el: Element): boolean {
    return el === this.host;
  }

  private mount(): void {
    if (this.host) return;
    const host = this.doc.createElement(HOST_TAG);
    host.style.cssText = `all: initial; position: fixed; inset: 0; pointer-events: none; z-index: ${MAX_Z};`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = `
      .pointer { position: fixed; left: 0; top: 0; transition-property: transform;
        transition-timing-function: cubic-bezier(.45,.05,.25,1); filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
      .ripple { position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px;
        border-radius: 50%; border: 2px solid #2f6fde; opacity: 0; pointer-events: none; }
      .ripple.on { animation: ripple .45s ease-out; }
      @keyframes ripple { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.4); } }
    `;
    const pointer = this.doc.createElement('div');
    pointer.className = 'pointer';
    pointer.innerHTML = ARROW_SVG;
    const ripple = this.doc.createElement('div');
    ripple.className = 'ripple';
    root.append(style, ripple, pointer);
    this.doc.documentElement.append(host);
    this.host = host;
    this.pointer = pointer;
    this.ripple = ripple;
    this.place(this.pos, 0);
  }

  private place(p: { x: number; y: number }, durationMs: number): void {
    if (!this.pointer) return;
    this.pointer.style.transitionDuration = `${durationMs}ms`;
    // Кончик стрелки — в точке (2,2) картинки.
    this.pointer.style.transform = `translate(${p.x - 2}px, ${p.y - 2}px)`;
  }

  /** Плавно переводит курсор в точку (координаты вьюпорта); resolve — когда доехал. */
  moveTo(x: number, y: number, durationMs = 300): Promise<void> {
    this.mount();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.pos = { x, y };
    this.place(this.pos, durationMs);
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  /**
   * Курсор следует за настоящей мышью: вызывается на каждое событие mousemove (≈125 Гц от CDP),
   * поэтому показывает ровно ту траекторию, по которой ходит мышь, — и при hover, и при перетаскивании.
   */
  follow(x: number, y: number): void {
    this.pos = { x, y };
    if (!this.host) this.mount();
    else this.place(this.pos, 40);
    this.hideLater();
  }

  /** Кружок «нажатия» под курсором. */
  click(): void {
    if (!this.ripple) return;
    this.ripple.style.left = `${this.pos.x}px`;
    this.ripple.style.top = `${this.pos.y}px`;
    this.ripple.classList.remove('on');
    void this.ripple.offsetWidth; // перезапуск анимации
    this.ripple.classList.add('on');
  }

  /** Убирает курсор после паузы — чтобы он не висел над страницей, когда агент думает. */
  hideLater(ms = 4000): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
    this.pointer = null;
    this.ripple = null;
  }
}
