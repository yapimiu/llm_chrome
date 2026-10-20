// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectSnapshot, type CollectOptions } from '@/lib/dom/collect';
import type { Geometry } from '@/lib/dom/geometry';
import { serializePage } from '@/lib/dom/serialize';
import type { Rect } from '@/lib/dom/types';

/**
 * В jsdom нет вёрстки, поэтому геометрию задаём атрибутами:
 *  data-rect="x y w h" — прямоугольник (без него элемент считается коробкой 0 0 100 20);
 *  hidden / style="display:none" / data-invisible — невидим;
 *  style="cursor:pointer" — курсор (наследуется, как в CSS).
 * hitTest возвращает последний в порядке документа видимый элемент с data-rect, содержащий точку.
 */
/** Как в браузере по умолчанию: эти теги строчные. */
const INLINE_TAGS = new Set(['span', 'a', 'b', 'i', 'em', 'strong', 'code', 'label', 'img', 'small']);

function fakeGeometry(viewport = { width: 1000, height: 800 }, scrollY = 0, scrollHeight = 3000): Geometry {
  const parseRect = (el: Element): Rect => {
    const raw = el.getAttribute('data-rect');
    if (!raw) return { x: 0, y: 0, width: 100, height: 20 };
    const [x = 0, y = 0, width = 0, height = 0] = raw.split(/\s+/).map(Number);
    return { x, y, width, height };
  };
  const ownStyle = (el: Element) => (el as HTMLElement).style ?? { display: '', cursor: '' };
  const cursorOf = (el: Element | null): string => {
    for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
      const c = ownStyle(n).cursor;
      if (c) return c;
    }
    return 'auto';
  };
  const isVisible = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
      if (n.hasAttribute('hidden') || n.hasAttribute('data-invisible') || ownStyle(n).display === 'none') return false;
    }
    return true;
  };
  return {
    style: (el) => ({
      display: ownStyle(el).display || (INLINE_TAGS.has(el.localName) ? 'inline' : 'block'),
      cursor: cursorOf(el),
      overflowY: (el as HTMLElement).style?.overflowY || 'visible',
      position: (el as HTMLElement).style?.position || 'static',
    }),
    // data-scroll="scrollTop scrollHeight clientHeight clientWidth"
    scrollBox(el) {
      const [scrollTop = 0, scrollHeight = 0, clientHeight = 0, clientWidth = 0] = (el.getAttribute('data-scroll') ?? '').split(/\s+/).map(Number);
      return { scrollTop, scrollHeight, clientHeight, clientWidth };
    },
    isVisible,
    rect: parseRect,
    frameContentBox: parseRect,
    hitTest(root, x, y) {
      const all = Array.from(root.querySelectorAll('[data-rect]')).reverse();
      return (
        all.find((el) => {
          if (!isVisible(el)) return false;
          const r = parseRect(el);
          return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
        }) ?? null
      );
    },
    viewport: () => ({ ...viewport, scrollX: 0, scrollY, scrollHeight }),
  };
}

function collect(html: string, opts?: CollectOptions, geom = fakeGeometry()) {
  document.body.innerHTML = html;
  return collectSnapshot(document, geom, opts);
}

const line = (html: string, opts?: CollectOptions) => {
  const { snapshot } = collect(html, opts);
  return serializePage(snapshot, { maxChars: 10000 }).text;
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Тест';
});

