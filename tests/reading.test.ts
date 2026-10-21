// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { formatAction } from '@/lib/agent/actions';
import { parseAgentStep } from '@/lib/agent/parse';
import { classifyText, collectReadSegments, isCarefulText, MAX_READ_MS, planReading, type ReadSegment, type TextKind } from '@/lib/dom/reading';

/** Детерминированный генератор [0, 1). */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const para = (y0: number, y1: number, chars: number, kind: TextKind = 'light'): ReadSegment => ({ y0, y1, chars, kind });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('isCarefulText — что читаем медленно', () => {
  it.each([
    'Метод document.querySelector находит первый подходящий элемент',
    'const button = document.getElementById("go");',
    'button.addEventListener("click", () => {})',
    'Селектор по классу начинается с точки',
    'Теперь напишем код на JavaScript',
    '.card > .title { color: red; }',
    '<button class="btn">Нажми</button>',
  ])('важный: %s', (t) => expect(isCarefulText(t)).toBe(true));

  it.each(['Шутка дня: почему программисты любят темноту?', 'Отдохни пять минут и возвращайся.'])(
    'лёгкий: %s',
    (t) => expect(isCarefulText(t)).toBe(false),
  );
});

describe('classifyText — мусор, рядом с темой, важное', () => {
  it.each([
    ['Очень интересно, но ничего не понятно...', 'junk'],
    ['А что получится в итоге?', 'junk'],
    ['Разберёмся со всем вместе. А потом разгонимся и поработаем над вторым экраном и подвалом', 'junk'],
    ['Держите референс — всё это вы сделаете сами. А попутно больше узнаете о правилах вёрстки', 'light'],
    ['Научимся отличать пиксели от процентов, задавать цвета разными способами', 'light'],
    ['Метод querySelector находит первый подходящий элемент', 'careful'],
    ['.card > .title { color: red; }', 'careful'],
  ] as const)('%s → %s', (text, kind) => expect(classifyText(text)).toBe(kind));
});

