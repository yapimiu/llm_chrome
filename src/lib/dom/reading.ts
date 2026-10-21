/**
 * «Чтение» страницы: прокрутка между двумя местами в темпе человека, который читает.
 * Каждый абзац относится к одному из трёх классов:
 *  - junk — ничего про программирование, вёрстку, HTML/CSS/JS (болтовня, меню, подвал): быстро, 3–6 с на 1000 символов;
 *  - light — рядом с темой (вёрстка, цвета, страницы, браузер): 10–20 с на 1000 символов;
 *  - careful — код, селекторы, JavaScript: 60–90 с на 1000 символов.
 * Темп выбирается случайно в этих пределах для каждого абзаца; на полезном тексте есть случайные остановки.
 */

import type { ReadPace } from '../agent/actions';

/** Класс текста по теме: junk — быстро пролистать, light — читать, careful — читать медленно. */
export type TextKind = 'junk' | 'light' | 'careful';

export interface ReadSegment {
  /** Границы абзаца в координатах содержимого (от начала прокручиваемой области), px. */
  y0: number;
  y1: number;
  chars: number;
  kind: TextKind;
}

export interface ReadStep {
  /** На сколько прокрутить (px, вниз > 0), затем... */
  deltaY: number;
  /** ...сколько «читать» (мс) до следующей прокрутки. */
  waitMs: number;
}

export interface ReadPlan {
  steps: ReadStep[];
  totalMs: number;
  chars: number;
  /** Доля важного текста (по символам), 0..1. */
  carefulShare: number;
  /** Доля быстро пролистанного «мусора» (по символам), 0..1. */
  junkShare: number;
  /** Время урезано до MAX_READ_MS. */
  capped: boolean;
}

/** Секунд на 1000 символов: [мин, макс]. */
export const JUNK_SEC: readonly [number, number] = [3, 6];
export const LIGHT_SEC: readonly [number, number] = [10, 20];
export const CAREFUL_SEC: readonly [number, number] = [60, 90];
/** Пустоты без текста (картинки, отступы) пролистываются со скоростью px/с. */
const GAP_PX_PER_SEC = 220;
/** Быстрее этого абзацы не листаем, даже если в них мало символов. */
const MAX_SPEED_PX_PER_SEC = 600;
/** Один шаг прокрутки ≈ столько px (как несколько щелчков колеса). */
const STEP_PX: readonly [number, number] = [70, 130];
/** Какая доля времени уходит на остановки «задуматься» и сколько их. */
const STOP_SHARE = 0.2;
const MAX_STOPS = 8;
export const MAX_READ_MS = 30 * 60_000;

