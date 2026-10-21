// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findClickPoint, NO_EFFECT_NOTE, scrollInfo, performAndSettle, performDomAction, readFieldValue, selectFieldContent, scrollableAncestor, setNativeValue, valueHasText, waitForText, type ActContext } from '@/lib/dom/act';
import type { Geometry } from '@/lib/dom/geometry';
import type { RegistryEntry } from '@/lib/dom/collect';
import { waitForStable } from '@/lib/dom/stable';

function ctxFor(...elements: Element[]): ActContext {
  const registry: RegistryEntry[] = elements.map((el, i) => ({ index: i + 1, element: el, target: el, frames: [] }));
  return { registry, scroller: null, win: window };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('performDomAction: click', () => {
  it('отправляет полную последовательность событий и активирует элемент', () => {
    document.body.innerHTML = '<button>OK</button>';
    const btn = document.querySelector('button')!;
    const events: string[] = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) btn.addEventListener(t, () => events.push(t));
    const r = performDomAction({ action: 'click', index: 1 }, ctxFor(btn));
    expect(r).toEqual({ ok: true, message: 'clicked' });
    expect(events.filter((e) => e !== 'pointerdown' && e !== 'pointerup')).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('переключает checkbox через label-цель', () => {
    document.body.innerHTML = '<input type="checkbox" id="c"><label for="c">Согласен</label>';
    const input = document.querySelector('input')!;
    const label = document.querySelector('label')!;
    const ctx: ActContext = { registry: [{ index: 1, element: input, target: label, frames: [] }], scroller: null, win: window };
    performDomAction({ action: 'click', index: 1 }, ctx);
    expect(input.checked).toBe(true);
  });

  it('ошибки: нет номера, элемент исчез, элемент отключён', () => {
    document.body.innerHTML = '<button disabled>X</button><a>Y</a>';
    const [btn, link] = [document.querySelector('button')!, document.querySelector('a')!];
    const ctx = ctxFor(btn, link);
    expect(performDomAction({ action: 'click', index: 9 }, ctx).message).toMatch(/does not exist/);
    expect(performDomAction({ action: 'click', index: 1 }, ctx).message).toMatch(/disabled/);
    link.remove();
    expect(performDomAction({ action: 'click', index: 2 }, ctx).message).toMatch(/is gone/);
  });
});

describe('performDomAction: type', () => {
  it('заменяет значение и шлёт input/change (React видит изменение через нативный сеттер)', () => {
    document.body.innerHTML = '<input value="старое">';
    const input = document.querySelector('input')!;
    // Имитация React: собственный сеттер на экземпляре перехватывает прямую запись value.
    let reactSaw = '';
    input.addEventListener('input', () => (reactSaw = input.value));
    const changes = vi.fn();
    input.addEventListener('change', changes);
    const r = performDomAction({ action: 'type', index: 1, text: 'новое', submit: false }, ctxFor(input));
    expect(r.ok).toBe(true);
    expect(input.value).toBe('новое');
    expect(reactSaw).toBe('новое');
    expect(changes).toHaveBeenCalledOnce();
  });

  it('маска поля меняет вид значения — это не ошибка ввода', () => {
    document.body.innerHTML = '<input placeholder="Телефон">';
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '');
      input.value = `+7 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`;
    });
    const r = performDomAction({ action: 'type', index: 1, text: '9991234567', submit: false }, ctxFor(input));
    expect(r.ok).toBe(true);
    expect(input.value).toBe('+7 (999) 123-45-67');
    expect(valueHasText('01.02.2024', '01022024')).toBe(true);
    expect(valueHasText('abc', 'abcdef')).toBe(false);
  });

  it('submit: Enter и отправка формы, если сайт не перехватил', () => {
    document.body.innerHTML = '<form><input name="q"></form>';
    const form = document.querySelector('form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    const keys: string[] = [];
    const input = document.querySelector('input')!;
    input.addEventListener('keydown', (e) => keys.push(e.key));
    performDomAction({ action: 'type', index: 1, text: 'ноутбук', submit: true }, ctxFor(input));
    expect(keys).toEqual(['Enter']);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Enter перехвачен сайтом — форму сами не отправляем', () => {
    document.body.innerHTML = '<form><input></form>';
    const form = document.querySelector('form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    const input = document.querySelector('input')!;
    input.addEventListener('keydown', (e) => e.preventDefault());
    performDomAction({ action: 'type', index: 1, text: 'x', submit: true }, ctxFor(input));
    expect(submitted).not.toHaveBeenCalled();
  });

  it('textarea и contenteditable', () => {
    document.body.innerHTML = '<textarea></textarea><div contenteditable="true">старое</div>';
    const [ta, div] = [document.querySelector('textarea')!, document.querySelector('div')!];
    const ctx = ctxFor(ta, div);
    performDomAction({ action: 'type', index: 1, text: 'строка', submit: false }, ctx);
    expect(ta.value).toBe('строка');
    const inputs = vi.fn();
    div.addEventListener('input', inputs);
    expect(performDomAction({ action: 'type', index: 2, text: 'новый текст', submit: false }, ctx).ok).toBe(true);
    expect(div.textContent).toBe('новый текст');
    expect(inputs).toHaveBeenCalled();
  });

  it('не печатает в checkbox, кнопку и read-only', () => {
    document.body.innerHTML = '<input type="checkbox"><button>B</button><input readonly>';
    const ctx = ctxFor(...Array.from(document.body.children));
    expect(performDomAction({ action: 'type', index: 1, text: 'x', submit: false }, ctx).message).toMatch(/checkbox/);
    expect(performDomAction({ action: 'type', index: 2, text: 'x', submit: false }, ctx).message).toMatch(/not a text field/);
    expect(performDomAction({ action: 'type', index: 3, text: 'x', submit: false }, ctx).message).toMatch(/read-only/);
  });

  it('setNativeValue работает и для select', () => {
    document.body.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
    const sel = document.querySelector('select')!;
    setNativeValue(sel, 'b');
    expect(sel.value).toBe('b');
  });
});

describe('performDomAction: select', () => {
  beforeEach(() => {
    document.body.innerHTML = '<select><option value="msk">Москва</option><option value="kzn">Казань</option><option value="spb">Санкт-Петербург</option></select>';
  });
  const sel = () => document.querySelector('select')!;

  it('по тексту, значению и частичному совпадению', () => {
    const changes = vi.fn();
    sel().addEventListener('change', changes);
    expect(performDomAction({ action: 'select', index: 1, value: ' казань ' }, ctxFor(sel()))).toEqual({ ok: true, message: 'selected "Казань"' });
    expect(sel().value).toBe('kzn');
    performDomAction({ action: 'select', index: 1, value: 'spb' }, ctxFor(sel()));
    expect(sel().value).toBe('spb');
    performDomAction({ action: 'select', index: 1, value: 'Моск' }, ctxFor(sel()));
    expect(sel().value).toBe('msk');
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('нет такого варианта — перечисляет доступные', () => {
    expect(performDomAction({ action: 'select', index: 1, value: 'Пермь' }, ctxFor(sel())).message).toMatch(/not found; available: "москва", "казань"/);
  });

  it('не select — подсказка кликнуть', () => {
    document.body.innerHTML = '<div role="combobox">Город</div>';
    expect(performDomAction({ action: 'select', index: 1, value: 'x' }, ctxFor(document.querySelector('div')!)).message).toMatch(/not a <select>/);
  });
});

describe('performDomAction: scroll', () => {
  it('крутит внутренний контейнер и сообщает, если дальше некуда', () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    let top = 0;
    Object.defineProperty(main, 'clientHeight', { value: 500 });
    Object.defineProperty(main, 'scrollTop', { get: () => top });
    main.scrollBy = ((opts: ScrollToOptions) => {
      top = Math.max(0, Math.min(800, top + (opts.top ?? 0)));
    }) as typeof main.scrollBy;
    const ctx: ActContext = { registry: [], scroller: main, win: window };
    expect(performDomAction({ action: 'scroll', direction: 'down', amount: 1 }, ctx).message).toBe('scrolled down by 400px');
    performDomAction({ action: 'scroll', direction: 'down', amount: 5 }, ctx);
    expect(performDomAction({ action: 'scroll', direction: 'down', amount: 1 }, ctx).message).toMatch(/already at the bottom/);
  });
});

describe('waitForStable', () => {
  it('ждёт тишины после изменений', async () => {
    const p = waitForStable(document, { quietMs: 30, timeoutMs: 1000 });
    setTimeout(() => document.body.append(document.createElement('div')), 5);
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.mutations).toBeGreaterThan(0);
  });

  it('не ждёт дольше таймаута при непрерывных изменениях', async () => {
    const id = setInterval(() => document.body.append(document.createElement('span')), 5);
    const r = await waitForStable(document, { quietMs: 50, timeoutMs: 120 });
    clearInterval(id);
    expect(r.timedOut).toBe(true);
  });
});

describe('performAndSettle', () => {
  const fast = { quietMs: 20, timeoutMs: 500 };

  it('клик, который ничего не изменил, — явный сигнал модели', async () => {
    document.body.innerHTML = '<button>Оценить</button>';
    const r = await performAndSettle({ action: 'click', index: 1 }, ctxFor(document.querySelector('button')!), fast);
    expect(r).toEqual({ ok: true, message: `clicked, ${NO_EFFECT_NOTE}` });
  });

  it('синхронное изменение DOM в обработчике клика замечается', async () => {
    document.body.innerHTML = '<button>Меню</button>';
    const btn = document.querySelector('button')!;
    btn.addEventListener('click', () => btn.after(document.createElement('ul')));
    const r = await performAndSettle({ action: 'click', index: 1 }, ctxFor(btn), fast);
    expect(r).toEqual({ ok: true, message: 'clicked' });
  });

  it('ошибки и не-клики проходят без пометки', async () => {
    document.body.innerHTML = '<input>';
    const input = document.querySelector('input')!;
    expect((await performAndSettle({ action: 'type', index: 1, text: 'x', submit: false }, ctxFor(input), fast)).message).toBe('typed');
    expect((await performAndSettle({ action: 'click', index: 5 }, ctxFor(input), fast)).ok).toBe(false);
  });
});

describe('клик по представленному через label переключателю', () => {
  it('выбирает спрятанный radio', async () => {
    const { collectSnapshot } = await import('@/lib/dom/collect');
    document.body.innerHTML = '<label><input type="radio" name="q" style="display:none"><span>Вариант</span></label>';
    const geom = {
      style: (el: Element) => ({ display: (el as HTMLElement).style?.display || 'block', cursor: 'auto', overflowY: 'visible' }),
      isVisible: (el: Element) => (el as HTMLElement).style?.display !== 'none',
      rect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
      frameContentBox: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      hitTest: () => document.querySelector('span'),
      viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 }),
      scrollBox: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 }),
    };
    const { registry } = collectSnapshot(document, geom);
    expect(registry).toHaveLength(1);
    performDomAction({ action: 'click', index: 1 }, { registry, scroller: null, win: window });
    expect(document.querySelector('input')!.checked).toBe(true);
  });
});

