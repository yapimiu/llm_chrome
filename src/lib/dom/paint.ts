import type { Rect } from './types';

/** Что нужно знать о стилях элемента, чтобы понять, нарисован ли он на самом деле. */
export interface PaintStyle {
  position: string;
  overflowX: string;
  overflowY: string;
  opacity: string;
  transform: string;
  contain: string;
}

export interface PaintDeps {
  style(el: Element): PaintStyle;
  /** Видимая область содержимого элемента (padding box) в координатах вьюпорта. */
  clientBox(el: Element): Rect;
}

/** Ниже такой суммарной прозрачности элемент глазом не виден (затухшая подсказка, исчезнувшая кнопка). */
export const MIN_OPACITY = 0.1;
const NO_CLIP = 1e7;
export const UNCLIPPED: Rect = { x: -NO_CLIP, y: -NO_CLIP, width: 2 * NO_CLIP, height: 2 * NO_CLIP };

const clipsAxis = (v: string) => v === 'hidden' || v === 'clip';
const scrollsAxis = (v: string) => v === 'auto' || v === 'scroll' || v === 'overlay';

/** Родитель в «плоском» дереве: через слот и границу shadow DOM. */
function parentOf(el: Element): Element | null {
  return (el as HTMLElement).assignedSlot ?? el.parentElement ?? ((el.getRootNode() as Partial<ShadowRoot>).host ?? null);
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

export type PaintVerdict = { painted: true; clip: Rect } | { painted: false; why: string };

/**
 * Нарисован ли элемент на самом деле и какой областью его обрезают предки. Ловит то, что
 * пропускает checkVisibility: свёрнутые блоки (max-height: 0 + overflow: hidden), слайды за краем
 * карусели, кнопки внутри aria-hidden и почти прозрачные (затухшие) элементы.
 *
 * Обрезка по правилам CSS: overflow: hidden/clip и contain: paint режут потомков; absolute-элемент
 * режут только предки начиная с его containing block, fixed — только трансформированные предки.
 * Контейнеры прокрутки (auto/scroll) не режут: до содержимого можно докрутить.
 */
export function paintVerdict(el: Element, deps: PaintDeps): PaintVerdict {
  const own = deps.style(el);
  let opacity = Number.parseFloat(own.opacity);
  if (Number.isNaN(opacity)) opacity = 1;
  if (opacity < MIN_OPACITY) return { painted: false, why: 'transparent' };
  /** Обрезка самого элемента — предками до ближайшего контейнера прокрутки. */
  let clip: Rect = UNCLIPPED;
  /**
   * Контейнер прокрутки, через который прошли: содержимое в нём можно докрутить, поэтому обрезки выше
   * него проверяются для самого контейнера, а не для элемента (SPA: корень overflow: hidden, внутри скролл).
   */
  let boundary: Rect | null = null;
  let outer: Rect = UNCLIPPED;
  let mode = own.position === 'fixed' ? 'fixed' : own.position === 'absolute' ? 'abs' : 'normal';
  const doc = el.ownerDocument;
  const hidden = (why: string): PaintVerdict => ({ painted: false, why });

  for (let a = parentOf(el); a && a !== doc.documentElement && a !== doc.body; a = parentOf(a)) {
    if (a.getAttribute('aria-hidden') === 'true') return hidden('inside aria-hidden');
    const s = deps.style(a);
    const o = Number.parseFloat(s.opacity);
    if (!Number.isNaN(o)) opacity *= o;
    if (opacity < MIN_OPACITY) return hidden('transparent');

    const transformed = s.transform !== '' && s.transform !== 'none';
    const positioned = s.position !== 'static' || transformed;
    // Режет ли этот предок: для absolute — только containing block и выше, для fixed — только трансформированный.
    const inChain = mode === 'normal' || (mode === 'abs' && positioned) || (mode === 'fixed' && transformed);
    if (!inChain) continue;

    const paint = /\b(paint|strict|content)\b/.test(s.contain);
    const cx = paint || clipsAxis(s.overflowX);
    const cy = paint || clipsAxis(s.overflowY);
    const scrolls = !paint && (scrollsAxis(s.overflowX) || scrollsAxis(s.overflowY));
    if (cx || cy || scrolls) {
      const box = deps.clientBox(a);
      if (box.width <= 1 || box.height <= 1) return hidden(cx || cy ? 'clipped by a collapsed or hidden container' : 'inside a collapsed container');
      if (cx || cy) {
        const region: Rect = {
          x: cx ? box.x : UNCLIPPED.x,
          y: cy ? box.y : UNCLIPPED.y,
          width: cx ? box.width : UNCLIPPED.width,
          height: cy ? box.height : UNCLIPPED.height,
        };
        const next = intersect(boundary ? outer : clip, region);
        if (!next || next.width <= 1 || next.height <= 1) return hidden('clipped by a collapsed or hidden container');
        if (boundary) outer = next;
        else clip = next;
      }
      if (scrolls) {
        // До элемента в контейнере прокрутки можно докрутить; дальше важно, виден ли сам контейнер.
        if (boundary && !clipShape(boundary, outer)) return hidden('inside a hidden scrolling area');
        boundary = box;
        outer = UNCLIPPED;
      }
    }
    mode = s.position === 'fixed' && !transformed ? 'fixed' : s.position === 'absolute' ? 'abs' : 'normal';
  }
  if (boundary && !clipShape(boundary, outer)) return hidden('inside a hidden scrolling area');
  return { painted: true, clip };
}

/** Видимая часть фигуры элемента после обрезки предками; null — не видно ничего. */
export function clipShape(shape: Rect, clip: Rect): Rect | null {
  const r = intersect(shape, clip);
  return r && r.width > 1 && r.height > 1 ? r : null;
}
