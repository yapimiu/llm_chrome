// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { findClickPoint } from '@/lib/dom/act';
import { collectSnapshot, topRect, type RegistryEntry, type TraceVerdict } from '@/lib/dom/collect';
import type { Geometry } from '@/lib/dom/geometry';
import { clipShape, paintVerdict, UNCLIPPED, type PaintDeps, type PaintStyle } from '@/lib/dom/paint';
import type { Rect } from '@/lib/dom/types';

/** Стили и прямоугольники задаются атрибутами: data-s="overflow-y:hidden;opacity:0.5", data-r="x,y,w,h". */
function styleOf(el: Element): PaintStyle {
  const s: PaintStyle = { position: 'static', overflowX: 'visible', overflowY: 'visible', opacity: '1', transform: 'none', contain: 'none' };
  for (const part of (el.getAttribute('data-s') ?? '').split(';').filter(Boolean)) {
    const [k, v] = part.split(':').map((x) => x.trim()) as [string, string];
    if (k === 'overflow') {
      s.overflowX = v;
      s.overflowY = v;
    } else if (k === 'overflow-x') s.overflowX = v;
    else if (k === 'overflow-y') s.overflowY = v;
    else (s as unknown as Record<string, string>)[k] = v;
  }
  return s;
}
function rectOf(el: Element): Rect {
  const [x, y, width, height] = (el.getAttribute('data-r') ?? '0,0,100,30').split(',').map(Number) as [number, number, number, number];
  return { x, y, width, height };
}
const deps: PaintDeps = { style: styleOf, clientBox: rectOf };
const $ = (sel: string) => document.querySelector(sel)!;
/** Виден ли элемент после обрезки предками — так решает сборщик. */
const shown = (el: Element) => {
  const v = paintVerdict(el, deps);
  return v.painted && clipShape(rectOf(el), v.clip) !== null;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('paintVerdict — нарисован ли элемент на самом деле', () => {
  it('обычная кнопка — видна, ничего не обрезает', () => {
    document.body.innerHTML = '<div><button>OK</button></div>';
    expect(paintVerdict($('button'), deps)).toEqual({ painted: true, clip: UNCLIPPED });
  });

  it('свёрнутый блок (max-height: 0 + overflow: hidden) — кнопка внутри не видна', () => {
    document.body.innerHTML = '<div data-s="overflow:hidden" data-r="0,100,400,0"><button data-r="0,100,100,30">Узнать ответ</button></div>';
    expect(paintVerdict($('button'), deps)).toMatchObject({ painted: false, why: expect.stringMatching(/clipped/) });
  });

  it('частично обрезанный блок — видна только его часть', () => {
    document.body.innerHTML = '<div data-s="overflow:hidden" data-r="0,0,400,50"><button data-r="0,30,100,40">X</button></div>';
    const v = paintVerdict($('button'), deps);
    expect(v.painted).toBe(true);
    if (v.painted) expect(clipShape(rectOf($('button')), v.clip)).toEqual({ x: 0, y: 30, width: 100, height: 20 });
  });

  it('слайд за краем карусели (overflow-x: hidden) — не виден', () => {
    document.body.innerHTML = '<div data-s="overflow-x:hidden" data-r="0,0,300,200"><a data-r="900,10,280,180">Слайд 4</a></div>';
    expect(shown($('a'))).toBe(false);
  });

  it('контейнер прокрутки не обрезает: до содержимого можно докрутить; но пустой (0px) — скрывает', () => {
    document.body.innerHTML = '<div data-s="overflow-y:auto" data-r="0,0,300,200"><button data-r="0,900,100,30">Внизу</button></div>';
    expect(paintVerdict($('button'), deps).painted).toBe(true);
    document.body.innerHTML = '<div data-s="overflow-y:auto" data-r="0,0,300,0"><button data-r="0,0,100,30">X</button></div>';
    expect(paintVerdict($('button'), deps).painted).toBe(false);
  });

  it('SPA: корень overflow: hidden, внутри контейнер прокрутки — кнопка ниже экрана доступна прокруткой', () => {
    document.body.innerHTML =
      '<div data-s="overflow:hidden" data-r="0,0,1000,800"><main data-s="overflow-y:auto" data-r="0,0,1000,800"><button data-r="0,1500,100,30">Далее</button></main></div>';
    expect(shown($('button'))).toBe(true);
  });

  it('контейнер прокрутки внутри свёрнутого блока — содержимое скрыто', () => {
    document.body.innerHTML =
      '<div data-s="overflow:hidden" data-r="0,0,1000,800"><main data-s="overflow-y:auto" data-r="0,900,1000,300"><button data-r="0,950,100,30">X</button></main></div>';
    expect(paintVerdict($('button'), deps)).toMatchObject({ painted: false, why: 'inside a hidden scrolling area' });
  });

  it('absolute-элемент не режется предком, который не его containing block', () => {
    document.body.innerHTML =
      '<div data-s="position:relative" data-r="0,0,800,600"><div data-s="overflow:hidden" data-r="0,0,100,20"><button data-s="position:absolute" data-r="200,200,100,30">Меню</button></div></div>';
    expect(shown($('button'))).toBe(true);
  });

  it('absolute-элемент режется своим containing block с overflow: hidden', () => {
    document.body.innerHTML = '<div data-s="position:relative;overflow:hidden" data-r="0,0,100,20"><button data-s="position:absolute" data-r="200,200,100,30">Меню</button></div>';
    expect(shown($('button'))).toBe(false);
  });

  it('fixed-элемент не режется обычными предками, но режется трансформированным', () => {
    document.body.innerHTML = '<div data-s="overflow:hidden" data-r="0,0,10,10"><button data-s="position:fixed" data-r="500,500,100,30">Чат</button></div>';
    expect(shown($('button'))).toBe(true);
    document.body.innerHTML = '<div data-s="overflow:hidden;transform:translateX(0)" data-r="0,0,10,10"><button data-s="position:fixed" data-r="500,500,100,30">Чат</button></div>';
    expect(shown($('button'))).toBe(false);
  });

  it('внутри aria-hidden="true" — скрыт; сам aria-hidden у кнопки не считается', () => {
    document.body.innerHTML = '<div aria-hidden="true"><button>Старая</button></div><span aria-hidden="true" id="icon">×</span>';
    expect(paintVerdict($('button'), deps)).toMatchObject({ painted: false, why: 'inside aria-hidden' });
    expect(paintVerdict($('#icon'), deps).painted).toBe(true);
  });

  it('затухшая кнопка: суммарная прозрачность предков ниже 0.1', () => {
    document.body.innerHTML = '<div data-s="opacity:0.3"><div data-s="opacity:0.2"><button>Готово</button></div></div>';
    expect(paintVerdict($('button'), deps)).toMatchObject({ painted: false, why: 'transparent' });
    document.body.innerHTML = '<div data-s="opacity:0.5"><button>Готово</button></div>';
    expect(paintVerdict($('button'), deps).painted).toBe(true);
  });

  it('contain: paint режет по обеим осям', () => {
    document.body.innerHTML = '<div data-s="contain:paint" data-r="0,0,100,100"><a data-r="0,300,50,20">Ссылка</a></div>';
    expect(shown($('a'))).toBe(false);
  });
});

// ——— интеграция со сборщиком и кликом ———

function geom(opts: { hit?: (x: number, y: number) => Element | null; fragments?: Map<Element, Rect[]>; withPaint?: boolean } = {}): Geometry {
  return {
    style: (el) => {
      const s = styleOf(el);
      return { display: el.localName === 'span' ? 'inline' : 'block', cursor: 'auto', overflowY: s.overflowY, position: s.position };
    },
    isVisible: () => true,
    rect: rectOf,
    frameContentBox: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    hitTest: (_root, x, y) => (opts.hit ? opts.hit(x, y) : document.elementFromPoint?.(x, y) ?? null),
    viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 2000 }),
    scrollBox: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 }),
    ...(opts.withPaint === false ? {} : { paint: (el: Element) => paintVerdict(el, deps) }),
    fragments: (el) => opts.fragments?.get(el) ?? [],
  };
}