describe('findClickPoint', () => {
  // Геометрия: цель 100×40 в (100,100); hitTest отдаёт то, что лежит в точке по карте.
  function geomWith(hitAt: (x: number, y: number) => Element | null): Geometry {
    return {
      style: () => ({ display: 'block', cursor: 'auto', overflowY: 'visible' }),
      isVisible: () => true,
      rect: () => ({ x: 100, y: 100, width: 100, height: 40 }),
      frameContentBox: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      hitTest: (_root, x, y) => hitAt(x, y),
      viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 800 }),
      scrollBox: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0 }),
    };
  }
  const entry = (el: Element) => ({ index: 7, element: el, target: el, frames: [] });

  it('центр, если он свободен', () => {
    document.body.innerHTML = '<button>OK</button>';
    const btn = document.querySelector('button')!;
    expect(findClickPoint(entry(btn), geomWith(() => btn))).toEqual({ ok: true, x: 150, y: 120 });
  });

  it('центр закрыт всплывашкой — берёт свободную четверть', () => {
    document.body.innerHTML = '<button>OK</button><div class="toast">Скопировано</div>';
    const btn = document.querySelector('button')!;
    const toast = document.querySelector('.toast')!;
    const p = findClickPoint(entry(btn), geomWith((x) => (x > 140 ? toast : btn)));
    expect(p).toEqual({ ok: true, x: 125, y: 120 });
  });

  it('закрыт полностью — называет перекрывающий элемент', () => {
    document.body.innerHTML = '<button>OK</button><div class="modal">Окно</div>';
    const btn = document.querySelector('button')!;
    const modal = document.querySelector('.modal')!;
    const p = findClickPoint(entry(btn), geomWith(() => modal));
    expect(p).toEqual({ ok: false, message: 'element [7] is covered by div.modal "Окно"' });
  });

  it('отключённый и исчезнувший элементы', () => {
    document.body.innerHTML = '<button disabled>X</button><a>Y</a>';
    const btn = document.querySelector('button')!;
    const link = document.querySelector('a')!;
    expect(findClickPoint(entry(btn), geomWith(() => btn))).toMatchObject({ ok: false, message: expect.stringMatching(/disabled/) });
    link.remove();
    expect(findClickPoint(entry(link), geomWith(() => null))).toMatchObject({ ok: false, message: expect.stringMatching(/gone/) });
  });
});

