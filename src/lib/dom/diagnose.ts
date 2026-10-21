import type { TraceVerdict } from './collect';
import { collapseWhitespace, truncate } from './serialize';

export interface Diagnosis {
  /** Короткое описание выбранного элемента. */
  element: string;
  /** Главный вывод одной фразой. */
  verdict: string;
  /** Подробности и подсказки. */
  details: string[];
  /** Номер, под которым модель видит элемент (или его кликабельного предка). */
  index?: number;
  ok: boolean;
}

export interface DiagnoseInput {
  trace: ReadonlyMap<Element, TraceVerdict>;
  /** Номера, попавшие в текст наблюдения после обрезки по лимиту. */
  shown: ReadonlySet<number>;
  totalElements: number;
  walkTruncated: boolean;
}

/** `button#id.cls "текст"` — чтобы человек узнал элемент. */
export function describeElement(el: Element): string {
  let s = el.localName;
  const id = el.getAttribute('id');
  if (id) s += `#${id}`;
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  if (cls.length) s += `.${cls.join('.')}`;
  const text = collapseWhitespace(el.textContent ?? '');
  if (text) s += ` "${truncate(text, 40)}"`;
  return s;
}

/** Родитель с переходом через границы shadow DOM и same-origin iframe. */
function parentAcross(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const host = (el.getRootNode() as Partial<ShadowRoot>).host;
  if (host) return host;
  try {
    return el.ownerDocument.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

function ancestry(el: Element): Element[] {
  const chain: Element[] = [];
  for (let n: Element | null = el; n; n = parentAcross(n)) chain.push(n);
  return chain;
}

const SKIP_REASONS: Record<'tag' | 'ignored' | 'inert' | 'display-none' | 'user-hidden' | 'locked', string> = {
  locked: 'вариант ответа заблокирован (disabled) — тест уже пройден; в тексте страницы показан с пометкой, кликать его нельзя',
  'user-hidden': 'скрыт вашей заметкой для сайта («Скрыть от модели»)',
  tag: 'служебный тег (script/style/template…)',
  ignored: 'служебный элемент самого расширения',
  inert: 'атрибут inert — страница сама отключила взаимодействие',
  'display-none': 'display: none',
};

/**
 * Объясняет, почему элемент виден или не виден модели, по журналу решений сборщика.
 * Смотрит на сам элемент и его предков: клик по span внутри кнопки — это клик по кнопке.
 */
export function diagnose(picked: Element, input: DiagnoseInput): Diagnosis {
  const chain = ancestry(picked);
  const element = describeElement(picked);
  const self = (el: Element) => (el === picked ? 'Элемент' : `Его предок ${describeElement(el)}`);

  // 1. Предок вырезан целиком — до элемента обход не дошёл.
  for (const el of chain) {
    const v = input.trace.get(el);
    if (v?.kind === 'skipped') {
      return { element, ok: false, verdict: `${self(el)} пропущен: ${SKIP_REASONS[v.reason]}.`, details: [] };
    }
  }

  // 2. Ближайший элемент цепочки, который сборщик счёл интерактивным.
  for (const el of chain) {
    const v = input.trace.get(el);
    if (!v) continue;
    const via = el === picked ? '' : ` Клик сюда засчитывается как клик по ${describeElement(el)}.`;
    switch (v.kind) {
      case 'accepted':
        if (input.shown.has(v.index)) {
          return { element, ok: true, index: v.index, verdict: `Модель видит его как [${v.index}].${via}`, details: [] };
        }
        return {
          element,
          ok: false,
          index: v.index,
          verdict: `Распознан как [${v.index}], но не влез в лимит символов наблюдения.${via}`,
          details: [
            `Всего интерактивных элементов: ${input.totalElements}. Порядок заполнения: сначала на экране, затем ближние ниже, затем выше.`,
            'Прокрутите страницу к элементу или увеличьте «Лимит наблюдения» в настройках.',
          ],
        };
      case 'hidden':
        return {
          element,
          ok: false,
          verdict: `${self(el)} распознан как интерактивный, но считается невидимым.`,
          details: [
            v.why === 'transparent'
              ? 'Почти прозрачный: суммарная opacity его и предков меньше 0.1.'
              : v.why === 'inside aria-hidden'
                ? 'Лежит внутри aria-hidden="true" — сайт сам пометил этот блок как скрытый.'
                : v.why
                  ? `Обрезан предком: ${v.why} (overflow: hidden, свёрнутый блок, слайд за краем).`
                  : 'checkVisibility() вернул false (display/visibility/opacity у него или предков) или размер ≤ 1px.',
          ],
        };
      case 'offscreen':
        return {
          element,
          ok: false,
          verdict: `${self(el)} за пределами видимой области по горизонтали или внутри прокрутки iframe.`,
          details: ['Так отсекаются невидимые слайды каруселей.'],
        };
      case 'covered':
        return {
          element,
          ok: false,
          verdict: `${self(el)} перекрыт другим элементом — клик в его центр попал бы не в него.`,
          details: [v.by ? `В центре элемента находится: ${describeElement(v.by)}.` : 'В центре элемента ничего не найдено.'],
        };
      case 'too-big':
      case 'wrapper':
        // Обёртка — не кнопка; смотрим дальше по цепочке.
        continue;
      case 'not-interactive':
        continue;
    }
  }

  // 3. Никто в цепочке не интерактивен.
  const v = input.trace.get(picked);
  if (!v) {
    return {
      element,
      ok: false,
      verdict: 'Сборщик до элемента не дошёл.',
      details: [
        input.walkTruncated
          ? 'DOM слишком большой — обход прерван по лимиту узлов.'
          : 'Возможно, элемент в закрытом shadow root, в iframe с другого origin или появился после снимка.',
      ],
    };
  }
  const details: string[] = [];
  if (v.kind === 'not-interactive') {
    details.push(`Тег <${picked.localName}> без role/onclick/tabindex; cursor: ${v.cursor}, у родителя: ${v.parentCursor}.`);
    if (v.cursor === 'pointer' && v.parentCursor === 'pointer') {
      details.push('cursor: pointer унаследован от родителя, а родитель отброшен как слишком большая обёртка.');
    }
    if (v.clickableAncestor === 'semantic') details.push('Находится внутри ссылки/кнопки и считается её частью.');
  } else if (v.kind === 'wrapper') {
    details.push('Безымянный элемент без собственного действия: обёртка вокруг другого элемента или подсказка по фокусу (только tabindex).');
  } else if (v.kind === 'too-big') {
    details.push('Кликабелен только по косвенному признаку (cursor/onclick/tabindex) и занимает больше 40% экрана — принят за обёртку страницы.');
  }
  return { element, ok: false, verdict: 'Не распознан как интерактивный: нет признаков кликабельности.', details };
}
