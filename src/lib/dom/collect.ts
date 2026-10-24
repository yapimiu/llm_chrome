import { clipShape } from './paint';
import type { ElementStyle, Geometry } from './geometry';
import { hasRules, isHiddenByRules, parseHideRules } from './hide-rules';
import { collapseWhitespace, safeDecodeUri } from './serialize';
import type { CollectStats, ElementFlag, ElementInfo, PageSnapshot, Rect, Zone } from './types';

/** Связь номера элемента с живым DOM-узлом — нужна исполнителю действий. */
export interface RegistryEntry {
  index: number;
  element: Element;
  /** Куда реально кликать: обычно сам элемент, для спрятанных checkbox/radio/file — их label. */
  target: Element;
  /** Цепочка iframe от верхнего документа до документа элемента. */
  frames: Element[];
}

export interface CollectOptions {
  /** Свои служебные элементы (оверлей, курсор), которые нельзя показывать модели. */
  ignore?: (el: Element) => boolean;
  /** Сколько символов видимого текста собирать максимум. */
  maxTextChars?: number;
  /** Лимит обхода узлов — защита от гигантских DOM. */
  maxNodes?: number;
  /** Если передан, сюда пишется решение по каждому обойдённому элементу (для диагностики). */
  trace?: Map<Element, TraceVerdict>;
  /** «Скрыть от модели» из заметки для сайта: строки-правила (текст или `css: селектор`, см. hide-rules.ts). */
  hideNames?: readonly string[];
  /** Правила кнопки «Далее» из заметки сайта (текст или `css:`): такие элементы получают пометку next. */
  nextNames?: readonly string[];
  /**
   * Сбор внутри iframe с другого сайта: где этот документ лежит в верхней странице.
   * offset — сдвиг вьюпорта фрейма, clip — его видимая область, viewport — размер вьюпорта
   * верхней страницы (всё в её координатах). Без них документ считается верхним.
   */
  frame?: { offset: { x: number; y: number }; clip: Rect; viewport: { width: number; height: number } };
  /** Номера начинаются с indexBase + 1 — чтобы номера из разных фреймов не пересекались. */
  indexBase?: number;
}

/** Почему сборщик включил или отбросил элемент. */
export type TraceVerdict =
  | { kind: 'accepted'; index: number }
  /** why — чем именно скрыт (обрезан предком, прозрачен, внутри aria-hidden); без него — CSS/размер. */
  | { kind: 'hidden'; why?: string }
  | { kind: 'offscreen' }
  | { kind: 'covered'; by: Element | null }
  | { kind: 'too-big' }
  /** Безымянная обёртка (tooltip-wrapper и т.п.) вокруг другого элемента — показан вложенный. */
  | { kind: 'wrapper' }
  | { kind: 'not-interactive'; cursor: string; parentCursor: string; clickableAncestor: ClickableAncestor }
  | { kind: 'skipped'; reason: 'tag' | 'ignored' | 'inert' | 'display-none' | 'user-hidden' | 'locked' };

/**
 * Есть ли кликабельный предок и какой. Внутри семантического (a, button, role=button)
 * вложенные кликабельные — это его части. Внутри эвристического (div с cursor:pointer)
 * настоящие кнопки и ссылки сохраняем: у карточки и кнопки в ней разные действия.
 */
export type ClickableAncestor = 'none' | 'heuristic' | 'semantic';

export interface CollectResult {
  snapshot: PageSnapshot;
  registry: RegistryEntry[];
  /** Что прокручивать действием scroll: внутренний контейнер SPA или null — окно. */
  scroller: Element | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title']);
/** Внутрь этих элементов не заходим: их содержимое — значение самого контрола. */
const LEAF_CONTROLS = new Set(['input', 'textarea', 'select', 'svg', 'video', 'audio', 'canvas']);
const CONTROL_ROLES = new Set(['checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton']);
const CLICK_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'gridcell']);
/** Типы input, у которых показываем value. */
/** Теги, у которых имеет смысл проверять текстовые правила «Скрыть от модели» при сборе текста. */
const TEXT_RULE_TARGET = /^(a|button|summary|input|select|textarea|label)$/;

const NO_VALUE_INPUTS = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file']);
const BUTTON_INPUTS = new Set(['submit', 'button', 'reset']);

type Kind = 'control' | 'clickable';

interface Detected {
  kind: Kind;
  /** Распознан по тегу/роли, а не по косвенным признакам (cursor, onclick, tabindex). */
  semantic: boolean;
  /** Для label: спрятанный переключатель, который она представляет (показываем его, кликаем label). */
  control?: Element;
  /** Единственный признак кликабельности — tabindex (часто это лишь подсказка по фокусу). */
  tabindexOnly?: boolean;
  /** Редактор кода: показываем одним полем, кликаем в область кода. */
  editor?: CodeEditorSpec;
}

/**
 * Редакторы кода рисуют текст обычными div, а ввод принимают спрятанным textarea или
 * contenteditable-слоем. Для модели это одно поле: код — в тексте, ввод — клик в область кода.
 */
interface CodeEditorSpec {
  rootClass: string;
  inputArea: string;
  line: string;
}

const CODE_EDITORS: readonly CodeEditorSpec[] = [
  { rootClass: 'CodeMirror', inputArea: '.CodeMirror-lines', line: '.CodeMirror-line' },
  { rootClass: 'cm-editor', inputArea: '.cm-content', line: '.cm-line' },
  { rootClass: 'monaco-editor', inputArea: '.view-lines', line: '.view-line' },
  { rootClass: 'ace_editor', inputArea: '.ace_content', line: '.ace_line' },
];

export function codeEditorSpec(el: Element): CodeEditorSpec | null {
  return CODE_EDITORS.find((s) => el.classList.contains(s.rootClass)) ?? null;
}

