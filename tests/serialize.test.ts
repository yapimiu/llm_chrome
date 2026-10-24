import { describe, expect, it } from 'vitest';
import { SECTION_TITLES, serializeElement, serializePage, truncate } from '@/lib/dom/serialize';
import type { ElementInfo, PageSnapshot } from '@/lib/dom/types';

let nextIndex = 1;
function el(patch: Partial<ElementInfo> = {}): ElementInfo {
  const index = patch.index ?? nextIndex++;
  return {
    index,
    tag: 'button',
    name: `Кнопка ${index}`,
    attrs: [],
    states: [],
    zone: 'visible',
    distance: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...patch,
  };
}

function snap(patch: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/login',
    title: 'Вход',
    scroll: { x: 0, y: 0, maxY: 0, viewportWidth: 1280, viewportHeight: 720 },
    elements: [],
    text: '',
    stats: { nodesVisited: 0, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 },
    ...patch,
  };
}

describe('truncate', () => {
  it('не трогает короткие строки и ставит многоточие у длинных', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 4)).toHaveLength(4);
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('abc', 1)).toBe('…');
  });
});

describe('serializeElement', () => {
  it('кнопка', () => {
    expect(serializeElement(el({ index: 12, name: 'Войти' }))).toBe('[12] button "Войти"');
  });

  it('input с типом, placeholder и пустым value — формат из ТЗ', () => {
    const line = serializeElement(
      el({
        index: 13,
        tag: 'input',
        type: 'email',
        name: '',
        attrs: [
          ['placeholder', 'Email'],
          ['value', ''],
        ],
      }),
    );
    expect(line).toBe('[13] input[type=email] placeholder="Email" value=""');
  });

  it('role, contenteditable и состояния', () => {
    expect(serializeElement(el({ index: 3, tag: 'div', role: 'checkbox', name: 'Запомнить', states: ['checked', 'disabled'] }))).toBe(
      '[3] div[role=checkbox] "Запомнить" checked disabled',
    );
    expect(serializeElement(el({ index: 4, tag: 'div', contentEditable: true, name: 'Текст письма' }))).toBe(
      '[4] div[contenteditable] "Текст письма"',
    );
  });

  it('не дублирует role, совпадающую с тегом', () => {
    expect(serializeElement(el({ index: 1, role: 'button', name: 'OK' }))).toBe('[1] button "OK"');
  });

  it('экранирует кавычки и обратные слеши, схлопывает пробелы', () => {
    expect(serializeElement(el({ index: 1, name: 'Say  "hi"\n\\o/' }))).toBe('[1] button "Say \\"hi\\" \\\\o/"');
  });

  it('обрезает длинные имена и href', () => {
    const line = serializeElement(
      el({ index: 1, tag: 'a', name: 'x'.repeat(200), attrs: [['href', `/${'p'.repeat(200)}`]] }),
      50,
    );
    expect(line).toContain(`"${'x'.repeat(49)}…"`);
    expect(line).toMatch(/href="\/p+…"/);
    expect(line.length).toBeLessThan(200);
  });

  it('select со списком вариантов и счётчиком остатка', () => {
    const options = Array.from({ length: 12 }, (_, i) => `Город ${i + 1}`);
    const line = serializeElement(
      el({ index: 5, tag: 'select', name: 'Город', attrs: [['value', 'Город 1']], options: options.slice(0, 8), optionsTotal: 12 }),
    );
    expect(line).toContain('value="Город 1"');
    expect(line).toContain('options=["Город 1",');
    expect(line).toContain('"Город 8",…+4]');
    expect(line).not.toContain('Город 9');
  });
});