describe('collectSnapshot: какие элементы считаются интерактивными', () => {
  it('стандартные контролы и формат из ТЗ', () => {
    const text = line(`
      <button data-rect="10 10 80 30">Войти</button>
      <input type="email" placeholder="Email" data-rect="10 50 200 30">
      <a href="/about" data-rect="10 90 80 20">О нас</a>
      <textarea placeholder="Комментарий" data-rect="10 120 200 60">привет</textarea>
    `);
    expect(text).toContain('[1] button "Войти"');
    expect(text).toContain('[2] input[type=email] placeholder="Email" value=""');
    expect(text).toContain('[3] a "О нас" href="/about"');
    expect(text).toContain('[4] textarea placeholder="Комментарий" value="привет"');
  });

  it('role, onclick, tabindex, contenteditable и cursor:pointer', () => {
    const { snapshot } = collect(`
      <div role="button" data-rect="0 0 50 20">Роль</div>
      <span onclick="void 0" data-rect="0 30 50 20">Онклик</span>
      <div tabindex="0" data-rect="0 60 50 20">Таб</div>
      <div tabindex="-1" data-rect="0 90 50 20">Не таб</div>
      <div contenteditable="true" aria-label="Письмо" data-rect="0 120 300 100"><p>Текст <b>письма</b></p></div>
      <div style="cursor:pointer" data-rect="0 240 100 20"><span>Карточка</span></div>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Роль', 'Онклик', 'Таб', 'Письмо', 'Карточка']);
    const editable = snapshot.elements[3]!;
    expect(editable.contentEditable).toBe(true);
    expect(editable.attrs).toEqual([['value', 'Текст письма']]);
  });

  it('не дублирует вложенные кликабельные элементы, но сохраняет контролы внутри', () => {
    const { snapshot } = collect(`
      <a href="/x" data-rect="0 0 300 100">
        <span style="cursor:pointer" data-rect="0 0 50 20">Иконка</span>
        <button data-rect="60 0 50 20">Внутри</button>
        <input type="checkbox" aria-label="Выбрать" data-rect="120 0 20 20">
      </a>
    `);
    expect(snapshot.elements.map((e) => e.tag)).toEqual(['a', 'input']);
  });

  it('сохраняет настоящую кнопку внутри кликабельной карточки (cursor:pointer)', () => {
    const { snapshot } = collect(`
      <div class="card" style="cursor:pointer" data-rect="0 0 500 200">
        <span data-rect="10 10 200 20">Заголовок карточки</span>
        <span style="cursor:pointer" data-rect="10 40 50 20">Иконка</span>
        <button data-rect="200 120 150 50">Пора поверстать</button>
        <a href="/more" data-rect="10 120 80 20">Подробнее</a>
      </div>
    `);
    expect(snapshot.elements.map((e) => [e.tag, e.name])).toEqual([
      ['div', 'Заголовок карточки Иконка'],
      ['button', 'Пора поверстать'],
      ['a', 'Подробнее'],
    ]);
  });

  it('не считает кнопкой гигантскую обёртку с cursor:pointer, но находит кнопки внутри', () => {
    const { snapshot } = collect(`
      <div style="cursor:pointer" data-rect="0 0 1000 800">
        <p data-rect="0 0 500 40">Текст урока</p>
        <div style="cursor:pointer" data-rect="0 100 900 700"><button data-rect="10 500 100 30">Далее</button></div>
      </div>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Далее']);
    expect(snapshot.text).toContain('Текст урока');
  });

  it('пропускает скрытые input и невидимые элементы', () => {
    const { snapshot } = collect(`
      <input type="hidden" name="csrf" value="x">
      <button hidden>Скрыта</button>
      <div style="display:none"><button>Внутри скрытого</button></div>
      <button data-invisible data-rect="0 0 10 10">Прозрачная</button>
      <button data-rect="0 0 0 0">Нулевая</button>
      <button data-rect="0 50 50 20">Видимая</button>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Видимая']);
    expect(snapshot.stats.hidden).toBeGreaterThanOrEqual(3);
  });

  it('игнорирует свои служебные элементы', () => {
    const { snapshot } = collect(
      `<div id="own"><button data-rect="0 0 10 10">Служебная</button></div><button data-rect="0 20 10 10">Страница</button>`,
      { ignore: (el) => el.id === 'own' },
    );
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Страница']);
  });
});

describe('collectSnapshot: имена и атрибуты', () => {
  it('label, aria-labelledby, title, alt картинки', () => {
    const { snapshot } = collect(`
      <label for="login">Логин</label><input id="login" data-rect="0 0 100 20">
      <label data-rect="0 30 200 20">Пароль <input type="password" value="secret" data-rect="60 30 100 20"></label>
      <span id="lbl">Поиск по сайту</span><input type="search" aria-labelledby="lbl" data-rect="0 60 100 20">
      <button title="Закрыть" data-rect="0 90 20 20"></button>
      <button data-rect="0 120 20 20"><img alt="Корзина" src="x.png"></button>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Логин', 'Пароль', 'Поиск по сайту', 'Закрыть', 'Корзина']);
  });

  it('маскирует пароли и номера карт', () => {
    const text = line(`
      <input type="password" aria-label="Пароль" value="hunter2" data-rect="0 0 100 20">
      <input autocomplete="cc-number" aria-label="Карта" value="4111111111111111" data-rect="0 30 100 20">
      <input type="password" aria-label="Пустой" data-rect="0 60 100 20">
    `);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4111');
    expect(text).toContain('[1] input[type=password] "Пароль" value="•••"');
    expect(text).toContain('[3] input[type=password] "Пустой" value=""');
  });

  it('select: выбранное значение и варианты', () => {
    const { snapshot } = collect(`
      <select aria-label="Город" data-rect="0 0 100 20">
        <option>Москва</option><option selected>Казань</option><option>Пермь</option>
      </select>
    `);
    const sel = snapshot.elements[0]!;
    expect(sel.attrs).toEqual([['value', 'Казань']]);
    expect(sel.options).toEqual(['Москва', 'Казань', 'Пермь']);
  });

  it('состояния checkbox, disabled и aria-expanded', () => {
    const text = line(`
      <input type="checkbox" checked aria-label="Запомнить" data-rect="0 0 20 20">
      <button disabled data-rect="0 30 50 20">Отправить</button>
      <button aria-expanded="false" data-rect="0 60 50 20">Меню</button>
    `);
    expect(text).toContain('[1] input[type=checkbox] "Запомнить" checked');
    expect(text).toContain('[2] button "Отправить" disabled');
    expect(text).toContain('[3] button "Меню" collapsed');
  });

  it('href: свой origin — путь, чужой — хост; javascript: и # опускаются', () => {
    const { snapshot } = collect(`
      <a href="/catalog?page=2" data-rect="0 0 50 20">Каталог</a>
      <a href="https://other.org/path" data-rect="0 30 50 20">Внешняя</a>
      <a href="javascript:void(0)" data-rect="0 60 50 20">JS</a>
      <a href="#" data-rect="0 90 50 20">Решётка</a>
    `);
    expect(snapshot.elements.map((e) => e.attrs)).toEqual([[['href', '/catalog?page=2']], [['href', 'other.org/path']], [], []]);
  });

  it('декодирует percent-encoding в href', () => {
    const { snapshot } = collect(`<a href="/wiki/%D0%9F%D0%BE%D0%B8%D1%81%D0%BA" data-rect="0 0 50 20">Поиск</a>`);
    expect(snapshot.elements[0]!.attrs).toEqual([['href', '/wiki/Поиск']]);
  });

  it('безымянной иконке даёт hint из id/class', () => {
    const { snapshot } = collect(`<button class="x icon-close" data-rect="0 0 20 20"></button>`);
    expect(snapshot.elements[0]!.attrs).toEqual([['hint', 'icon-close']]);
  });
});

describe('collectSnapshot: геометрия', () => {
  it('зоны выше/на экране/ниже и дистанция', () => {
    const { snapshot } = collect(`
      <button data-rect="0 -300 50 20">Сверху</button>
      <button data-rect="0 100 50 20">Экран</button>
      <button data-rect="0 1000 50 20">Снизу</button>
    `);
    expect(snapshot.elements.map((e) => [e.name, e.zone, e.distance])).toEqual([
      ['Сверху', 'above', 280],
      ['Экран', 'visible', 0],
      ['Снизу', 'below', 200],
    ]);
  });

  it('перекрытые модалкой элементы отбрасываются', () => {
    const { snapshot } = collect(`
      <button data-rect="10 10 50 20">Под модалкой</button>
      <div class="backdrop" data-rect="0 0 1000 800">
        <div role="dialog" data-rect="300 200 400 300"><button data-rect="320 220 80 30">OK</button></div>
      </div>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['OK']);
    expect(snapshot.stats.covered).toBe(1);
  });

  it('элементы за пределами экрана по горизонтали (карусель) отбрасываются', () => {
    const { snapshot } = collect(`<button data-rect="1200 100 50 20">Слайд 2</button>`);
    expect(snapshot.elements).toHaveLength(0);
    expect(snapshot.stats.offscreen).toBe(1);
  });

  it('спрятанный checkbox кликается через видимый label', () => {
    const { snapshot, registry } = collect(`
      <input type="checkbox" id="agree" data-invisible data-rect="0 0 1 1">
      <label for="agree" data-rect="0 0 200 20">Согласен с условиями</label>
    `);
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]!.name).toBe('Согласен с условиями');
    expect(registry[0]!.target.localName).toBe('label');
    expect(registry[0]!.element.localName).toBe('input');
  });

  it('прокрутка попадает в снимок', () => {
    const { snapshot } = collect('<p>текст</p>', undefined, fakeGeometry({ width: 1000, height: 800 }, 600, 3000));
    expect(snapshot.scroll).toEqual({ x: 0, y: 600, maxY: 2200, viewportWidth: 1000, viewportHeight: 800 });
  });
});

describe('collectSnapshot: shadow DOM и iframe', () => {
  it('заходит в открытый shadow root', () => {
    document.body.innerHTML = '<my-widget data-rect="0 0 300 100"></my-widget>';
    const host = document.querySelector('my-widget')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button data-rect="10 10 80 20">В тени</button>';
    const { snapshot } = collectSnapshot(document, fakeGeometry());
    expect(snapshot.elements.map((e) => [e.name, e.inShadow])).toEqual([['В тени', true]]);
  });

  it('заходит в iframe того же origin и сдвигает координаты', () => {
    document.body.innerHTML = '<iframe data-rect="100 200 400 300"></iframe>';
    const frame = document.querySelector('iframe')!;
    const fdoc = frame.contentDocument!;
    fdoc.body.innerHTML = '<button data-rect="10 20 50 20">Во фрейме</button><button data-rect="10 500 50 20">Ниже фрейма</button>';
    const { snapshot, registry } = collectSnapshot(document, fakeGeometry());
    const [inside, below] = snapshot.elements;
    expect(inside).toMatchObject({ name: 'Во фрейме', zone: 'visible', inFrame: true, rect: { x: 110, y: 220, width: 50, height: 20 } });
    // y=700 в координатах страницы ещё в пределах окна, но за нижней границей iframe (500) — нужна прокрутка.
    expect(below).toMatchObject({ name: 'Ниже фрейма', zone: 'below' });
    expect(registry[0]!.frames).toEqual([frame]);
  });
});

describe('collectSnapshot: текст страницы', () => {
  it('собирает видимый текст вне интерактивных элементов, без скрытого и без скриптов', () => {
    const { snapshot } = collect(`
      <h1 data-rect="0 0 500 40">Заголовок</h1>
      <p data-rect="0 50 500 40">Абзац   с    пробелами</p>
      <p hidden>Скрытый</p>
      <script>var secret = 1;</script>
      <button data-rect="0 100 50 20">Кнопка</button>
      <p data-rect="0 2000 500 40">Далеко внизу</p>
    `);
    expect(snapshot.text).toBe('Заголовок\nАбзац с пробелами');
  });

  it('уважает лимит символов текста', () => {
    const { snapshot } = collect(`<p data-rect="0 0 500 40">${'слово '.repeat(1000)}</p>`, { maxTextChars: 100 });
    expect(snapshot.text.length).toBeLessThanOrEqual(100);
  });
});

describe('collectSnapshot: лимит обхода', () => {
  it('останавливается на maxNodes', () => {
    const { snapshot } = collect('<div></div>'.repeat(200), { maxNodes: 50 });
    expect(snapshot.stats.walkTruncated).toBe(true);
    expect(snapshot.stats.nodesVisited).toBeLessThanOrEqual(51);
  });
});

describe('collectSnapshot: случаи с реальных сайтов (Яндекс Практикум)', () => {
  it('SPA прокручивает внутренний контейнер, а не окно', () => {
    const geom = fakeGeometry({ width: 1000, height: 800 }, 0, 800);
    document.body.innerHTML = `
      <header data-rect="0 0 1000 60"><button data-rect="10 10 80 30">Меню</button></header>
      <main style="overflow-y:auto" data-scroll="600 5000 740 1000" data-rect="0 60 1000 740">
        <button data-rect="10 -200 80 30">Выше</button>
      </main>
      <ul style="overflow-y:auto" data-scroll="0 900 100 200"></ul>
    `;
    const { snapshot, scroller } = collectSnapshot(document, geom);
    expect(scroller?.localName).toBe('main');
    expect(snapshot.scroll).toEqual({ x: 0, y: 600, maxY: 4260, viewportWidth: 1000, viewportHeight: 800, container: true });
    expect(serializePage(snapshot, { maxChars: 5000 }).text).toContain('Scroll: y=600 of 4260 (14%) in the main scrollable area');
  });

  it('маленький прокручиваемый список не считается главным контейнером', () => {
    const { scroller, snapshot } = collect(
      '<ul style="overflow-y:auto" data-scroll="0 900 100 200" data-rect="0 0 200 100"></ul>',
      undefined,
      fakeGeometry({ width: 1000, height: 800 }, 0, 800),
    );
    expect(scroller).toBeNull();
    expect(snapshot.scroll.container).toBeUndefined();
  });

  it('безымянные tooltip-обёртки вокруг кнопок убираются, номера сплошные', () => {
    const { snapshot, registry } = collect(`
      <span class="prisma-tooltip2__wrapper" style="cursor:pointer" data-rect="0 0 40 40"><button aria-label="Поиск" data-rect="0 0 40 40"></button></span>
      <span class="prisma-tooltip2__wrapper" style="cursor:pointer" data-rect="50 0 40 40"><button aria-label="Заметки" data-rect="50 0 40 40"></button></span>
      <span class="icon-only" style="cursor:pointer" data-rect="100 0 20 20"></span>
    `);
    expect(snapshot.elements.map((e) => [e.index, e.tag, e.name])).toEqual([
      [1, 'button', 'Поиск'],
      [2, 'button', 'Заметки'],
      [3, 'span', ''],
    ]);
    expect(registry.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('слово-элемент внутри фразы остаётся в тексте', () => {
    const { snapshot } = collect(`
      <p data-rect="0 0 800 40">Мы можем указать ещё один атрибут — <code tabindex="0" data-rect="300 0 50 20">target</code>. Он «нацеливает» браузер.</p>
      <p data-rect="0 50 800 40">Пишите <code tabindex="0" data-rect="60 50 40 20">href</code>, <code tabindex="0" data-rect="110 50 40 20">target</code> через пробел.</p>
    `);
    expect(snapshot.text).toBe('Мы можем указать ещё один атрибут — target. Он «нацеливает» браузер.\nПишите href, target через пробел.');
    // Кликабельный код (подсказки, копирование) — содержимое, а не кнопки.
    expect(snapshot.elements).toEqual([]);
  });

  it('блок только из ссылок (меню) не дублируется в тексте', () => {
    const { snapshot } = collect(`
      <ul data-rect="0 0 300 100"><li data-rect="0 0 300 20"><a href="/a" data-rect="0 0 50 20">Раз</a></li><li data-rect="0 30 300 20"><a href="/b" data-rect="0 30 50 20">Два</a></li></ul>
      <p data-rect="0 200 300 20">Обычный абзац</p>
    `);
    expect(snapshot.text).toBe('Обычный абзац');
  });

  it('подсветка синтаксиса не добавляет пробелов в имя', () => {
    const { snapshot } = collect(
      '<div style="cursor:pointer" data-rect="0 0 600 40"><span>&lt;</span><span>a</span> <span>href</span>=<span>"x"</span><span>&gt;</span>Сайт<span>&lt;/a&gt;</span></div>',
    );
    expect(snapshot.elements[0]!.name).toBe('<a href="x">Сайт</a>');
  });
});

describe('collectSnapshot: варианты ответа в тестах (Практикум)', () => {
  it('безымянный кружок-радио получает подпись из своей строки', () => {
    const option = (y: number, code: string) => `
      <div class="option" data-rect="0 ${y} 800 100">
        <label class="radio" data-rect="10 ${y + 30} 30 30"><input type="radio" name="q" data-invisible data-rect="0 0 1 1"><span class="circle"></span></label>
        <div class="code" data-rect="60 ${y} 700 100"><div>HTML</div><pre data-rect="60 ${y + 40} 700 30">${code}</pre></div>
      </div>`;
    const { snapshot, registry } = collect(
      option(0, '&lt;p&gt;&lt;a href="x"&gt;&lt;/p&gt;&lt;/a&gt;') + option(120, '&lt;/p&gt;&lt;/h1&gt;') + option(240, '&lt;p&gt;&lt;a&gt;Афиша&lt;/a&gt;&lt;/p&gt;'),
    );
    expect(snapshot.elements.map((e) => [e.tag, e.type, e.name])).toEqual([
      ['input', 'radio', 'HTML <p><a href="x"></p></a>'],
      ['input', 'radio', 'HTML </p></h1>'],
      ['input', 'radio', 'HTML <p><a>Афиша</a></p>'],
    ]);
    expect(registry[0]!.target.localName).toBe('label');
  });

  it('не берёт подпись из контейнера, где есть другие поля ввода', () => {
    const { snapshot } = collect(`
      <div data-rect="0 0 500 100">
        <input type="radio" name="a" data-rect="0 0 20 20"><input type="radio" name="a" data-rect="30 0 20 20">
        <span>Общий текст группы</span>
      </div>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['', '']);
  });

  it('подписанный checkbox не трогается', () => {
    const { snapshot } = collect('<div data-rect="0 0 500 40"><label data-rect="0 0 200 20"><input type="checkbox" data-rect="0 0 20 20"> Запомнить</label> Подсказка</div>');
    expect(snapshot.elements[0]!.name).toBe('Запомнить');
  });
});

describe('collectSnapshot: label со спрятанным переключателем', () => {
  const option = (y: number, code: string, checked = false) => `
    <label class="option" style="cursor:pointer" data-rect="0 ${y} 800 100">
      <input type="radio" name="q" style="display:none"${checked ? ' checked' : ''}>
      <span class="circle" data-rect="10 ${y + 30} 30 30"></span>
      <div class="code" data-rect="60 ${y} 700 100"><div>HTML</div><pre data-rect="60 ${y + 40} 700 30">${code}</pre></div>
    </label>`;

  it('показывается как input[type=radio] с состоянием, без дублей; кликается label', () => {
    const { snapshot, registry } = collect(option(0, '&lt;/p&gt;') + option(120, '&lt;p&gt;&lt;a&gt;&lt;/a&gt;&lt;/p&gt;', true));
    expect(snapshot.elements.map((e) => [e.tag, e.type, e.name, e.states])).toEqual([
      ['input', 'radio', 'HTML </p>', []],
      ['input', 'radio', 'HTML <p><a></a></p>', ['checked']],
    ]);
    expect(registry.map((r) => [r.element.localName, r.target.localName])).toEqual([
      ['input', 'label'],
      ['input', 'label'],
    ]);
    const text = serializePage(snapshot, { maxChars: 5000 }).text;
    expect(text).toContain('[2] input[type=radio] "HTML <p><a></a></p>" checked');
  });

  it('label через for= после визуально спрятанного input — один элемент', () => {
    const { snapshot } = collect(`
      <input type="checkbox" id="agree" data-invisible data-rect="0 0 1 1">
      <label for="agree" style="cursor:pointer" data-rect="0 0 200 20">Согласен с условиями</label>
    `);
    expect(snapshot.elements.map((e) => [e.tag, e.type, e.name])).toEqual([['input', 'checkbox', 'Согласен с условиями']]);
  });

  it('спрятанный input[type=file] за кнопкой-label', () => {
    const { snapshot } = collect('<label style="cursor:pointer" data-rect="0 0 200 40">Загрузить фото<input type="file" style="display:none"></label>');
    expect(snapshot.elements.map((e) => [e.tag, e.type, e.name])).toEqual([['input', 'file', 'Загрузить фото']]);
  });

  it('обычный видимый checkbox внутри label не превращается', () => {
    const { snapshot } = collect('<label data-rect="0 0 200 20"><input type="checkbox" data-rect="0 0 20 20"> Запомнить</label>');
    expect(snapshot.elements.map((e) => [e.tag, e.type])).toEqual([['input', 'checkbox']]);
  });
});

describe('collectSnapshot: кликабельные блоки кода', () => {
  it('блок кода с копированием по клику — текст, а не кнопка; кнопка «Скопировать» остаётся', () => {
    const { snapshot } = collect(`
      <div class="code" style="cursor:pointer" data-rect="0 0 600 120">
        <button data-rect="500 0 100 20">Скопировать код</button>
        <pre data-rect="0 30 600 60">&lt;a href=""&gt;&lt;/a&gt;</pre>
      </div>
      <button data-rect="0 200 300 40">В плейлисте тоже будет картинка?</button>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Скопировать код', 'В плейлисте тоже будет картинка?']);
    expect(snapshot.text).toContain('<a href=""></a>');
  });
});

describe('collectSnapshot: прокручиваемые области с tabindex (Практикум)', () => {
  it('scroll-контейнер с tabindex=0 — не кнопка, кнопки внутри видны', () => {
    const { snapshot } = collect(`
      <div class="scrollable__content-container" tabindex="0" style="overflow-y:scroll" data-rect="0 0 600 700">
        <p data-rect="0 0 500 40">Текст урока</p>
        <div class="scrollable__content-container" tabindex="0" style="overflow-y:scroll" data-rect="0 60 400 120">
          <pre data-rect="0 60 400 100">&lt;img src=""&gt;</pre>
        </div>
        <button data-rect="0 300 300 40">В плейлисте тоже будет картинка?</button>
      </div>
    `);
    expect(snapshot.elements.map((e) => e.name)).toEqual(['В плейлисте тоже будет картинка?']);
    expect(snapshot.text).toContain('Текст урока');
    expect(snapshot.text).toContain('<img src="">');
  });

  it('обычный tabindex=0 без прокрутки по-прежнему кликабелен', () => {
    const { snapshot } = collect('<div tabindex="0" data-rect="0 0 100 20">Карточка</div>');
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Карточка']);
  });
});

describe('collectSnapshot: безымянные элементы только с tabindex', () => {
  it('сегменты прогресса с подсказкой по фокусу убираются, кнопки остаются', () => {
    const seg = (x: number) => `<span class="prisma-tooltip2__wrapper" tabindex="0" data-rect="${x} 0 20 12"><div class="composed-progress-bar__part" data-rect="${x} 0 20 12"></div></span>`;
    const { snapshot } = collect(`${seg(0)}${seg(30)}${seg(60)}<button data-rect="0 50 100 30">Далее</button>`);
    expect(snapshot.elements.map((e) => [e.index, e.name])).toEqual([[1, 'Далее']]);
  });

  it('безымянная иконка с tabindex и cursor:pointer остаётся (это кнопка без подписи)', () => {
    const { snapshot } = collect('<span class="icon-close" tabindex="0" style="cursor:pointer" data-rect="0 0 20 20"></span>');
    expect(snapshot.elements.map((e) => e.attrs)).toEqual([[['hint', 'icon-close']]]);
  });
});

describe('collectSnapshot: номера элементов в тексте страницы', () => {
  it('кнопки получают место в тексте рядом со своим вопросом', () => {
    const { snapshot } = collect(`
      <div data-rect="0 0 600 40">Как вам задача?
        <button aria-label="Оценить" data-rect="200 0 30 30"></button><button aria-label="Не нравится" data-rect="240 0 30 30"></button>
      </div>
    `);
    expect(snapshot.text).toBe('Как вам задача? [1] [2]');
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Оценить', 'Не нравится']);
  });

  it('ссылка внутри фразы — номер перед её текстом', () => {
    const { snapshot } = collect('<p data-rect="0 0 600 40">Читайте <a href="/docs" data-rect="60 0 100 20">документацию</a> внимательно.</p>');
    expect(snapshot.text).toBe('Читайте [1] документацию внимательно.');
  });

  it('кликабельная карточка: строка начинается с её номера, кнопка внутри — со своим', () => {
    const { snapshot } = collect(`
      <div class="card" style="cursor:pointer" data-rect="0 0 400 100">Ноутбук X, 50 000 ₽
        <button data-rect="300 60 80 30">Купить</button>
      </div>
      <div class="card" style="cursor:pointer" data-rect="0 120 400 100">Ноутбук Y, 70 000 ₽
        <button data-rect="300 180 80 30">Купить</button>
      </div>
    `);
    expect(snapshot.text).toBe('[1] Ноутбук X, 50 000 ₽ [2]\n[3] Ноутбук Y, 70 000 ₽ [4]');
  });

  it('номера в тексте учитывают перенумерацию после удаления обёрток', () => {
    const { snapshot } = collect(`
      <div data-rect="0 0 600 40">Поиск: <span class="tip" style="cursor:pointer" data-rect="60 0 40 40"><button aria-label="Найти" data-rect="60 0 40 40"></button></span></div>
    `);
    expect(snapshot.elements.map((e) => [e.index, e.name])).toEqual([[1, 'Найти']]);
    expect(snapshot.text).toBe('Поиск: [1]');
  });
});

describe('collectSnapshot: подпись + видимый кружок — один элемент', () => {
  it('label с cursor:pointer вокруг видимого radio не дублируется', () => {
    const opt = (y: number, name: string, checked = false) =>
      `<label class="option" style="cursor:pointer;display:block" data-rect="0 ${y} 600 40"><input type="radio" name="q" data-rect="5 ${y + 10} 16 16"${checked ? ' checked' : ''}><span>${name}</span></label>`;
    const { snapshot } = collect(`<div data-rect="0 0 600 200">${opt(0, 'Одиночный', true)}${opt(50, 'Множественный')}${opt(100, 'С открывающим и закрывающим тегом')}</div>`);
    expect(snapshot.elements.map((e) => [e.index, e.tag, e.name, e.states])).toEqual([
      [1, 'input', 'Одиночный', ['checked']],
      [2, 'input', 'Множественный', []],
      [3, 'input', 'С открывающим и закрывающим тегом', []],
    ]);
    expect(snapshot.text).toBe('[1] Одиночный\n[2] Множественный\n[3] С открывающим и закрывающим тегом');
  });

  it('label for= у текстового поля тоже не отдельный элемент', () => {
    const { snapshot } = collect('<label for="e" style="cursor:pointer" data-rect="0 0 100 20">Email</label><input id="e" type="email" data-rect="0 30 200 30">');
    expect(snapshot.elements.map((e) => [e.tag, e.name])).toEqual([['input', 'Email']]);
  });
});

describe('collectSnapshot: inline-block внутри текста', () => {
  it('термины словаря (inline-block) остаются во фразе, а не уезжают отдельной строкой', () => {
    const { snapshot } = collect(`
      <p data-rect="0 0 800 40">Путь к картинке указывается атрибутом <span class="element-hint" style="display:inline-block" data-rect="300 0 30 20"><code style="cursor:pointer">src</code></span>.</p>
      <p data-rect="0 50 800 40">Изображение создаётся одним <span class="element-hint" style="display:inline-block" data-rect="200 50 150 20">открывающим тегом</span>.</p>
    `);
    expect(snapshot.text).toBe('Путь к картинке указывается атрибутом src.\nИзображение создаётся одним открывающим тегом.');
  });

  it('кнопка inline-block во фразе — только номер, без дубля текста', () => {
    const { snapshot } = collect('<p data-rect="0 0 800 40">Нажмите <button style="display:inline-block" data-rect="80 0 60 20">Далее</button>, чтобы продолжить.</p>');
    expect(snapshot.text).toBe('Нажмите [1], чтобы продолжить.');
  });
});

describe('collectSnapshot: чекбокс, перекрытый своей иконкой (Практикум quiz-form-choice)', () => {
  it('input перекрыт svg-галочкой — кликаем по label, показываем как checkbox с подписью', () => {
    const opt = (y: number, name: string) => `
      <div class="quiz-form-choice__option" data-rect="0 ${y} 760 42">
        <label class="quiz-form-choice__option-label" style="cursor:pointer;display:flex" data-rect="0 ${y} 690 42">
          <span class="checkbox2" data-rect="0 ${y + 9} 24 24">
            <span class="visually-hidden" data-rect="0 ${y + 9} 1 1"><input type="checkbox" value="${name}" data-rect="0 ${y + 9} 13 13"></span>
            <svg class="icon-tick" data-rect="0 ${y + 9} 24 24"></svg>
          </span>
          <div class="paragraph" data-rect="40 ${y + 8} 650 26">${name}</div>
        </label>
      </div>`;
    const { snapshot, registry } = collect(`<form>${opt(0, 'target')}${opt(50, 'src')}${opt(100, 'alt')}</form>`);
    expect(snapshot.elements.map((e) => [e.tag, e.type, e.name])).toEqual([
      ['input', 'checkbox', 'target'],
      ['input', 'checkbox', 'src'],
      ['input', 'checkbox', 'alt'],
    ]);
    expect(registry.map((r) => r.target.localName)).toEqual(['label', 'label', 'label']);
    expect(snapshot.stats.covered).toBe(0);
  });
});

describe('collectSnapshot: «Скрыть от модели»', () => {
  it('элементы с указанным текстом не попадают ни в список, ни в номера в тексте', () => {
    const { snapshot } = collect(
      `<div data-rect="0 0 600 40">Как вам задача? <button aria-label="Оценить" data-rect="200 0 30 30"></button><button aria-label="Оценить" data-rect="240 0 30 30"></button></div>
       <button data-rect="0 100 200 40">К следующему уроку</button>`,
      { hideNames: ['оценить'] },
    );
    expect(snapshot.elements.map((e) => [e.index, e.name])).toEqual([[1, 'К следующему уроку']]);
    expect(snapshot.text).toBe('Как вам задача?');
    expect(snapshot.stats.userHidden).toBe(2);
  });

  it('иконки без текста скрываются CSS-селектором — вместе со всем содержимым', () => {
    const { snapshot } = collect(
      `<aside data-rect="0 0 80 300">
         <button class="theme-toggle" data-rect="10 10 60 60"><svg></svg></button>
         <button class="like-button" data-rect="10 80 60 60"><span>12</span></button>
       </aside>
       <div class="support-chat" data-rect="900 700 80 80" style="cursor:pointer"><button data-rect="910 710 60 60">Чат</button><p data-rect="900 770 80 10">Напишите нам</p></div>
       <button data-rect="300 300 200 40">Проверить</button>`,
      { hideNames: ['css: button.theme-toggle', 'CSS: .like-button', 'css: .support-chat', 'css: ]]не селектор'] },
    );
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Проверить']);
    expect(snapshot.text).not.toContain('Напишите нам');
    expect(snapshot.text).not.toContain('12');
    expect(snapshot.stats.userHidden).toBe(3);
  });

  it('текстовое правило убирает и текст ссылки внутри абзаца, регистр не важен', () => {
    const { snapshot } = collect(
      `<p data-rect="0 0 600 20">Перейдите в <a href="/my" data-rect="100 0 80 20">Мои курсы</a> или читайте дальше</p>
       <header data-rect="0 40 600 40"><button data-rect="0 40 120 40" aria-label="Мои курсы"><span>☰</span> Мои курсы</button><button data-rect="130 40 200 40">Подарок за друга</button></header>`,
      { hideNames: ['мои КУРСЫ', 'Подарок за друга'] },
    );
    expect(snapshot.elements).toEqual([]);
    expect(snapshot.text).toBe('Перейдите в или читайте дальше');
  });
});

describe('collectSnapshot: кнопка «Далее» из заметки сайта', () => {
  it('помечается NEXT в списке, даже если на ней одни эмодзи; остальное не трогается', () => {
    const text = line(
      `<h1 data-rect="0 0 600 40">Playground</h1>
       <button class="lesson-next" data-rect="200 300 300 80">🔬🧪</button>
       <button class="chat" data-rect="900 700 60 60"><svg></svg></button>`,
      { nextNames: ['css: button.lesson-next'] },
    );
    expect(text).toContain('[1] button "🔬🧪" ← NEXT (moves on to the next lesson/page)');
    expect(text).not.toMatch(/\[2\][^\n]*NEXT/);
  });

  it('и по тексту, и вместе со «скрыть»', () => {
    const { snapshot } = collect(
      `<button data-rect="0 0 100 20">Уф, надеюсь, это всё?</button><button data-rect="0 40 100 20">Оценить</button>`,
      { nextNames: ['надеюсь, это всё'], hideNames: ['Оценить'] },
    );
    expect(snapshot.elements.map((e) => [e.name, !!e.next])).toEqual([['Уф, надеюсь, это всё?', true]]);
  });
});

describe('collectSnapshot: сбор внутри iframe с другого сайта', () => {
  it('координаты и зоны — в системе верхней страницы, номера продолжают верхние', () => {
    const { snapshot, registry } = collect(
      `<button data-rect="10 10 100 30">Проверить</button><button data-rect="10 700 100 30">Внизу фрейма</button>`,
      {
        indexBase: 20,
        frame: { offset: { x: 100, y: 300 }, clip: { x: 100, y: 300, width: 900, height: 600 }, viewport: { width: 1200, height: 800 } },
      },
    );
    expect(snapshot.elements.map((e) => [e.index, e.name, e.zone, e.inFrame])).toEqual([
      [21, 'Проверить', 'visible', true],
      [22, 'Внизу фрейма', 'below', true],
    ]);
    expect(snapshot.elements[0]!.rect).toEqual({ x: 110, y: 310, width: 100, height: 30 });
    expect(registry.map((r) => r.index)).toEqual([21, 22]);
  });

  it('номера в тексте тоже со сдвигом', () => {
    const { snapshot } = collect('<p data-rect="0 0 500 20">Нажмите <button data-rect="60 0 80 20">Проверить</button></p>', { indexBase: 5 });
    expect(snapshot.text).toBe('Нажмите [6]');
  });
});

describe('collectSnapshot: редакторы кода', () => {
  it('CodeMirror 5 — одно поле code-editor, код построчно в тексте, без номеров и стрелок', () => {
    const { snapshot, registry } = collect(`
      <div class="tab" data-rect="0 0 100 30">index.html</div>
      <div class="CodeMirror" data-rect="0 40 600 400">
        <textarea style="position:absolute" data-rect="0 40 1 1"></textarea>
        <div class="CodeMirror-gutters" data-rect="0 40 30 400"><div class="CodeMirror-foldgutter-open" style="cursor:pointer" data-rect="20 40 10 18"></div></div>
        <div class="CodeMirror-lines" data-rect="30 40 570 400">
          <pre class="CodeMirror-line" data-rect="30 40 570 18"><span>&lt;h1&gt;The Life of&lt;/h1&gt;</span></pre>
          <pre class="CodeMirror-line" data-rect="30 58 570 18"><span>  &lt;img src="x.jpg"&gt;</span></pre>
        </div>
        <div class="CodeMirror-linenumber" data-rect="0 40 20 18">1</div>
      </div>
      <button data-rect="0 460 100 30">Проверить</button>
    `);
    expect(snapshot.elements.map((e) => [e.index, e.tag, e.attrs])).toEqual([
      [1, 'code-editor', [['lines', '2']]],
      [2, 'button', []],
    ]);
    expect(registry[0]!.target.className).toBe('CodeMirror-lines');
    expect(snapshot.text).toBe('index.html\n[1] code editor contents:\n<h1>The Life of</h1>\n<img src="x.jpg">');
  });

  it('CodeMirror 6 (cm-editor) тоже одно поле, а не contenteditable внутри', () => {
    const { snapshot } = collect(`
      <div class="cm-editor" data-rect="0 0 600 300">
        <div class="cm-content" contenteditable="true" data-rect="30 0 570 300"><div class="cm-line">let a = 1;</div></div>
      </div>
    `);
    expect(snapshot.elements.map((e) => e.tag)).toEqual(['code-editor']);
    expect(snapshot.text).toContain('let a = 1;');
  });
});

describe('collectSnapshot: приклеенные панели', () => {
  it('fixed/sticky-панели и окна помечаются pinned, обёртка на весь экран — нет', () => {
    const { snapshot } = collect(`
      <div style="position:fixed" data-rect="0 0 1000 800">
        <main><button data-rect="300 400 200 40">Расскажи анекдот</button></main>
        <nav style="position:fixed" data-rect="0 0 60 800"><button aria-label="Курсы" data-rect="10 700 40 40">x</button></nav>
      </div>
      <aside style="position:sticky" data-rect="900 700 100 100"><a href="/chat" data-rect="910 720 80 30">Чат</a></aside>
      <div role="dialog"><button data-rect="500 100 100 30">Закрыть</button></div>`);
    const by = (name: string) => snapshot.elements.find((e) => e.name === name);
    expect(by('Расскажи анекдот')?.pinned).toBeFalsy();
    expect(by('Курсы')?.pinned).toBe(true);
    expect(by('Чат')?.pinned).toBe(true);
    expect(by('Закрыть')?.pinned).toBe(true);
  });
});


describe('collectSnapshot: «@иконки»', () => {
  const html = `
    <main><button data-rect="300 400 200 40">Расскажи анекдот</button><button data-rect="300 500 40 40" aria-label="Нравится">♡</button></main>
    <div style="position:fixed" data-rect="900 700 60 60"><button aria-label="Чат" data-rect="905 705 50 50"><svg></svg></button><button data-rect="905 650 50 40">Помощь</button></div>
    <aside style="position:sticky" data-rect="0 0 60 800"><label data-rect="10 100 40 40" style="cursor:pointer"><input type="checkbox" hidden>◐</label></aside>`;
  const names = (hide: string[]) => collect(html, { hideNames: hide }).snapshot.elements.map((e) => e.name ?? '');

  it('без правила иконки на панелях видны', () => {
    expect(names([])).toEqual(expect.arrayContaining(['Расскажи анекдот', 'Нравится', 'Чат', 'Помощь']));
  });

  it('с правилом прячутся иконки без подписи на приклеенных панелях; кнопки с текстом и иконки урока остаются', () => {
    const n = names(['@иконки']);
    expect(n).toEqual(expect.arrayContaining(['Расскажи анекдот', 'Нравится', 'Помощь']));
    expect(n).not.toContain('Чат');
    expect(n.length).toBe(3);
  });

  it('во фрейме (тренажёр) прячутся все иконки без подписи', () => {
    document.body.innerHTML = '<button data-rect="10 10 40 40" aria-label="Тема">◐</button><button data-rect="10 60 100 30">Проверить</button>';
    const { snapshot } = collectSnapshot(document, fakeGeometry(), {
      hideNames: ['@icons'],
      frame: { offset: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1000, height: 800 }, viewport: { width: 1000, height: 800 } },
    });
    expect(snapshot.elements.map((e) => e.name)).toEqual(['Проверить']);
  });
});

describe('кнопка отправки формы для поля', () => {
  it('поле запоминает текст кнопки, которую нажмёт Enter', () => {
    const { snapshot } = collect(`
      <form data-rect="0 0 500 100">
        <input placeholder="Сообщение" data-rect="0 0 200 20"><button type="button" data-rect="0 30 100 20">Смайлик</button><button data-rect="0 60 100 20">Отправить</button>
      </form>
      <input placeholder="Вне формы" data-rect="0 200 200 20">`);
    const field = (p: string) => snapshot.elements.find((e) => e.tag === 'input' && (e.name === p || e.attrs.some(([k, v]) => k === 'placeholder' && v === p)));
    expect(field('Сообщение')?.formSubmit).toBe('Отправить');
    expect(field('Вне формы')?.formSubmit).toBeUndefined();
    expect(snapshot.elements.find((e) => e.name === 'Отправить')?.formSubmit).toBeUndefined();
  });
});