/** Строки кода редактора (видимые — большие файлы редакторы рисуют частями). */
export function codeEditorLines(el: Element): string[] | null {
  const spec = codeEditorSpec(el);
  if (!spec) return null;
  return Array.from(el.querySelectorAll(spec.line)).map((l) => (l.textContent ?? '').replace(/\u200b/g, ''));
}

/** Переключатели, которые сайты прячут и рисуют вместо них свою label. */
const LABELLED_TOGGLE_TYPES = new Set(['checkbox', 'radio', 'file']);

/** Эвристически кликабельные блоки крупнее этой доли вьюпорта — обёртки страницы, а не кнопки. */
const MAX_HEURISTIC_AREA = 0.4;
/** Внутренний контейнер прокрутки считаем главным, если он не меньше этой доли вьюпорта. */
const MIN_SCROLLER_AREA = 0.3;
/** Строчные элементы: их текст — часть абзаца, а не отдельная строка. */
const INLINE_DISPLAYS = new Set(['inline', 'contents']);

/** Часть строки текста: inline, inline-block, inline-flex… (термины словаря, бейджи). */
function isInlineLike(display: string): boolean {
  return display === 'contents' || display.startsWith('inline');
}
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

interface WalkCtx {
  offset: { x: number; y: number };
  /** Видимая область текущего документа в координатах верхнего (пересечение iframe'ов). */
  clip: Rect;
  frames: Element[];
  clickableAncestor: ClickableAncestor;
  parentCursor: string;
  inShadow: boolean;
  /** Предок приклеен к экрану (position: fixed/sticky) или это окно поверх страницы. */
  pinned?: boolean;
  /** Предок — приклеенная панель (fixed/sticky, не окно): меню, кнопка чата, панель инструментов. */
  panel?: boolean;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function isEditableHost(el: Element): boolean {
  const v = attr(el, 'contenteditable');
  if (v === null || v === 'false') return false;
  const parentEditable = el.parentElement?.closest('[contenteditable]:not([contenteditable="false"])');
  return !parentEditable;
}

function isCodeBlock(el: Element): boolean {
  const tag = el.localName;
  return tag === 'pre' || tag === 'code' || el.querySelector('pre, code') !== null;
}

function detectInteractive(el: Element, style: ElementStyle, ctx: WalkCtx): Detected | null {
  const cursor = style.cursor;
  const tag = el.localName;
  if (tag === 'input') return (el as HTMLInputElement).type === 'hidden' ? null : { kind: 'control', semantic: true };
  if (tag === 'textarea' || tag === 'select' || isEditableHost(el)) return { kind: 'control', semantic: true };
  const role = attr(el, 'role')?.toLowerCase();
  if (role && CONTROL_ROLES.has(role)) return { kind: 'control', semantic: true };

  // span внутри ссылки — часть ссылки, кликнет внешний.
  if (ctx.clickableAncestor === 'semantic') return null;
  if (tag === 'button' || tag === 'summary' || (tag === 'a' && el.hasAttribute('href'))) return { kind: 'clickable', semantic: true };
  if (role && CLICK_ROLES.has(role)) return { kind: 'clickable', semantic: true };

  if (ctx.clickableAncestor === 'heuristic' || tag === 'body' || tag === 'html') return null;
  // Код, который «кликается» ради копирования или подсказки, — содержимое страницы, а не кнопка:
  // в списке элементов маленькая модель принимает его за навигацию. Его текст остаётся в тексте страницы.
  if (isCodeBlock(el)) return null;
  if (el.hasAttribute('onclick')) return { kind: 'clickable', semantic: false };
  const tabindex = attr(el, 'tabindex');
  // tabindex на прокручиваемом блоке — это доступность с клавиатуры (scroll region), а не кнопка.
  if (tabindex !== null && Number(tabindex) >= 0 && !SCROLLABLE_OVERFLOW.has(style.overflowY)) {
    return { kind: 'clickable', semantic: false, tabindexOnly: cursor !== 'pointer' || ctx.parentCursor === 'pointer' };
  }
  // SPA вешают обработчики через делегирование — единственный внешний признак это cursor: pointer.
  if (cursor === 'pointer' && ctx.parentCursor !== 'pointer') return { kind: 'clickable', semantic: false };
  return null;
}

/**
 * Видимый текст поддерева (для имён элементов), с ранней остановкой по limit.
 * skipNested — не брать текст вложенных кнопок/ссылок: у них свои номера, дубль только тратит токены.
 */
function visibleText(root: Element, geom: Geometry, limit = 200, skipNested = false): string {
  // Текстовые узлы склеиваем как есть (подсветка синтаксиса режет `<a href>` на десяток span),
  // а пробел ставим только на границах блоков.
  let out = '';
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (out.length >= limit) return;
      if (child.nodeType === TEXT_NODE) {
        out += child.textContent ?? '';
      } else if (child.nodeType === ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.localName;
        if (SKIP_TAGS.has(tag) || tag === 'select' || tag === 'textarea' || tag === 'input') continue;
        if (el.hasAttribute('hidden')) continue;
        const display = geom.style(el).display;
        if (display === 'none') continue;
        if (skipNested && (tag === 'button' || (tag === 'a' && el.hasAttribute('href')))) continue;
        const block = !INLINE_DISPLAYS.has(display);
        if (block) out += ' ';
        visit(el);
        if (block) out += ' ';
      }
    }
  };
  visit(root);
  return collapseWhitespace(out);
}

/** Похож на отдельный кликабельный элемент (а не на кусок абзаца). */
function looksInteractive(el: Element, cursor: string, parentCursor: string): boolean {
  const tag = el.localName;
  // Подпись поля — это текст (имя поля), даже если по ней можно кликнуть.
  if (tag === 'label') return false;
  const role = attr(el, 'role')?.toLowerCase();
  return (
    tag === 'button' ||
    (tag === 'a' && el.hasAttribute('href')) ||
    (!!role && (CLICK_ROLES.has(role) || CONTROL_ROLES.has(role))) ||
    el.hasAttribute('onclick') ||
    Number(attr(el, 'tabindex') ?? -1) >= 0 ||
    (cursor === 'pointer' && parentCursor !== 'pointer')
  );
}