describe('selectFieldContent и readFieldValue', () => {
  it('выделяют и читают input, textarea и contenteditable', () => {
    document.body.innerHTML = '<input value="старое"><div contenteditable="true">код</div><button>B</button>';
    const [input, div, btn] = [document.querySelector('input')!, document.querySelector('div')!, document.querySelector('button')!];
    selectFieldContent(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('старое'.length);
    selectFieldContent(div);
    expect(document.getSelection()?.toString()).toBe('код');
    expect(readFieldValue(input)).toBe('старое');
    expect(readFieldValue(div)).toBe('код');
    expect(readFieldValue(btn)).toBeNull();
  });
});

describe('редактор кода без CDP', () => {
  it('ввод DOM-событиями честно отказывает, чтение кода работает', () => {
    document.body.innerHTML = '<div class="CodeMirror"><div class="CodeMirror-lines"><pre class="CodeMirror-line">&lt;p&gt;</pre><pre class="CodeMirror-line">text</pre></div></div>';
    const editor = document.querySelector('.CodeMirror')!;
    const r = performDomAction({ action: 'type', index: 1, text: '<p>x</p>', submit: false }, ctxFor(editor));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/real keyboard input/);
    expect(readFieldValue(editor)).toBe('<p>\ntext');
  });
});


describe('новые действия без CDP', () => {
  it('hover: события наведения открывают меню', () => {
    document.body.innerHTML = '<button>Меню</button><ul hidden>пункты</ul>';
    const button = document.querySelector('button')!;
    const seen: string[] = [];
    for (const t of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) button.addEventListener(t, () => seen.push(t));
    expect(performDomAction({ action: 'hover', index: 1 }, ctxFor(button))).toMatchObject({ ok: true, message: 'hovered' });
    expect(seen).toEqual(['pointerover', 'mouseover', 'mouseenter', 'mousemove']);
  });

  it('press_key: клавиша уходит в элемент с фокусом, Tab переносит фокус', () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    const a = document.querySelector<HTMLInputElement>('#a')!;
    a.focus();
    const keys: string[] = [];
    a.addEventListener('keydown', (e) => keys.push(e.key));
    performDomAction({ action: 'press_key', key: 'Escape' }, ctxFor());
    expect(keys).toEqual(['Escape']);
    performDomAction({ action: 'press_key', key: 'Tab' }, ctxFor());
    expect(document.activeElement?.id).toBe('b');
    performDomAction({ action: 'press_key', key: 'Shift+Tab' }, ctxFor());
    expect(document.activeElement?.id).toBe('a');
  });

  it('drag без CDP — понятный отказ', () => {
    document.body.innerHTML = '<div>a</div><div>b</div>';
    const [a, b] = Array.from(document.querySelectorAll('div'));
    expect(performDomAction({ action: 'drag', index: 1, to_index: 2 }, ctxFor(a!, b!)).message).toMatch(/CDP/);
  });

  it('scroll с index прокручивает область элемента, а не страницу', () => {
    document.body.innerHTML = '<div id="box" style="overflow-y: auto; height: 100px"><p>строка</p></div>';
    const box = document.querySelector<HTMLElement>('#box')!;
    Object.defineProperty(box, 'scrollHeight', { value: 1000 });
    Object.defineProperty(box, 'clientHeight', { value: 100 });
    box.scrollBy = ((opts: ScrollToOptions) => (box.scrollTop += opts.top ?? 0)) as typeof box.scrollBy;
    const p = box.querySelector('p')!;
    const r = performDomAction({ action: 'scroll', direction: 'down', amount: 1, index: 1 }, ctxFor(p));
    expect(r.message).toMatch(/scrolled the area down by 80px/);
    expect(scrollableAncestor(p)).toBe(box);
  });

  it('wait_for: ждёт появления текста и сдаётся по таймауту', async () => {
    document.body.innerHTML = '<p>Загрузка…</p>';
    setTimeout(() => (document.body.innerHTML += '<p>Заказ   ГОТОВ</p>'), 50);
    expect(await waitForText(document, 'заказ готов', 2000, 10)).toMatchObject({ ok: true });
    expect(await waitForText(document, 'нет такого', 50, 10)).toMatchObject({ ok: false });
  });
});