describe('serializePage', () => {
  it('заголовок, секции и текст', () => {
    const out = serializePage(
      snap({
        scroll: { x: 0, y: 500, maxY: 2000, viewportWidth: 1280, viewportHeight: 720 },
        elements: [
          el({ index: 1, name: 'Меню', zone: 'above', distance: 100 }),
          el({ index: 2, name: 'Войти' }),
          el({ index: 3, name: 'Подвал', zone: 'below', distance: 900 }),
        ],
        text: 'Добро пожаловать',
      }),
      { maxChars: 5000 },
    );
    expect(out.text).toBe(
      [
        'URL: https://example.com/login',
        'Title: Вход',
        'Scroll: y=500 of 2000 (25%), viewport 1280x720',
        '',
        SECTION_TITLES.above,
        '[1] button "Меню"',
        '',
        SECTION_TITLES.visible,
        '[2] button "Войти"',
        '',
        SECTION_TITLES.below,
        '[3] button "Подвал"',
        '',
        SECTION_TITLES.text,
        'Добро пожаловать',
      ].join('\n'),
    );
    expect(out.shownIndices).toEqual([1, 2, 3]);
    expect(out.omittedElements).toBe(0);
    expect(out.textTruncated).toBe(false);
  });

  it('пустая страница', () => {
    const out = serializePage(snap(), { maxChars: 1000 });
    expect(out.text).toContain(SECTION_TITLES.none);
    expect(out.text).toContain('Scroll: none');
    expect(out.text).not.toContain(SECTION_TITLES.text);
  });

  it('никогда не превышает лимит', () => {
    const elements = Array.from({ length: 500 }, (_, i) =>
      el({ index: i + 1, name: `Элемент номер ${i + 1} с длинным названием`, zone: i < 100 ? 'visible' : 'below', distance: i }),
    );
    const text = 'Слово '.repeat(5000);
    for (const maxChars of [50, 200, 1000, 3000, 12000, 100000]) {
      const out = serializePage(snap({ elements, text }), { maxChars });
      expect(out.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('при нехватке места сначала берёт видимые, затем ближние снизу, затем сверху', () => {
    const elements = [
      el({ index: 1, zone: 'above', distance: 10 }),
      el({ index: 2, zone: 'visible' }),
      el({ index: 3, zone: 'visible' }),
      el({ index: 4, zone: 'below', distance: 5000 }),
      el({ index: 5, zone: 'below', distance: 50 }),
    ];
    // Наращиваем лимит и смотрим, в каком порядке элементы попадают в вывод.
    const order: number[] = [];
    let sawOmittedNote = false;
    for (let maxChars = 100; maxChars < 2000; maxChars += 5) {
      const out = serializePage(snap({ elements }), { maxChars });
      for (const i of out.shownIndices) if (!order.includes(i)) order.push(i);
      if (out.shownIndices.length === 3) {
        expect(out.omittedElements).toBe(2);
        expect(out.text).toContain('[2 more interactive elements not shown due to size limit]');
        sawOmittedNote = true;
      }
    }
    expect(order).toEqual([2, 3, 5, 4, 1]);
    expect(sawOmittedNote).toBe(true);
  });

  it('выводит элементы в порядке документа внутри зоны, даже если отбирал по дистанции', () => {
    const elements = [el({ index: 1, zone: 'below', distance: 900 }), el({ index: 2, zone: 'below', distance: 10 })];
    const out = serializePage(snap({ elements }), { maxChars: 10000 });
    expect(out.text.indexOf('[1]')).toBeLessThan(out.text.indexOf('[2]'));
  });

  it('гарантирует тексту долю лимита и помечает обрезку', () => {
    const elements = Array.from({ length: 300 }, (_, i) => el({ index: i + 1 }));
    const out = serializePage(snap({ elements, text: 'текст '.repeat(2000) }), { maxChars: 4000, textShare: 0.25 });
    const textPart = out.text.split(`${SECTION_TITLES.text}\n`)[1] ?? '';
    expect(textPart.length).toBeGreaterThan(4000 * 0.2);
    expect(out.textTruncated).toBe(true);
    expect(textPart.endsWith('…')).toBe(true);
    expect(out.omittedElements).toBeGreaterThan(0);
  });

  it('если текст короткий, отдаёт неиспользованный резерв элементам', () => {
    const elements = Array.from({ length: 60 }, (_, i) => el({ index: i + 1 }));
    const withText = serializePage(snap({ elements, text: 'коротко' }), { maxChars: 1500 });
    const noText = serializePage(snap({ elements }), { maxChars: 1500 });
    // Короткому тексту нужно ~3 строки элементов места, а не весь резерв (20% = ~13 строк).
    expect(noText.shownIndices.length - withText.shownIndices.length).toBeLessThanOrEqual(4);
  });

  it('декодирует URL в заголовке, а битый percent-encoding оставляет как есть', () => {
    expect(serializePage(snap({ url: 'https://ru.wikipedia.org/wiki/%D0%9F%D0%BE%D0%B8%D1%81%D0%BA' }), { maxChars: 1000 }).text).toContain(
      'URL: https://ru.wikipedia.org/wiki/Поиск',
    );
    expect(serializePage(snap({ url: 'https://e.com/%E0%A4%A' }), { maxChars: 1000 }).text).toContain('URL: https://e.com/%E0%A4%A');
  });

  it('обрезает длинные URL и заголовок', () => {
    const out = serializePage(snap({ url: `https://e.com/?q=${'a'.repeat(500)}`, title: 'T'.repeat(500) }), { maxChars: 2000 });
    const [urlLine, titleLine] = out.text.split('\n');
    expect(urlLine!.length).toBeLessThanOrEqual('URL: '.length + 200);
    expect(titleLine!.length).toBeLessThanOrEqual('Title: '.length + 150);
  });
});


describe('oversized element retention', () => {
  it('skips an oversized middle line and retains later short elements in document order', () => {
    const huge = el({ index: 2, name: 'Long', attrs: Array.from({ length: 20 }, (_, i) => [`data-${i}`, 'x'.repeat(80)]) });
    const page = snap({ elements: [el({ index: 1, name: 'First' }), huge, el({ index: 3, name: 'Continue' })] });
    const result = serializePage(page, { maxChars: 600 });
    expect(result.shownIndices).toEqual([1, 3]);
    expect(result.omittedElements).toBe(1);
    expect(result.text.length).toBeLessThanOrEqual(600);
    expect(result.text.indexOf('[1]')).toBeLessThan(result.text.indexOf('[3]'));
  });
  it('does not expose phantom indices when a tiny budget fits no element', () => {
    const page = snap({ elements: [el({ index: 1, name: 'Continue' })] });
    for (const maxChars of [0, 1, 20, 100]) {
      const result = serializePage(page, { maxChars });
      expect(result.shownIndices).toEqual([]);
      expect(result.omittedElements).toBe(1);
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
    }
  });
});