describe('сборщик: «призраки» не попадают в список', () => {
  it('кнопка в свёрнутом блоке ниже экрана — отброшена как скрытая, с причиной', () => {
    document.body.innerHTML =
      '<button id="ok" data-r="10,10,100,30">Далее</button><div data-s="overflow:hidden" data-r="0,1200,400,0"><button id="ghost" data-r="0,1200,100,30">Узнать ответ</button></div>';
    const trace = new Map<Element, TraceVerdict>();
    const ok = $('#ok');
    const { snapshot } = collectSnapshot(document, geom({ hit: () => ok }), { trace });
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Далее']);
    expect(trace.get($('#ghost'))).toMatchObject({ kind: 'hidden', why: expect.stringMatching(/clipped/) });
    expect(snapshot.stats.hidden).toBe(1);
  });

  it('без проверки отрисовки (старая геометрия) поведение прежнее', () => {
    document.body.innerHTML = '<div data-s="overflow:hidden" data-r="0,1200,400,0"><button data-r="0,1200,100,30">Узнать ответ</button></div>';
    const { snapshot } = collectSnapshot(document, geom({ withPaint: false }));
    expect(snapshot.elements).toHaveLength(1);
  });

  it('строчный элемент на две строки: рамка — его строка, проверка попадания — по строке, а не по охвату', () => {
    document.body.innerHTML = '<p data-r="0,100,600,60">Вместо четырёх строк кода <span id="term" role="button" data-r="200,100,400,60">для селектора .card</span> напишите одну</p>';
    const term = $('#term');
    const lines = [
      { x: 500, y: 100, width: 100, height: 28 },
      { x: 0, y: 130, width: 60, height: 28 },
    ];
    // По центру охвата (400,130) — чужой текст абзаца; по строкам — сам элемент.
    const p = $('p');
    const hit = (x: number, y: number) => (lines.some((l) => x >= l.x && x <= l.x + l.width && y >= l.y && y <= l.y + l.height) ? term : p);
    const g = geom({ hit, fragments: new Map([[term, lines]]) });
    const { snapshot, registry } = collectSnapshot(document, g);
    const info = snapshot.elements.find((e) => e.role === 'button')!;
    expect(info.rect).toEqual(lines[0]);
    const entry = registry.find((r) => r.index === info.index)!;
    expect(topRect(entry, g)).toEqual(lines[0]);
    expect(findClickPoint(entry, g, false)).toEqual({ ok: true, x: 550, y: 114 });
  });
});

describe('клик по элементу, который исчез после прошлого шага', () => {
  it('понятная ошибка вместо клика в пустоту', () => {
    document.body.innerHTML = '<div data-s="overflow:hidden" data-r="0,0,400,0"><button data-r="0,0,100,30">Проверить</button></div>';
    const btn = $('button');
    const entry: RegistryEntry = { index: 7, element: btn, target: btn, frames: [] };
    expect(findClickPoint(entry, geom({ hit: () => btn }), false)).toMatchObject({ ok: false, message: expect.stringMatching(/\[7\] is no longer visible/) });
  });

  it('элемент целиком за краем обрезающего блока — тоже «больше не виден», а не «за экраном»', () => {
    document.body.innerHTML = '<div data-s="overflow-x:hidden" data-r="0,0,300,200"><a data-r="900,10,280,180">Слайд 4</a></div>';
    const a = $('a');
    const entry: RegistryEntry = { index: 3, element: a, target: a, frames: [] };
    expect(findClickPoint(entry, geom({ hit: () => a }), false)).toMatchObject({ ok: false, message: expect.stringMatching(/\[3\] is no longer visible/) });
  });
});