describe('scrollInfo — куда навести мышь для прокрутки колесом', () => {
  function geom(rects: Map<Element, { x: number; y: number; width: number; height: number }>): Geometry {
    return {
      rect: (el: Element) => rects.get(el) ?? { x: 0, y: 0, width: 0, height: 0 },
      viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 3000 }),
      hitTest: () => document.querySelector('p') ?? document.body,
    } as unknown as Geometry;
  }

  it('без номера и без внутренней области — центр окна, высота экрана и позиция окна', () => {
    const r = scrollInfo(undefined, ctxFor(), geom(new Map()));
    expect(r).toMatchObject({ ok: true, x: 500, y: 400, page: window.innerHeight, top: window.scrollY });
  });

  it('с внутренним scroller — центр его видимой части и его высота', () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    Object.defineProperty(main, 'clientHeight', { value: 600 });
    Object.defineProperty(main, 'scrollTop', { value: 120, writable: true });
    const ctx: ActContext = { registry: [], scroller: main, win: window };
    const r = scrollInfo(undefined, ctx, geom(new Map([[main, { x: 200, y: 100, width: 600, height: 1500 }]])));
    expect(r).toMatchObject({ ok: true, x: 500, y: 450, page: 600, top: 120 + window.scrollY });
  });

  it('с номером элемента внутри прокручиваемого блока — наводим на блок', () => {
    document.body.innerHTML = '<div id="list" style="overflow-y:auto"><p>x</p></div>';
    const list = document.querySelector('#list')!;
    const p = document.querySelector('p')!;
    Object.defineProperty(list, 'scrollHeight', { value: 2000 });
    Object.defineProperty(list, 'clientHeight', { value: 300 });
    const r = scrollInfo(1, ctxFor(p), geom(new Map([[list, { x: 0, y: 0, width: 400, height: 300 }]])));
    expect(r).toMatchObject({ ok: true, x: 200, y: 150, page: 300 });
  });

  it('несуществующий номер — понятная ошибка', () => {
    expect(scrollInfo(9, ctxFor(), geom(new Map()))).toMatchObject({ ok: false, message: expect.stringMatching(/does not exist/) });
  });
});