function textOfIds(el: Element, ids: string, geom: Geometry): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => (id ? root.getElementById(id) : null))
    .filter((n): n is HTMLElement => n !== null)
    .map((n) => visibleText(n, geom))
    .join(' ');
}

function labelsOf(el: Element): Element[] {
  const labels = (el as HTMLInputElement).labels;
  return labels ? Array.from(labels) : [];
}

function fallbackName(el: Element): string {
  const title = attr(el, 'title');
  if (title?.trim()) return title;
  const img = el.querySelector('img[alt]');
  const alt = img ? attr(img, 'alt') : null;
  if (alt?.trim()) return alt;
  const svgTitle = el.querySelector('svg title');
  if (svgTitle?.textContent?.trim()) return svgTitle.textContent;
  return '';
}

export function accessibleName(el: Element, geom: Geometry): string {
  const labelledBy = attr(el, 'aria-labelledby');
  if (labelledBy) {
    const t = textOfIds(el, labelledBy, geom);
    if (t) return t;
  }
  const ariaLabel = attr(el, 'aria-label');
  if (ariaLabel?.trim()) return collapseWhitespace(ariaLabel);

  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = tag === 'input' ? (el as HTMLInputElement).type : '';
    if (BUTTON_INPUTS.has(type)) return (el as HTMLInputElement).value || type;
    if (type === 'image') return attr(el, 'alt') ?? '';
    const fromLabels = labelsOf(el)
      .map((l) => visibleText(l, geom))
      .filter(Boolean)
      .join(' ');
    return fromLabels || collapseWhitespace(attr(el, 'title') ?? '');
  }

  const text = visibleText(el, geom, 200, true);
  return text || collapseWhitespace(fallbackName(el));
}

const TOGGLE_ROLES = new Set(['radio', 'checkbox', 'switch', 'option', 'menuitemradio', 'menuitemcheckbox']);
/** Другие поля ввода в контейнере — значит, его текст относится не только к нашему элементу. */
const FORM_CONTROLS =
  'input:not([type=hidden]),select,textarea,[role=radio],[role=checkbox],[role=switch],[role=option],[contenteditable]:not([contenteditable=false])';
const CONTEXT_DEPTH = 4;

function isToggle(el: Element): boolean {
  const type = el.localName === 'input' ? (el as HTMLInputElement).type : '';
  const role = attr(el, 'role')?.toLowerCase() ?? '';
  return type === 'radio' || type === 'checkbox' || TOGGLE_ROLES.has(role);
}

/**
 * Подпись безымянного переключателя из его «строки»: кружок варианта в тесте часто стоит
 * отдельно от текста варианта (блок кода, абзац). Поднимаемся к ближайшему предку с текстом,
 * пока в нём нет других полей ввода — иначе текст принадлежал бы и чужим вариантам.
 */
function contextName(el: Element, geom: Geometry): string {
  let node: Element | null = el;
  for (let depth = 0; depth < CONTEXT_DEPTH; depth++) {
    node = node.parentElement ?? (node.getRootNode() as Partial<ShadowRoot>).host ?? null;
    if (!node || node.localName === 'body') return '';
    const others = Array.from(node.querySelectorAll(FORM_CONTROLS)).filter((o) => o !== el && !el.contains(o) && !o.contains(el));
    if (others.length > 0) return '';
    const text = visibleText(node, geom, 120, true);
    if (text) return text;
  }
  return '';
}

function shortHref(el: Element): string | undefined {
  const raw = attr(el, 'href');
  if (raw === null || raw === '' || raw === '#') return undefined;
  let url: URL;
  let base: URL;
  try {
    base = new URL(el.ownerDocument.baseURI);
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol === 'javascript:') return undefined;
  if (url.origin === base.origin) return safeDecodeUri(`${url.pathname}${url.search}${url.hash}`);
  return safeDecodeUri(`${url.host}${url.pathname}${url.search}`);
}

function isMasked(el: Element): boolean {
  const type = (el as HTMLInputElement).type;
  const autocomplete = attr(el, 'autocomplete') ?? '';
  return type === 'password' || /\bcc-/.test(autocomplete);
}

const SECRET_FIELDS = 'input[type=password], input[autocomplete^="cc-"], input[autocomplete*=" cc-"]';
const SEARCH_HINT = /search|поиск|найти|искать/i;