describe('planReading — темп чтения', () => {
  it('лёгкий текст: 10–20 с на 1000 символов', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planReading([para(0, 1000, 1000)], 0, 1000, 'auto', seeded(seed));
      expect(plan.totalMs).toBeGreaterThanOrEqual(10_000 - 50);
      expect(plan.totalMs).toBeLessThanOrEqual(20_000 + 50);
      expect(plan.carefulShare).toBe(0);
      expect(plan.junkShare).toBe(0);
    }
  });

  it('важный текст (код, селекторы): 60–90 с на 1000 символов', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planReading([para(0, 1000, 1000, 'careful')], 0, 1000, 'auto', seeded(seed));
      expect(plan.totalMs).toBeGreaterThanOrEqual(60_000 - 50);
      expect(plan.totalMs).toBeLessThanOrEqual(90_000 + 50);
      expect(plan.carefulShare).toBe(1);
    }
  });

  it('pace overrides: light и careful не смотрят на содержимое', () => {
    const segs = [para(0, 1000, 1000, 'careful')];
    expect(planReading(segs, 0, 1000, 'light', seeded()).totalMs).toBeLessThanOrEqual(20_050);
    const careful = planReading([para(0, 1000, 1000, 'light')], 0, 1000, 'careful', seeded());
    expect(careful.totalMs).toBeGreaterThanOrEqual(59_950);
  });

  it('мусор (нет ничего про код и вёрстку): 3–6 с на 1000 символов и без остановок', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planReading([para(0, 1000, 1000, 'junk')], 0, 1000, 'auto', seeded(seed));
      expect(plan.totalMs).toBeGreaterThanOrEqual(3000 - 50);
      expect(plan.totalMs).toBeLessThanOrEqual(6000 + 50);
      expect(plan.junkShare).toBe(1);
      const waits = plan.steps.map((s) => s.waitMs);
      expect(Math.max(...waits)).toBeLessThan(plan.totalMs / 2);
    }
  });

  it('мусор быстрее лёгкого текста, лёгкий — быстрее важного', () => {
    const t = (kind: TextKind) => planReading([para(0, 1000, 1000, kind)], 0, 1000, 'auto', seeded(4)).totalMs;
    expect(t('junk')).toBeLessThan(t('light'));
    expect(t('light')).toBeLessThan(t('careful'));
  });

  it('мусор и полезное вперемешку: время каждого класса сохраняется, остановок на мусоре нет', () => {
    const plan = planReading([para(0, 600, 600, 'junk'), para(600, 1200, 600, 'careful')], 0, 1200, 'auto', seeded(9));
    let scrolled = 0;
    const junkSteps = plan.steps.filter((s) => (scrolled += s.deltaY) <= 600);
    expect(sum(junkSteps.map((s) => s.waitMs))).toBeLessThanOrEqual(600 * 0.006 * 1000 + 50);
    expect(plan.totalMs).toBeGreaterThan(600 * 0.06 * 1000);
    expect(sum(plan.steps.map((s) => s.deltaY))).toBe(1200);
  });

  it('pace light ускоряет важное до лёгкого, но мусор остаётся мусором; careful читает всё внимательно', () => {
    const junk = para(0, 1000, 1000, 'junk');
    expect(planReading([junk], 0, 1000, 'light', seeded()).junkShare).toBe(1);
    expect(planReading([junk], 0, 1000, 'careful', seeded()).totalMs).toBeGreaterThanOrEqual(59_950);
  });

  it('смешанный текст: время — сумма по абзацам', () => {
    const plan = planReading([para(0, 500, 500, 'light'), para(500, 1000, 500, 'careful')], 0, 1000, 'auto', seeded());
    expect(plan.totalMs).toBeGreaterThanOrEqual(500 * 0.01 * 1000 + 500 * 0.06 * 1000 - 50);
    expect(plan.totalMs).toBeLessThanOrEqual(500 * 0.02 * 1000 + 500 * 0.09 * 1000 + 50);
    expect(plan.carefulShare).toBeCloseTo(0.5, 1);
  });

  it('прокрутка в сумме ровно от начала до конца, только вниз, шаги небольшие', () => {
    const plan = planReading([para(100, 2500, 3000)], 100, 2500, 'auto', seeded(3));
    expect(sum(plan.steps.map((s) => s.deltaY))).toBe(2400);
    expect(plan.steps.every((s) => s.deltaY > 0 && s.deltaY <= 200)).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(15);
  });

  it('есть случайные остановки — заметно более долгие паузы, чем обычный шаг', () => {
    const plan = planReading([para(0, 3000, 3000)], 0, 3000, 'auto', seeded(11));
    const waits = plan.steps.map((s) => s.waitMs);
    const median = [...waits].sort((a, b) => a - b)[Math.floor(waits.length / 2)]!;
    expect(Math.max(...waits)).toBeGreaterThan(median * 3);
  });

  it('остановки в разных местах при разных зёрнах', () => {
    const at = (seed: number) => {
      const w = planReading([para(0, 3000, 3000)], 0, 3000, 'auto', seeded(seed)).steps.map((s) => s.waitMs);
      return w.indexOf(Math.max(...w));
    };
    expect(new Set([1, 2, 3, 4, 5, 6].map(at)).size).toBeGreaterThan(1);
  });

  it('дыры без текста (картинки) пролистываются, а не пропускаются', () => {
    const plan = planReading([para(0, 300, 300), para(1200, 1500, 300)], 0, 1500, 'auto', seeded());
    expect(sum(plan.steps.map((s) => s.deltaY))).toBe(1500);
  });

  it('вложенные абзацы не читаются дважды', () => {
    const plan = planReading([para(0, 1000, 1000), para(200, 400, 150)], 0, 1000, 'auto', seeded(2));
    expect(plan.chars).toBeLessThanOrEqual(1000);
  });

  it('очень длинный текст урезается до лимита времени', () => {
    const plan = planReading([para(0, 90_000, 200_000, 'careful')], 0, 90_000, 'auto', seeded());
    expect(plan.capped).toBe(true);
    expect(plan.totalMs).toBeLessThanOrEqual(MAX_READ_MS + 500);
  });

  it('пустой диапазон — нет шагов', () => {
    expect(planReading([], 500, 500, 'auto', seeded()).steps).toEqual([]);
  });
});

