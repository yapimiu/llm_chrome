import type { ElementInfo, PageSnapshot } from './types';

export interface SerializeOptions {
  /** Жёсткий лимит на длину результата. */
  maxChars: number;
  /** Обрезка имени/значения одного элемента. */
  maxTextPerElement?: number;
  /** Доля лимита, гарантированно оставляемая под текст страницы (если текст есть). */
  textShare?: number;
}

export interface SerializedPage {
  text: string;
  /** Индексы элементов, попавших в вывод (их и подсвечивает debug-оверлей). */
  shownIndices: number[];
  omittedElements: number;
  textTruncated: boolean;
}

const DEFAULT_MAX_TEXT = 80;
const MAX_HREF = 80;
const MAX_URL = 200;
const MAX_TITLE = 150;
const MAX_OPTIONS = 8;
const MAX_OPTION_TEXT = 30;

/** Пометка кнопки «Далее», заданной пользователем в заметке сайта. */
export const NEXT_MARK = '← NEXT (moves on to the next lesson/page)';

export const SECTION_TITLES = {
  above: 'Interactive elements ABOVE the viewport (scroll up to see):',
  visible: 'Interactive elements in the viewport:',
  below: 'Interactive elements BELOW the viewport (scroll down to see):',
  none: 'No interactive elements found.',
  text: 'Visible page text ([N] shows where interactive element N is):',
} as const;

export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return max === 1 ? '…' : `${s.slice(0, max - 1)}…`;
}

/** %D0%9F%D0%BE… → читаемая кириллица: короче и понятнее модели. */
export function safeDecodeUri(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Одна строка вида `[12] button "Войти"` / `[13] input[type=email] placeholder="Email" value=""`. */
export function serializeElement(e: ElementInfo, maxText = DEFAULT_MAX_TEXT): string {
  let head = e.tag;
  if (e.type) head += `[type=${e.type}]`;
  if (e.role && e.role !== e.tag) head += `[role=${e.role}]`;
  if (e.contentEditable) head += '[contenteditable]';

  const parts = [`[${e.index}]`, head];
  const name = collapseWhitespace(e.name);
  if (name) parts.push(quote(truncate(name, maxText)));

  for (const [key, raw] of e.attrs) {
    const limit = key === 'href' ? MAX_HREF : maxText;
    parts.push(`${key}=${quote(truncate(collapseWhitespace(raw), limit))}`);
  }

  if (e.options && e.options.length > 0) {
    const shown = e.options.slice(0, MAX_OPTIONS).map((o) => quote(truncate(collapseWhitespace(o), MAX_OPTION_TEXT)));
    const total = e.optionsTotal ?? e.options.length;
    const rest = total - shown.length;
    parts.push(`options=[${shown.join(',')}${rest > 0 ? `,…+${rest}` : ''}]`);
  }

  parts.push(...e.states);
  if (e.next) parts.push(NEXT_MARK);
  return parts.join(' ');
}

function headerLines(s: PageSnapshot): string[] {
  const { scroll } = s;
  const scrollLine =
    scroll.maxY > 0
      ? `Scroll: y=${Math.round(scroll.y)} of ${Math.round(scroll.maxY)} (${Math.round((Math.min(scroll.y, scroll.maxY) / scroll.maxY) * 100)}%)${scroll.container ? ' in the main scrollable area' : ''}, viewport ${scroll.viewportWidth}x${scroll.viewportHeight}`
      : `Scroll: none (page fits in viewport ${scroll.viewportWidth}x${scroll.viewportHeight})`;
  return [`URL: ${truncate(safeDecodeUri(s.url), MAX_URL)}`, `Title: ${truncate(collapseWhitespace(s.title), MAX_TITLE)}`, scrollLine];
}

/** Порядок заполнения бюджета: сначала видимое, затем ниже и выше экрана — ближние первыми. */
function byPriority(elements: readonly ElementInfo[]): ElementInfo[] {
  const visible = elements.filter((e) => e.zone === 'visible');
  const below = elements.filter((e) => e.zone === 'below').sort((a, b) => a.distance - b.distance);
  const above = elements.filter((e) => e.zone === 'above').sort((a, b) => a.distance - b.distance);
  return [...visible, ...below, ...above];
}

function omittedLine(n: number): string {
  return `[${n} more interactive elements not shown due to size limit]`;
}

/**
 * Превращает снимок страницы в компактный текст для модели, никогда не превышая maxChars.
 * Элементы заполняют бюджет по приоритету, но выводятся по зонам в порядке документа.
 */
export function serializePage(s: PageSnapshot, opts: SerializeOptions): SerializedPage {
  const maxChars = Math.max(0, Math.floor(opts.maxChars));
  const maxText = opts.maxTextPerElement ?? DEFAULT_MAX_TEXT;
  const textShare = opts.textShare ?? 0.2;

  const header = headerLines(s).join('\n');
  const pageText = s.text.trim();

  // Резерв под заголовки секций и строку «ещё N элементов».
  const sectionsReserve =
    SECTION_TITLES.above.length + SECTION_TITLES.visible.length + SECTION_TITLES.below.length + omittedLine(s.elements.length).length + 8;
  const textReserve = pageText ? Math.min(pageText.length + SECTION_TITLES.text.length + 2, Math.floor(maxChars * textShare)) : 0;
  const elementBudget = maxChars - header.length - sectionsReserve - textReserve;

  const lines = new Map<number, string>();
  let used = 0;
  for (const e of byPriority(s.elements)) {
    const line = serializeElement(e, maxText);
    if (used + line.length + 1 > elementBudget) continue;
    lines.set(e.index, line);
    used += line.length + 1;
  }

  const out: string[] = [header];
  if (s.elements.length === 0) {
    out.push('', SECTION_TITLES.none);
  } else {
    for (const zone of ['above', 'visible', 'below'] as const) {
      const zoneLines = s.elements.filter((e) => e.zone === zone && lines.has(e.index)).map((e) => lines.get(e.index)!);
      if (zoneLines.length > 0) out.push('', SECTION_TITLES[zone], ...zoneLines);
    }
  }
  const omitted = s.elements.length - lines.size;
  if (omitted > 0) out.push(omittedLine(omitted));

  let text = out.join('\n');
  let textTruncated = false;
  if (pageText) {
    const prefix = `\n\n${SECTION_TITLES.text}\n`;
    const room = maxChars - text.length - prefix.length;
    if (room > 20) {
      const body = truncate(pageText, room);
      textTruncated = body.length < pageText.length;
      text += prefix + body;
    } else {
      textTruncated = true;
    }
  }

  // Страховка: заголовок сам по себе может не влезть в крошечный лимит.
  if (text.length > maxChars) text = truncate(text, maxChars);

  return {
    text,
    shownIndices: s.elements.filter((e) => lines.has(e.index)).map((e) => e.index),
    omittedElements: omitted,
    textTruncated,
  };
}