const CODE_PATTERNS: readonly RegExp[] = [
  /querySelector|getElement(s)?By|addEventListener|classList|innerHTML|textContent|console\.|document\.|window\./,
  /=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\breturn\b/,
  /<\/?[a-z][a-z0-9-]*[\s>/]/i,
  /[.#][a-z_][\w-]*\s*[{,>+~]/i,
  /\{[^{}]*:[^{}]*;[^{}]*\}/,
  /селектор|псевдокласс|javascript|джаваскрипт|джава\s*скрипт|\bjs\b/i,
];

/** Похоже ли на важный технический текст, который читают медленно. */
export function isCarefulText(text: string): boolean {
  return CODE_PATTERNS.some((re) => re.test(text));
}

/** Слова «рядом с темой»: если их нет совсем, текст — мусор для этой задачи. */
const TOPIC_WORD =
  /html|css|\bjs\b|javascript|вёрстк|верстк|вёрстан|тег|элемент|селектор|свойств|атрибут|класс|стил|\bкод|программ|разработ|браузер|сайт|страниц|пиксел|цвет|шрифт|отступ|\bблок|ссылк|кнопк|картинк|\bфон|макет|лендинг|скрипт|функци|переменн|терминал|консол|редактор|\bфайл|репозитор|\bgit|веб|интерфейс|адаптив|дизайн|\bdom\b|обработчик|событи/i;

/** Класс текста: код и селекторы — careful, тема рядом — light, иначе junk. */
export function classifyText(text: string): TextKind {
  if (isCarefulText(text)) return 'careful';
  return TOPIC_WORD.test(text) ? 'light' : 'junk';
}

const lerp = ([lo, hi]: readonly [number, number], t: number) => lo + (hi - lo) * Math.min(1, Math.max(0, t));

interface Piece {
  y0: number;
  y1: number;
  ms: number;
  kind: TextKind;
  chars: number;
}

/** Абзацы в [from, to] подряд, без дыр: пустоты между ними становятся отдельными кусками без текста. */
function pieces(segments: readonly ReadSegment[], from: number, to: number): { y0: number; y1: number; chars: number; kind: TextKind }[] {
  const sorted = segments
    .map((s) => ({ ...s, y0: Math.max(from, s.y0), y1: Math.min(to, s.y1) }))
    .filter((s) => s.y1 > s.y0)
    .sort((a, b) => a.y0 - b.y0);
  const out: { y0: number; y1: number; chars: number; kind: TextKind }[] = [];
  let at = from;
  for (const s of sorted) {
    if (s.y0 > at) out.push({ y0: at, y1: s.y0, chars: 0, kind: 'junk' });
    // Вложенные друг в друга абзацы (div в div) не читаем дважды.
    const y0 = Math.max(s.y0, at);
    if (s.y1 > y0) {
      const share = (s.y1 - y0) / (s.y1 - s.y0);
      out.push({ y0, y1: s.y1, chars: Math.round(s.chars * share), kind: s.kind });
      at = s.y1;
    }
  }
  if (at < to) out.push({ y0: at, y1: to, chars: 0, kind: 'junk' });
  return out;
}

/** Класс, по которому читаем абзац, с учётом выбранного темпа. */
function effectiveKind(kind: TextKind, pace: ReadPace): TextKind {
  if (pace === 'careful') return 'careful';
  if (pace === 'light' && kind === 'careful') return 'light';
  return kind;
}

/**
 * План чтения от from до to (координаты содержимого): список «прокрутить на N px, подождать M мс».
 * Сумма прокруток равна to − from, сумма ожиданий — общему времени чтения. «Мусор» пролистывается
 * быстро и без остановок, остановки «задуматься» бывают только на полезном тексте.
 */
export function planReading(segments: readonly ReadSegment[], from: number, to: number, pace: ReadPace, random: () => number, maxMs = MAX_READ_MS): ReadPlan {
  const parts: Piece[] = pieces(segments, from, to).map((p) => {
    const h = p.y1 - p.y0;
    const kind = p.chars === 0 ? 'junk' : effectiveKind(p.kind, pace);
    const range = kind === 'careful' ? CAREFUL_SEC : kind === 'light' ? LIGHT_SEC : JUNK_SEC;
    const byText = p.chars > 0 ? (p.chars / 1000) * lerp(range, random()) * 1000 : (h / GAP_PX_PER_SEC) * 1000;
    return { ...p, kind, ms: Math.max(byText, (h / MAX_SPEED_PX_PER_SEC) * 1000) };
  });

  const chars = parts.reduce((a, p) => a + p.chars, 0);
  const share = (kind: TextKind) => (chars ? parts.reduce((a, p) => a + (p.kind === kind ? p.chars : 0), 0) / chars : 0);
  let total = parts.reduce((a, p) => a + p.ms, 0);
  const capped = total > maxMs;
  const k = capped ? maxMs / total : 1;
  if (capped) total = maxMs;

  // Куски → шаги прокрутки: на каждый своя доля времени куска.
  const steps: (ReadStep & { kind: TextKind; base: number })[] = [];
  let shifted = 0;
  for (const p of parts) {
    const h = p.y1 - p.y0;
    const n = Math.max(1, Math.round(h / lerp(STEP_PX, random())));
    for (let i = 1; i <= n; i++) {
      const target = Math.round((h * i) / n);
      const base = ((p.ms * k) / n) * (0.7 + random() * 0.6);
      steps.push({ deltaY: target - shifted, waitMs: base, base, kind: p.kind });
      shifted = i === n ? 0 : target;
    }
  }
  const empty: ReadPlan = { steps: [], totalMs: 0, chars, carefulShare: 0, junkShare: 0, capped };
  if (steps.length === 0) return empty;

  // Время каждой группы (мусор / полезное) сохраняется; из полезного часть уходит на случайные остановки.
  const useful = steps.filter((s) => s.kind !== 'junk');
  const usefulTotal = parts.filter((p) => p.kind !== 'junk').reduce((a, p) => a + p.ms * k, 0);
  const junkTotal = total - usefulTotal;
  const junkBase = steps.filter((s) => s.kind === 'junk').reduce((a, s) => a + s.base, 0);
  const usefulBase = useful.reduce((a, s) => a + s.base, 0);
  const stopAt = new Set<number>();
  const usefulIdx = steps.flatMap((s, i) => (s.kind === 'junk' ? [] : [i]));
  if (usefulIdx.length > 0) {
    const stopCount = Math.min(MAX_STOPS, usefulIdx.length, Math.max(1, Math.round(usefulTotal / 30_000)));
    while (stopAt.size < stopCount) stopAt.add(usefulIdx[Math.floor(random() * usefulIdx.length)]!);
  }
  const weights = [...stopAt].map(() => 0.5 + random());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const stopMs = new Map([...stopAt].map((idx, i) => [idx, (usefulTotal * STOP_SHARE * weights[i]!) / weightSum]));
  const out = steps.map((s, i) => {
    const scale = s.kind === 'junk' ? (junkBase ? junkTotal / junkBase : 0) : (usefulTotal * (1 - STOP_SHARE)) / usefulBase;
    return { deltaY: s.deltaY, waitMs: Math.round(s.base * scale + (stopMs.get(i) ?? 0)) };
  });
  return { steps: out, totalMs: out.reduce((a, s) => a + s.waitMs, 0), chars, carefulShare: share('careful'), junkShare: share('junk'), capped };
}

// ——— сбор абзацев со страницы ———

export interface CollectReadOptions {
  /** Положение текстового узла во вьюпорте (px); null — не отрисован. */
  rectOf: (node: Text) => { top: number; bottom: number } | null;
  isVisible: (el: Element) => boolean;
  /** Начало координат содержимого во вьюпорте: contentY = viewportY − origin. */
  origin: number;
  from: number;
  to: number;
  maxSegments?: number;
}

const BLOCKS = 'p,li,pre,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,summary,label,div,section,article';
/** Навигация, подвал, баннеры cookie, реклама, комментарии — мусор независимо от слов в тексте. */
const CHROME_CONTEXT =
  'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[class*="cookie" i],[class*="consent" i],[class*="advert" i],[class*="promo" i],[class*="comments" i],[id*="cookie" i]';
const CODE_CONTEXT = 'pre,code,kbd,samp,.hljs,.cm-editor,.CodeMirror,.monaco-editor,[class*="code-"],[class*="-code"]';
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** Абзацы с текстом между from и to: границы, число символов и «важность» (код, селекторы). */
export function collectReadSegments(doc: Document, opts: CollectReadOptions): ReadSegment[] {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
  const blocks = new Map<Element, { y0: number; y1: number; chars: number; text: string; code: boolean; chrome: boolean }>();
  const limit = opts.maxSegments ?? 3000;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    const parent = n.parentElement;
    if (!text || !parent || SKIP.has(parent.tagName) || !opts.isVisible(parent)) continue;
    const rect = opts.rectOf(n as Text);
    if (!rect) continue;
    const y0 = rect.top - opts.origin;
    const y1 = rect.bottom - opts.origin;
    if (y1 <= opts.from || y0 >= opts.to) continue;
    const block = parent.closest(BLOCKS) ?? parent;
    const acc = blocks.get(block) ?? { y0, y1, chars: 0, text: '', code: false, chrome: !!parent.closest(CHROME_CONTEXT) };
    acc.y0 = Math.min(acc.y0, y0);
    acc.y1 = Math.max(acc.y1, y1);
    acc.chars += text.length;
    acc.text += `${text} `;
    acc.code ||= !!parent.closest(CODE_CONTEXT);
    blocks.set(block, acc);
    if (blocks.size >= limit) break;
  }
  return [...blocks.values()].map((b) => ({
    y0: b.y0,
    y1: b.y1,
    chars: b.chars,
    kind: b.code ? 'careful' : b.chrome ? 'junk' : classifyText(b.text),
  }));
}
