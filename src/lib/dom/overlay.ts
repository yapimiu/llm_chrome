import type { Rect } from './types';

export interface OverlayItem {
  index: number;
  /** Подпись рамки; по умолчанию — номер. */
  label?: string;
  /** Текущий прямоугольник в координатах вьюпорта (вызывается при каждой перерисовке); null — элемент сейчас не виден. */
  rect: () => Rect | null;
}

const HOST_TAG = 'llm-agent-overlay';
const MAX_Z = '2147483646';

/**
 * Debug-подсветка: рамки с номерами поверх страницы. Живёт в shadow root,
 * чтобы стили страницы её не ломали, и не перехватывает клики (pointer-events: none).
 */
export class DebugOverlay {
  private host: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private items: OverlayItem[] = [];
  private frame = 0;
  private readonly onChange = () => this.schedule();

  constructor(private readonly doc: Document) {}

  isOwn(el: Element): boolean {
    return el === this.host;
  }

  get visible(): boolean {
    return this.host !== null;
  }

  show(items: OverlayItem[]): void {
    this.items = items;
    this.mount();
    this.draw();
  }

  hide(): void {
    if (!this.host) return;
    const win = this.doc.defaultView;
    win?.removeEventListener('scroll', this.onChange, true);
    win?.removeEventListener('resize', this.onChange);
    this.doc.removeEventListener('transitionend', this.onChange, true);
    this.doc.removeEventListener('animationend', this.onChange, true);
    if (this.frame) win?.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.host.remove();
    this.host = null;
    this.layer = null;
    this.items = [];
  }

  private mount(): void {
    if (this.host) return;
    const host = this.doc.createElement(HOST_TAG);
    host.style.cssText = `all: initial; position: fixed; inset: 0; pointer-events: none; z-index: ${MAX_Z};`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = `
      .box { position: fixed; box-sizing: border-box; border: 2px solid var(--c); border-radius: 3px; }
      .label {
        position: absolute; top: -2px; left: -2px; transform: translateY(-100%);
        background: var(--c); color: #fff; font: 700 13px/1.2 ui-monospace, Menlo, monospace;
        padding: 1px 3px; border-radius: 3px 3px 3px 0; white-space: nowrap;
      }
      .box.low .label { transform: none; border-radius: 0 0 3px 0; }
    `;
    const layer = this.doc.createElement('div');
    root.append(style, layer);
    this.doc.documentElement.append(host);
    this.host = host;
    this.layer = layer;
    const win = this.doc.defaultView;
    win?.addEventListener('scroll', this.onChange, { capture: true, passive: true });
    win?.addEventListener('resize', this.onChange, { passive: true });
    // Блок свернулся или раскрылся без прокрутки — рамки надо передвинуть или убрать.
    this.doc.addEventListener('transitionend', this.onChange, { capture: true, passive: true });
    this.doc.addEventListener('animationend', this.onChange, { capture: true, passive: true });
  }

  private schedule(): void {
    const win = this.doc.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (!this.layer) return;
    const win = this.doc.defaultView;
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    const frag = this.doc.createDocumentFragment();
    for (const item of this.items) {
      let r: Rect | null;
      try {
        r = item.rect();
      } catch {
        continue; // элемент удалён из DOM
      }
      if (!r) continue;
      if (r.width <= 0 || r.height <= 0 || r.y + r.height < 0 || r.y > vh || r.x + r.width < 0 || r.x > vw) continue;
      const hue = (item.index * 47) % 360;
      const box = this.doc.createElement('div');
      box.className = r.y < 16 ? 'box low' : 'box';
      box.style.cssText = `--c: hsl(${hue} 85% 42%); left:${r.x}px; top:${r.y}px; width:${r.width}px; height:${r.height}px;`;
      const label = this.doc.createElement('span');
      label.className = 'label';
      label.textContent = item.label ?? String(item.index);
      box.append(label);
      frag.append(box);
    }
    this.layer.replaceChildren(frag);
  }
}