describe('collectReadSegments — абзацы со страницы', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('группирует текст по блокам, помечает код и селекторы, отбрасывает скрытое и вне диапазона', () => {
    document.body.innerHTML = `
      <p id="a">Страница с котиками и кнопкой.</p>
      <p id="b">Найдём кнопку через document.querySelector и повесим обработчик.</p>
      <pre id="c">let x = 1;</pre>
      <p id="d" hidden>скрыто</p>
      <p id="e">Далеко внизу.</p>`;
    const tops: Record<string, number> = { a: 100, b: 200, c: 300, d: 400, e: 5000 };
    const segs = collectReadSegments(document, {
      origin: 0,
      from: 0,
      to: 1000,
      isVisible: (el) => !el.closest('[hidden]'),
      rectOf: (node) => {
        const top = tops[node.parentElement!.id];
        return top === undefined ? null : { top, bottom: top + 40 };
      },
    });
    expect(segs.map((s) => [s.y0, s.kind])).toEqual([
      [100, 'light'],
      [200, 'careful'],
      [300, 'careful'],
    ]);
    expect(segs[0]!.chars).toBe('Страница с котиками и кнопкой.'.length);
  });

  it('навигация, подвал и баннер cookie — мусор, даже если в них есть слова по теме', () => {
    document.body.innerHTML = `
      <nav><a>Главная страница сайта</a></nav>
      <p id="m">Основной текст про вёрстку страниц.</p>
      <div class="cookie-banner"><p>Мы используем cookie на сайте.</p></div>
      <footer><p>Контакты, ссылки и страницы</p></footer>`;
    const segs = collectReadSegments(document, {
      origin: 0,
      from: 0,
      to: 5000,
      isVisible: () => true,
      rectOf: (node) => {
        const y = [...document.querySelectorAll('a,p')].indexOf(node.parentElement!) * 100 + 10;
        return { top: y, bottom: y + 30 };
      },
    });
    expect(segs.map((s) => s.kind)).toEqual(['junk', 'light', 'junk', 'junk']);
  });

  it('origin сдвигает координаты в систему содержимого', () => {
    document.body.innerHTML = '<p>Текст абзаца</p>';
    const [seg] = collectReadSegments(document, {
      origin: -500,
      from: 0,
      to: 9999,
      isVisible: () => true,
      rectOf: () => ({ top: 100, bottom: 130 }),
    });
    expect(seg).toMatchObject({ y0: 600, y1: 630 });
  });
});

describe('действие read: разбор и запись', () => {
  const one = (json: string) => {
    const r = parseAgentStep(json, 4);
    if (!r.ok) throw new Error(r.error);
    return r.step.actions[0];
  };
  const wrap = (a: string) => `{"reasoning":"r","expected_outcome":"o","actions":[${a}]}`;

  it('все поля и алиасы', () => {
    expect(one(wrap('{"action":"read","index":3,"to_index":9,"pace":"careful"}'))).toEqual({ action: 'read', index: 3, to_index: 9, pace: 'careful' });
    expect(one(wrap('{"action":"read_between","from":3,"to":9}'))).toMatchObject({ action: 'read', to_index: 9 });
  });

  it('без параметров — читать с текущего места до конца; неверный pace отбрасывается', () => {
    expect(one(wrap('{"action":"read"}'))).toEqual({ action: 'read' });
    expect(one(wrap('{"action":"read","pace":"turbo"}'))).toEqual({ action: 'read' });
  });

  it('запись для ленты', () => {
    expect(formatAction({ action: 'read', index: 3, to_index: 9, pace: 'careful' })).toBe('read [3] → [9] (careful)');
    expect(formatAction({ action: 'read' })).toBe('read → end');
  });
});