/** Признаки для оценки риска (см. ElementFlag). */
/** Кнопка без текста: одна картинка/svg/символ-иконка, без букв и цифр и без полей ввода внутри. */
export function isIconOnly(el: Element): boolean {
  if (/[\p{L}\p{N}]/u.test(el.textContent ?? '')) return false;
  if (el.matches('input, select, textarea') || el.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea')) return false;
  return true;
}

export function riskFlags(el: Element): ElementFlag[] {
  const flags: ElementFlag[] = [];
  const tag = el.localName;
  const type = tag === 'input' ? (el as HTMLInputElement).type : tag === 'button' ? (el as HTMLButtonElement).type : '';
  if (tag === 'input' && isMasked(el)) flags.push('secret');
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (form && (type === 'submit' || type === 'image')) flags.push('submit');
  if (form?.querySelector(SECRET_FIELDS)) flags.push('form-secret');
  const role = attr(el, 'role')?.toLowerCase() ?? '';
  const hints = [attr(el, 'placeholder'), attr(el, 'aria-label'), attr(el, 'name'), form?.getAttribute('action'), form?.getAttribute('role')].join(' ');
  if (type === 'search' || role === 'searchbox' || el.closest('[role=search]') || ((tag === 'input' || role === 'combobox') && SEARCH_HINT.test(hints))) {
    flags.push('search');
  }
  if (tag === 'textarea' || isEditableHost(el)) flags.push('message');
  return flags;
}

function describe(el: Element, geom: Geometry): Omit<ElementInfo, 'index' | 'zone' | 'distance' | 'rect'> {
  const tag = el.localName;
  const role = attr(el, 'role')?.toLowerCase() || undefined;
  const info: Omit<ElementInfo, 'index' | 'zone' | 'distance' | 'rect'> = {
    tag,
    name: accessibleName(el, geom),
    attrs: [],
    states: [],
  };
  if (role) info.role = role;

  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    const type = tag === 'input' ? input.type : '';
    if (type) info.type = type;
    const placeholder = attr(el, 'placeholder');
    if (placeholder && placeholder !== info.name) info.attrs.push(['placeholder', placeholder]);
    if (!NO_VALUE_INPUTS.has(type)) {
      const value = input.value ?? '';
      // Пароли и номера карт модели не показываем.
      info.attrs.push(['value', isMasked(el) && value ? '•••' : value]);
    }
    if ((type === 'checkbox' || type === 'radio') && input.checked) info.states.push('checked');
    if (input.readOnly) info.states.push('readonly');
  } else if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const options = Array.from(select.options);
    const selected = options.filter((o) => o.selected).map((o) => collapseWhitespace(o.text));
    info.attrs.push(['value', selected.join(', ')]);
    info.options = options.slice(0, 8).map((o) => collapseWhitespace(o.text));
    info.optionsTotal = options.length;
  } else if (isEditableHost(el)) {
    info.contentEditable = true;
    const value = visibleText(el, geom, 300);
    if (attr(el, 'aria-label')) info.attrs.push(['value', value]);
    else info.name = value;
  } else if (tag === 'a') {
    const href = shortHref(el);
    if (href) info.attrs.push(['href', href]);
  }

  if (!info.name && isToggle(el)) info.name = contextName(el, geom);

  if (!info.name && info.attrs.length === 0) {
    // Безымянная иконка: дадим модели хоть какую-то зацепку.
    const id = attr(el, 'id');
    const cls = (attr(el, 'class') ?? '').split(/\s+/).find((c) => c.length > 2);
    const hint = id || cls;
    if (hint) info.attrs.push(['hint', hint]);
  }

  if ((el as HTMLButtonElement).disabled === true || attr(el, 'aria-disabled') === 'true') info.states.push('disabled');
  if (attr(el, 'aria-checked') === 'true' && !info.states.includes('checked')) info.states.push('checked');
  if (attr(el, 'aria-selected') === 'true') info.states.push('selected');
  const expanded = attr(el, 'aria-expanded');
  if (expanded === 'true') info.states.push('expanded');
  else if (expanded === 'false') info.states.push('collapsed');
  const flags = riskFlags(el);
  if (flags.length) info.flags = flags;
  const submitName = formSubmitName(el, geom);
  if (submitName) info.formSubmit = submitName;
  return info;
}

/** Текст кнопки, которой Enter в этом поле отправит форму: так форму можно отправить и без клика по кнопке. */
function formSubmitName(el: Element, geom: Geometry): string {
  if (el.localName !== 'input' || NO_VALUE_INPUTS.has((el as HTMLInputElement).type)) return '';
  const form = (el as HTMLInputElement).form;
  if (!form) return '';
  const button = Array.from(form.elements).find(
    (e) => (e.localName === 'button' && (e as HTMLButtonElement).type === 'submit') || (e.localName === 'input' && ['submit', 'image'].includes((e as HTMLInputElement).type)),
  );
  return button ? collapseWhitespace(accessibleName(button, geom)) : '';
}

function describeEditor(el: Element): Omit<ElementInfo, 'index' | 'zone' | 'distance' | 'rect'> {
  const lines = codeEditorLines(el) ?? [];
  const label = attr(el, 'aria-label') ?? el.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
  return { tag: 'code-editor', name: collapseWhitespace(label), attrs: [['lines', String(lines.length)]], states: [] };
}

function translate(r: Rect, o: { x: number; y: number }): Rect {
  return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
}

const CHOICE_ROLES = new Set(['radio', 'checkbox', 'switch', 'option', 'menuitemradio', 'menuitemcheckbox']);

/** Вариант ответа (radio/checkbox и их роли), который нельзя изменить: disabled или aria-disabled. */
function isLockedChoice(el: Element, info: { states: string[]; type?: string; role?: string }): boolean {
  if (!info.states.includes('disabled')) return false;
  const type = el.localName === 'input' ? (el as HTMLInputElement).type : '';
  return type === 'radio' || type === 'checkbox' || CHOICE_ROLES.has(info.role ?? '');
}

/** Видимая часть элемента или зона за пределами экрана; null — недостижим (карусель, скрытый скролл iframe). */
function classify(r: Rect, clip: Rect, view: Rect): { zone: Zone; distance: number; visiblePart?: Rect } | null {
  const area = intersect(clip, view);
  const visiblePart = area ? intersect(r, area) : null;
  if (visiblePart) return { zone: 'visible', distance: 0, visiblePart };
  const top = Math.max(view.y, clip.y);
  const bottom = Math.min(view.y + view.height, clip.y + clip.height);
  if (r.y + r.height <= top) return { zone: 'above', distance: top - (r.y + r.height) };
  if (r.y >= bottom) return { zone: 'below', distance: r.y - bottom };
  return null;
}

/** Попадает ли клик в точку в сам элемент (а не в перекрывающий его оверлей). */
export function hitsTarget(hit: Element | null, el: Element, target: Element): boolean {
  if (!hit) return false;
  return hit === target || target.contains(hit) || el.contains(hit) || hit.contains(target);
}

type TextSeg = string | Element;