describe('scrollInfo — точка для колеса', () => {
  function geomHit(hit: (x: number, y: number) => Element | null): Geometry {
    return {
      rect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      viewport: () => ({ width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 3000 }),
      hitTest: (_root: unknown, x: number, y: number) => hit(x, y),
    } as unknown as Geometry;
  }
  const scrollable = (el: HTMLElement) => {
    el.style.overflowY = 'auto';
    Object.defineProperty(el, 'scrollHeight', { value: 2000 });
    Object.defineProperty(el, 'clientHeight', { value: 200 });
  };

  it('в центре вложенный блок с прокруткой (код) — колесо ставим в другое место страницы', () => {
    document.body.innerHTML = '<p id="text">текст</p><div id="code"><pre>код</pre></div>';
    const code = document.querySelector<HTMLElement>('#code')!;
    scrollable(code);
    const text = document.querySelector('#text')!;
    const r = scrollInfo(undefined, ctxFor(), geomHit((x, y) => (x === 500 && y === 400 ? code.firstElementChild : text)));
    expect(r).toMatchObject({ ok: true, wheel: true });
    if (r.ok) expect([r.x, r.y]).not.toEqual([500, 400]);
  });

  it('везде фреймы и карты — колесо небезопасно, будет прямая прокрутка', () => {
    document.body.innerHTML = '<iframe></iframe><div class="leaflet-container"><span>карта</span></div>';
    const frame = document.querySelector('iframe')!;
    const map = document.querySelector('span')!;
    const r = scrollInfo(undefined, ctxFor(), geomHit((x) => (x < 500 ? frame : map)));
    expect(r).toMatchObject({ ok: true, wheel: false, x: 500, y: 400 });
  });

  it('обычная страница — центр, колесо можно', () => {
    document.body.innerHTML = '<p>текст</p>';
    const p = document.querySelector('p')!;
    expect(scrollInfo(undefined, ctxFor(), geomHit(() => p))).toMatchObject({ ok: true, wheel: true, x: 500, y: 400 });
  });
});