/** Подставляет номера элементов в текст: ссылки на неотобранные элементы пропадают. */
function renderText(lines: readonly TextSeg[][], registry: readonly RegistryEntry[], notes: ReadonlyMap<Element, string> = new Map()): string {
  const indexOf = new Map<Element, number>();
  for (const r of registry) {
    indexOf.set(r.element, r.index);
    indexOf.set(r.target, r.index);
  }
  return lines
    .map((line) => {
      const seen = new Set<number>();
      let s = '';
      for (const seg of line) {
        if (typeof seg === 'string') {
          s += seg;
          continue;
        }
        const i = indexOf.get(seg);
        if (i !== undefined && !seen.has(i)) {
          seen.add(i);
          s += ` [${i}] `;
        } else if (i === undefined && notes.has(seg) && !s.endsWith(notes.get(seg)!)) {
          s += notes.get(seg)!;
        }
      }
      // Пробелы от границ inline-block и номеров не нужны перед знаками препинания.
      return collapseWhitespace(s).replace(/\s+([.,;:!?)»])/g, '$1');
    })
    .filter(Boolean)
    .join('\n');
}

/** contains() через границы shadow DOM. */
function composedContains(ancestor: Element, node: Element): boolean {
  for (let n: Element | null = node; n; n = n.parentElement ?? (n.getRootNode() as Partial<ShadowRoot>).host ?? null) {
    if (n === ancestor) return true;
  }
  return false;
}

function isNameless(e: ElementInfo): boolean {
  return !e.name && e.attrs.every(([k]) => k === 'hint');
}

/** Цепочка iframe (от верхнего документа) до документа элемента. */
export function framesOf(el: Element): Element[] {
  const frames: Element[] = [];
  let win = el.ownerDocument.defaultView;
  while (win && win !== win.parent) {
    let frame: Element | null;
    try {
      frame = win.frameElement;
    } catch {
      break;
    }
    if (!frame) break;
    frames.unshift(frame);
    win = frame.ownerDocument.defaultView;
  }
  return frames;
}

/** Прямоугольник цели в координатах верхнего вьюпорта — пересчитывается на лету (скролл). */
export function topRect(entry: RegistryEntry, geom: Geometry): Rect {
  let offset = { x: 0, y: 0 };
  for (const frame of entry.frames) {
    const box = geom.frameContentBox(frame);
    offset = { x: offset.x + box.x, y: offset.y + box.y };
  }
  // Строчный элемент на несколько строк: рамка — строка, которая видна, а не охват всего абзаца.
  const frags = geom.fragments?.(entry.target) ?? [];
  if (frags.length > 1) {
    const vp = geom.viewport();
    const screen = { x: 0, y: 0, width: vp.width, height: vp.height };
    return translate(frags.find((f) => intersect(f, screen)) ?? frags[0]!, offset);
  }
  return translate(geom.rect(entry.target), offset);
}

export function collectSnapshot(doc: Document, geom: Geometry, opts: CollectOptions = {}): CollectResult {
  const maxNodes = opts.maxNodes ?? 30_000;
  const maxTextChars = opts.maxTextChars ?? 20_000;
  const vp = geom.viewport();
  const topVp = opts.frame?.viewport ?? vp;
  const view: Rect = { x: 0, y: 0, width: topVp.width, height: topVp.height };

  let elements: ElementInfo[] = [];
  let registry: RegistryEntry[] = [];
  /** Распознан ли элемент по тегу/роли — параллельно elements. */
  const semantic: boolean[] = [];
  const tabindexOnly: boolean[] = [];
  let scroller: { el: Element; area: number } | null = null;
  const stats: CollectStats = { textTruncated: false, nodesVisited: 0, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 };
  const hideRules = parseHideRules(opts.hideNames ?? []);
  const nextRules = parseHideRules(opts.nextNames ?? []);
  const hiding = hasRules(hideRules);
  const hiddenCache = new Map<Element, boolean>();
  /**
   * Скрыт ли элемент заметкой «Скрыть от модели». CSS-правила проверяются у любого элемента,
   * текстовые — только у похожих на кнопки/ссылки/поля (имя считать дорого).
   */
  const userHidden = (el: Element, interactive: boolean): boolean => {
    if (!hiding) return false;
    const cached = hiddenCache.get(el);
    if (cached !== undefined) return cached;
    let hidden = hideRules.selectors.length > 0 && isHiddenByRules(el, '', { texts: [], selectors: hideRules.selectors });
    if (!hidden && hideRules.texts.length > 0 && (interactive || TEXT_RULE_TARGET.test(el.localName) || el.hasAttribute('role') || el.hasAttribute('onclick'))) {
      hidden = isHiddenByRules(el, accessibleName(el, geom), { texts: hideRules.texts, selectors: [] });
    }
    hiddenCache.set(el, hidden);
    return hidden;
  };
  /** Строки текста: куски текста и ссылки на элементы (номера известны только после обхода). */
  const textLines: TextSeg[][] = [];
  const linePreviews: string[] = [];
  let textLen = 0;

  const trace = opts.trace;
  const vpArea = vp.width * vp.height;

  /** Возвращает false, если элемент отброшен как гигантская эвристическая обёртка. */
  /** Переключатели, уже показанные модели через свою label (и наоборот) — чтобы не было дублей. */
  const representedControls = new Set<Element>();
  /** Заблокированные варианты ответа: в списке их нет, в тексте — пометка (см. isLockedChoice). */
  const lockedNotes = new Map<Element, string>();
  const representedLabels = new Set<Element>();

  /** Спрятанный checkbox/radio/file, который рисует эта label; null — label обычная. */
  const hiddenToggleOf = (label: Element): Element | null => {
    const control = (label as HTMLLabelElement).control;
    if (!control || control.localName !== 'input' || !LABELLED_TOGGLE_TYPES.has((control as HTMLInputElement).type)) return null;
    if (representedControls.has(control)) return null;
    if (geom.style(control).display !== 'none' && geom.isVisible(control)) {
      const r = geom.rect(control);
      if (r.width > 1 && r.height > 1) return null;
    }
    return control;
  };

  const labelsVisibleControl = (label: Element): boolean => {
    const control = (label as HTMLLabelElement).control;
    return !!control && ['input', 'select', 'textarea'].includes(control.localName);
  };

  const addCandidate = (el: Element, detected: Detected, ctx: WalkCtx): boolean => {
    const own = geom.rect(el);
    if (!detected.semantic && own.width * own.height > vpArea * MAX_HEURISTIC_AREA) {
      trace?.set(el, { kind: 'too-big' });
      return false;
    }

    // Куда кликать: сам элемент, а для input — ещё и его подписи. Кастомные checkbox/radio
    // прячут input (display:none, 1px-обёртка) или перекрывают его иконкой и рисуют label.
    const editorArea = detected.editor ? el.querySelector(detected.editor.inputArea) : null;
    const targets = editorArea ? [editorArea, el] : [el, ...(el.localName === 'input' ? labelsOf(el) : [])];
    let failure: Extract<TraceVerdict, { kind: 'hidden' | 'offscreen' | 'covered' }> | null = null;
    let chosen: { target: Element; rect: Rect; place: NonNullable<ReturnType<typeof classify>> } | null = null;
    for (const t of targets) {
      const local = t === el ? own : geom.rect(t);
      if (!geom.isVisible(t) || local.width <= 1 || local.height <= 1) {
        failure ??= { kind: 'hidden' };
        continue;
      }
      // Нарисован ли на самом деле: свёрнутый блок, слайд за краем карусели, затухшая кнопка остаются в DOM.
      const paint = geom.paint?.(t);
      if (paint && !paint.painted) {
        failure ??= { kind: 'hidden', why: paint.why };
        continue;
      }
      // Строчный элемент на несколько строк — несколько прямоугольников; общий охватывает чужой текст.
      const frags = geom.fragments?.(t) ?? [];
      const shapes = (frags.length > 1 ? frags : [local]).map((s) => (paint ? clipShape(s, paint.clip) : s)).filter((s): s is Rect => s !== null);
      if (shapes.length === 0) {
        failure ??= { kind: 'hidden', why: 'clipped by a collapsed or hidden container' };
        continue;
      }
      for (const shape of shapes) {
        const rect = translate(shape, ctx.offset);
        const place = classify(rect, ctx.clip, view);
        if (!place) {
          failure ??= { kind: 'offscreen' };
          continue;
        }
        if (place.visiblePart) {
          const cx = place.visiblePart.x + place.visiblePart.width / 2 - ctx.offset.x;
          const cy = place.visiblePart.y + place.visiblePart.height / 2 - ctx.offset.y;
          const hit = geom.hitTest(t.getRootNode() as Document | ShadowRoot, cx, cy);
          if (!hitsTarget(hit, el, t)) {
            failure ??= { kind: 'covered', by: hit };
            continue;
          }
        }
        chosen = { target: t, rect, place };
        break;
      }
      if (chosen) break;
    }
    if (!chosen) {
      const f = failure ?? { kind: 'hidden' as const };
      stats[f.kind === 'hidden' ? 'hidden' : f.kind === 'offscreen' ? 'offscreen' : 'covered']++;
      trace?.set(el, f);
      return true;
    }
    const { target, rect, place } = chosen;
    if (target !== el) representedLabels.add(target);

    // label спрятанного переключателя показываем как сам переключатель (с его checked), кликаем label.
    const subject = detected.control ?? el;
    const described = detected.editor ? describeEditor(el) : describe(subject, geom);
    // Заблокированный вариант ответа (тест уже пройден): нажать нельзя, модель жала бы его снова и снова.
    // В список не попадает, а в тексте страницы остаётся пометка, какой вариант выбран.
    if (isLockedChoice(subject, described)) {
      const note = described.states.includes('checked') ? ' (✓ chosen, locked) ' : '';
      for (const n of [el, subject, target]) lockedNotes.set(n, note);
      trace?.set(el, { kind: 'skipped', reason: 'locked' });
      if (detected.control) representedControls.add(detected.control);
      if (target !== el) representedControls.add(el);
      return true;
    }
    const index = elements.length + 1;
    const info: ElementInfo = { ...described, index, zone: place.zone, distance: Math.round(place.distance), rect };
    if (hasRules(nextRules) && (isHiddenByRules(el, described.name, nextRules) || (subject !== el && isHiddenByRules(subject, described.name, nextRules)))) {
      info.next = true;
    }
    if (ctx.frames.length > 0 || opts.frame) info.inFrame = true;
    if (ctx.pinned) info.pinned = true;
    if (ctx.inShadow) info.inShadow = true;
    elements.push(info);
    registry.push({ index, element: subject, target, frames: ctx.frames });
    semantic.push(detected.semantic);
    tabindexOnly.push(!!detected.tabindexOnly);
    trace?.set(el, { kind: 'accepted', index });
    if (detected.control) {
      representedControls.add(detected.control);
      trace?.set(detected.control, { kind: 'accepted', index });
    }
    if (target !== el) representedControls.add(el);
    return true;
  };

  /**
   * Строчный текст блока: свои текстовые узлы и строчные потомки (b, code, ссылки внутри абзаца)
   * до вложенных блоков. Слово-элемент внутри фразы («атрибут — target. Он…») остаётся в тексте,
   * а блок, состоящий только из ссылок/кнопок (пункт меню), текста не даёт — они и так в списке.
   */
  const inlineFlow = (el: Element, parentCursor: string): { segs: TextSeg[]; plain: boolean } => {
    const segs: TextSeg[] = [];
    let plain = false;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        const t = child.textContent ?? '';
        segs.push(t);
        if (t.trim()) plain = true;
      } else if (child.nodeType === ELEMENT_NODE) {
        const c = child as Element;
        if (SKIP_TAGS.has(c.localName) || opts.ignore?.(c) || c.hasAttribute('hidden') || userHidden(c, false)) {
          segs.push(' ');
          continue;
        }
        // Поля ввода и вложенные блоки (кнопки) — только место в тексте: «Как вам задача? [21] [22]».
        if (LEAF_CONTROLS.has(c.localName)) {
          segs.push(' ', c, ' ');
          continue;
        }
        const st = geom.style(c);
        if (st.display === 'none') continue;
        // Блоки и кнопки (inline-block) — только номер; их текст — отдельной строкой или в списке элементов.
        const strictInline = INLINE_DISPLAYS.has(st.display);
        if (!isInlineLike(st.display) || (!strictInline && looksInteractive(c, st.cursor, parentCursor))) {
          segs.push(' ', c, ' ');
          continue;
        }
        const inner = inlineFlow(c, st.cursor);
        const pad = strictInline ? '' : ' ';
        segs.push(pad, c, ...inner.segs, pad);
        if (inner.plain && !looksInteractive(c, st.cursor, parentCursor)) plain = true;
      }
    }
    return { segs, plain };
  };

  /** selfRef — блок сам интерактивен (карточка): строка начнётся с его номера. */
  const addBlockText = (el: Element, cursor: string, ctx: WalkCtx, selfRef: boolean): void => {
    if (textLen >= maxTextChars) { stats.textTruncated = true; return; }
    const flow = inlineFlow(el, cursor);
    if (!flow.plain) return;
    const preview = collapseWhitespace(flow.segs.filter((s): s is string => typeof s === 'string').join(''));
    if (!preview || !geom.isVisible(el)) return;
    const rect = translate(geom.rect(el), ctx.offset);
    const area = intersect(ctx.clip, view);
    if (!area || !intersect(rect, area)) return;
    if (linePreviews[linePreviews.length - 1] === preview) return;
    textLines.push(selfRef ? [el, ' ', ...flow.segs] : flow.segs);
    linePreviews.push(preview);
    textLen += preview.length + 1;
  };

  const walkChildren = (parent: ParentNode, ctx: WalkCtx): void => {
    for (const child of Array.from(parent.children)) {
      if (stats.nodesVisited >= maxNodes) {
        stats.walkTruncated = true;
        return;
      }
      visit(child, ctx);
    }
  };

  /**
   * Панель, приклеенная к экрану (боковое меню, кнопка чата), или окно поверх страницы.
   * Обёртка на весь экран (fixed-раскладка приложения, затемнение под окном) — не панель:
   * иначе всё содержимое страницы оказалось бы «приклеенным».
   */
  const isDialogBox = (el: Element): boolean =>
    el.localName === 'dialog' || el.getAttribute('aria-modal') === 'true' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog';
  const isPanelBox = (el: Element, position: string | undefined): boolean => {
    if (position !== 'fixed' && position !== 'sticky') return false;
    if (isDialogBox(el)) return false;
    const r = geom.rect(el);
    return !(r.width >= vp.width * 0.9 && r.height >= vp.height * 0.9);
  };
  const inFrameDoc = !!opts.frame;

  const visit = (el: Element, ctx: WalkCtx): void => {
    stats.nodesVisited++;
    const tag = el.localName;
    const skip = SKIP_TAGS.has(tag) ? 'tag' : opts.ignore?.(el) ? 'ignored' : el.hasAttribute('inert') ? 'inert' : null;
    if (skip) {
      trace?.set(el, { kind: 'skipped', reason: skip });
      return;
    }
    const style = geom.style(el);
    if (style.display === 'none') {
      trace?.set(el, { kind: 'skipped', reason: 'display-none' });
      return;
    }
    // «Скрыть от модели» по CSS-селектору: элемент вырезается целиком, с текстом и содержимым.
    if (hideRules.selectors.length && userHidden(el, false)) {
      stats.userHidden++;
      trace?.set(el, { kind: 'skipped', reason: 'user-hidden' });
      return;
    }

    let detected: Detected | null;
    if (representedControls.has(el) || representedLabels.has(el)) {
      detected = null; // уже показан модели через свою пару input/label
    } else {
      const hiddenControl = tag === 'label' ? hiddenToggleOf(el) : null;
      const editor = codeEditorSpec(el);
      if (editor) detected = { kind: 'control', semantic: true, editor };
      else if (hiddenControl) detected = { kind: 'control', semantic: true, control: hiddenControl };
      // Подпись видимого поля/кружка — не отдельный элемент: модель увидит само поле с этой подписью.
      else if (tag === 'label' && labelsVisibleControl(el)) detected = null;
      else detected = detectInteractive(el, style, ctx);
    }
    // «Скрыть от модели» по тексту: модель не видит ни элемента, ни его текста, ни того, что внутри.
    if (detected && !detected.editor && hideRules.texts.length && (userHidden(el, true) || (detected.control !== undefined && userHidden(detected.control, true)))) {
      stats.userHidden++;
      trace?.set(el, { kind: 'skipped', reason: 'user-hidden' });
      return;
    }
    const panelHere = !!ctx.panel || isPanelBox(el, style.position);
    const pinnedHere = !!ctx.pinned || panelHere || isDialogBox(el);
    // «@иконки»: кнопки-иконки без подписи на приклеенных панелях и во фреймах (тренажёрах) не видны вовсе.
    if (detected && !detected.editor && hideRules.icons && (panelHere || inFrameDoc || ctx.frames.length > 0) && isIconOnly(el)) {
      stats.userHidden++;
      trace?.set(el, { kind: 'skipped', reason: 'user-hidden' });
      return;
    }
    if (detected && !addCandidate(el, detected, pinnedHere ? { ...ctx, pinned: true } : ctx)) detected = null;
    if (!detected && trace && !trace.has(el)) {
      trace.set(el, { kind: 'not-interactive', cursor: style.cursor, parentCursor: ctx.parentCursor, clickableAncestor: ctx.clickableAncestor });
    }
    // Текст семантических кнопок/ссылок — их имя; строчные элементы входят в текст своего блока.
    if (!detected?.semantic && ctx.clickableAncestor !== 'semantic' && !isInlineLike(style.display)) {
      addBlockText(el, style.cursor, ctx, !!detected);
    }

    // Главный контейнер прокрутки SPA: самый большой прокручиваемый блок верхнего документа.
    if (ctx.frames.length === 0 && SCROLLABLE_OVERFLOW.has(style.overflowY)) {
      const box = geom.scrollBox(el);
      const area = box.clientHeight * box.clientWidth;
      if (box.scrollHeight > box.clientHeight + 1 && area > (scroller?.area ?? 0)) scroller = { el, area };
    }

    if (detected?.editor) {
      // Код редактора — в текст построчно, без номеров строк и стрелок сворачивания.
      const lines = codeEditorLines(el) ?? [];
      if (lines.length && textLen >= maxTextChars) stats.textTruncated = true;
      if (lines.length && textLen < maxTextChars) {
        textLines.push([el, ' code editor contents:']);
        for (const line of lines) textLines.push([line.trimEnd() || ' ']);
        textLen += lines.join('\n').length;
      }
      return;
    }
    if (LEAF_CONTROLS.has(tag) || (detected?.kind === 'control' && isEditableHost(el))) return;

    const childCtx: WalkCtx = {
      ...ctx,
      clickableAncestor:
        ctx.clickableAncestor === 'semantic' || detected?.semantic
          ? 'semantic'
          : detected || ctx.clickableAncestor === 'heuristic'
            ? 'heuristic'
            : 'none',
      parentCursor: style.cursor,
      pinned: pinnedHere,
      panel: panelHere,
    };

    const shadow = el.shadowRoot;
    if (shadow) walkChildren(shadow, { ...childCtx, inShadow: true });

    if (tag === 'iframe' || tag === 'frame') {
      let frameDoc: Document | null = null;
      try {
        frameDoc = (el as HTMLIFrameElement).contentDocument; // null или исключение для чужого origin
      } catch {
        frameDoc = null;
      }
      const root = frameDoc?.body ?? frameDoc?.documentElement;
      if (root) {
        const box = geom.frameContentBox(el);
        const offset = { x: ctx.offset.x + box.x, y: ctx.offset.y + box.y };
        const frameClip = intersect(ctx.clip, translate({ ...box, x: 0, y: 0 }, offset));
        if (frameClip) {
          visit(root, {
            offset,
            clip: frameClip,
            frames: [...ctx.frames, el],
            clickableAncestor: 'none',
            parentCursor: 'auto',
            inShadow: false,
          });
        }
      }
      return;
    }

    walkChildren(el, childCtx);
  };

  const start = doc.body ?? doc.documentElement;
  // clip верхнего документа — «бесконечная» плоскость, ограничивает только вьюпорт.
  const infinite: Rect = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 };
  visit(start, {
    offset: opts.frame?.offset ?? { x: 0, y: 0 },
    clip: opts.frame?.clip ?? infinite,
    frames: [],
    clickableAncestor: 'none',
    parentCursor: 'auto',
    inShadow: false,
  });

  // Шум, который убираем с перенумерацией: безымянные обёртки вокруг другого элемента (tooltip-wrapper)
  // и безымянные элементы, у которых из признаков только tabindex (сегменты прогресса с подсказкой по фокусу).
  const keep = elements.map((e, i) => {
    if (semantic[i] || !isNameless(e)) return true;
    if (tabindexOnly[i]) return false;
    const next = registry[i + 1];
    return !next || !composedContains(registry[i]!.element, next.element);
  });
  if (keep.includes(false)) {
    const remap = new Map<number, number>();
    elements = elements.filter((_, i) => keep[i]);
    registry = registry.filter((_, i) => keep[i]);
    registry.forEach((r, i) => {
      remap.set(r.index, i + 1);
      r.index = i + 1;
      elements[i]!.index = i + 1;
    });
    if (trace) {
      for (const [el, v] of trace) {
        if (v.kind !== 'accepted') continue;
        const ni = remap.get(v.index);
        trace.set(el, ni === undefined ? { kind: 'wrapper' } : { kind: 'accepted', index: ni });
      }
    }
  }

  // Номера других фреймов идут раньше — сдвигаем свои.
  const base = opts.indexBase ?? 0;
  if (base) {
    for (const e of elements) e.index += base;
    for (const r of registry) r.index += base;
  }

  // Окно не прокручивается, а большой внутренний контейнер — да: показываем его прокрутку.
  const windowScrolls = vp.scrollHeight > vp.height + 1;
  // TS не видит присваивания внутри замыкания visit — уточняем тип явно.
  const found = scroller as { el: Element; area: number } | null;
  const main = !windowScrolls && found && found.area >= vp.width * vp.height * MIN_SCROLLER_AREA ? found.el : null;
  const mainBox = main ? geom.scrollBox(main) : null;
  const renderedText = renderText(textLines, registry, lockedNotes);
  if (renderedText.length > maxTextChars) stats.textTruncated = true;

  return {
    snapshot: {
      url: doc.location?.href ?? doc.URL,
      title: doc.title,
      scroll: mainBox
        ? {
            x: 0,
            y: mainBox.scrollTop,
            maxY: Math.max(0, mainBox.scrollHeight - mainBox.clientHeight),
            viewportWidth: vp.width,
            viewportHeight: vp.height,
            container: true,
          }
        : {
            x: vp.scrollX,
            y: vp.scrollY,
            maxY: Math.max(0, vp.scrollHeight - vp.height),
            viewportWidth: vp.width,
            viewportHeight: vp.height,
          },
      elements,
      text: renderedText.slice(0, maxTextChars),
      stats,
    },
    registry,
    scroller: main,
  };
}
