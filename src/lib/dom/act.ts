import type { AgentAction } from '../agent/actions';
import type { ActionResult } from '../agent/types';
import { codeEditorLines, codeEditorSpec, hitsTarget, intersect, type RegistryEntry } from './collect';
import { describeElement } from './diagnose';
import type { Geometry } from './geometry';
import { DEFAULT_STABLE, waitForStable, type StableOptions } from './stable';

/** Действия, которые выполняются внутри страницы (остальные — через API вкладок). */
export type DomAction = Extract<AgentAction, { action: 'click' | 'type' | 'select' | 'scroll' | 'hover' | 'press_key' | 'drag' | 'wait_for' }>;

export const DOM_ACTIONS: ReadonlySet<AgentAction['action']> = new Set(['click', 'type', 'select', 'scroll', 'hover', 'press_key', 'drag', 'wait_for']);

export function isDomAction(a: AgentAction): a is DomAction {
  return DOM_ACTIONS.has(a.action);
}

export interface ActContext {
  registry: readonly RegistryEntry[];
  /** Внутренний контейнер прокрутки SPA или null — окно. */
  scroller: Element | null;
  win: Window;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * Попал ли текст в поле. Сравниваются только буквы и цифры: маски телефона и даты, пробелы
 * в номере карты, переносы и отступы редактора кода меняют всё остальное. По началу — для длинного кода.
 */
export function valueHasText(value: string, text: string): boolean {
  const essence = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return essence(value).includes(essence(text).slice(0, 40));
}

const fail = (message: string): ActionResult => ({ ok: false, message });
const ok = (message = 'ok'): ActionResult => ({ ok: true, message });

function lookup(index: number, ctx: ActContext): RegistryEntry | string {
  const entry = ctx.registry.find((r) => r.index === index);
  if (!entry) return `element [${index}] does not exist in the current page state`;
  if (!entry.element.isConnected) return `element [${index}] is gone — the page changed, look at the new page state`;
  return entry;
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function viewOf(el: Element): Window & typeof globalThis {
  return el.ownerDocument.defaultView as Window & typeof globalThis;
}

/**
 * Клик синтетическими событиями: pointer/mouse down → focus → up → click по центру элемента.
 * Это фолбэк: события получают isTrusted=false, часть сайтов их игнорирует — для них CDP (этап 5).
 */
export function dispatchClick(target: Element): void {
  target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = target.getBoundingClientRect();
  const view = viewOf(target);
  const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const Pointer = view.PointerEvent ?? view.MouseEvent;
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

  target.dispatchEvent(new Pointer('pointerover', pointer));
  target.dispatchEvent(new view.MouseEvent('mouseover', base));
  target.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
  target.dispatchEvent(new view.MouseEvent('mousedown', { ...base, buttons: 1 }));
  (target as HTMLElement).focus?.({ preventScroll: true });
  target.dispatchEvent(new Pointer('pointerup', pointer));
  target.dispatchEvent(new view.MouseEvent('mouseup', base));
  target.dispatchEvent(new view.MouseEvent('click', base));
}

/** Ставит value через нативный сеттер прототипа — иначе React/Vue не заметят изменения. */
export function setNativeValue(el: Element, value: string): void {
  for (let proto: object | null = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(el, value);
      return;
    }
  }
  (el as HTMLInputElement).value = value;
}

function fire(el: Element, type: 'input' | 'change', data?: string): void {
  const view = viewOf(el);
  const ev =
    type === 'input' && view.InputEvent
      ? new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: data ?? null })
      : new view.Event(type, { bubbles: true, composed: true });
  el.dispatchEvent(ev);
}

function pressEnter(el: Element): void {
  const view = viewOf(el);
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  const down = new view.KeyboardEvent('keydown', init);
  el.dispatchEvent(down);
  el.dispatchEvent(new view.KeyboardEvent('keypress', init));
  el.dispatchEvent(new view.KeyboardEvent('keyup', init));
  // Синтетический Enter не вызывает неявную отправку формы — делаем её сами, если сайт не перехватил.
  const form = (el as HTMLInputElement).form;
  if (!down.defaultPrevented && form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  }
}

function typeInto(el: Element, text: string, submit: boolean): ActionResult {
  const tag = el.localName;
  if (codeEditorSpec(el)) {
    return fail('a code editor needs real keyboard input — enable "Клики через chrome.debugger (CDP)" in the extension settings');
  }
  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    if (tag === 'input' && !TEXT_INPUT_TYPES.has(input.type)) return fail(`cannot type into input[type=${input.type}]; use click or select`);
    if (input.readOnly || input.disabled) return fail('the field is read-only or disabled');
    input.focus({ preventScroll: true });
    input.select?.();
    setNativeValue(input, text);
    fire(input, 'input', text);
    fire(input, 'change');
    if (!valueHasText(input.value, text) && input.type !== 'number') return fail(`the page rejected the value (field now contains "${input.value.slice(0, 40)}")`);
  } else if (el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== 'false') {
    (el as HTMLElement).focus({ preventScroll: true });
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand устарел, но это единственный способ вставить текст так, как это делает пользователь.
    const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text);
    if (!inserted) {
      el.textContent = text;
      fire(el, 'input', text);
    }
  } else {
    return fail(`element is <${tag}>, not a text field; click it first if it opens an input`);
  }
  if (submit) pressEnter(el);
  return ok(submit ? 'typed and pressed Enter' : 'typed');
}

function selectOption(el: Element, value: string): ActionResult {
  if (el.localName !== 'select') return fail(`element is <${el.localName}>, not a <select>; click it and then click the option`);
  const select = el as HTMLSelectElement;
  const options = Array.from(select.options);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(value);
  const match =
    options.find((o) => norm(o.text) === want || norm(o.value) === want) ?? options.find((o) => norm(o.text).includes(want));
  if (!match) {
    const list = options.slice(0, 10).map((o) => `"${norm(o.text)}"`).join(', ');
    return fail(`option "${value}" not found; available: ${list}${options.length > 10 ? ', …' : ''}`);
  }
  select.focus({ preventScroll: true });
  setNativeValue(select, match.value);
  fire(select, 'input');
  fire(select, 'change');
  return ok(`selected "${match.text.trim()}"`);
}

/** Ближайший предок (или сам элемент), который действительно прокручивается по вертикали. */
export function scrollableAncestor(el: Element): Element | null {
  const view = viewOf(el);
  for (let n: Element | null = el; n && n !== n.ownerDocument.documentElement && n !== n.ownerDocument.body; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
    const oy = view.getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

function scrollBox(box: Element, direction: 'up' | 'down', amount: number): ActionResult {
  const before = box.scrollTop;
  box.scrollBy({ top: (direction === 'down' ? 1 : -1) * amount * box.clientHeight * 0.8, behavior: 'instant' });
  const moved = Math.abs(box.scrollTop - before);
  if (moved < 1) return ok(`this area is already at the ${direction === 'down' ? 'bottom' : 'top'} — nothing more to scroll`);
  return ok(`scrolled the area ${direction} by ${Math.round(moved)}px`);
}

function scrollPage(direction: 'up' | 'down', amount: number, ctx: ActContext): ActionResult {
  const { win, scroller } = ctx;
  const doc = win.document;
  const el = scroller ?? doc.scrollingElement ?? doc.documentElement;
  const page = scroller ? scroller.clientHeight : win.innerHeight;
  const delta = (direction === 'down' ? 1 : -1) * amount * page * 0.8;
  const before = scroller ? el.scrollTop : win.scrollY;
  if (scroller) scroller.scrollBy({ top: delta, behavior: 'instant' });
  else win.scrollBy({ top: delta, behavior: 'instant' });
  const after = scroller ? el.scrollTop : win.scrollY;
  if (Math.abs(after - before) < 1) return ok(`already at the ${direction === 'down' ? 'bottom' : 'top'} — nothing more to scroll`);
  return ok(`scrolled ${direction} by ${Math.round(Math.abs(after - before))}px`);
}

/** Наведение синтетическими событиями: открывает выпадающие меню и подсказки (фолбэк без CDP). */
export function dispatchHover(target: Element): void {
  target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = target.getBoundingClientRect();
  const view = viewOf(target);
  const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const Pointer = view.PointerEvent ?? view.MouseEvent;
  target.dispatchEvent(new Pointer('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new Pointer('pointerenter', { ...base, bubbles: false, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new view.MouseEvent('mouseover', base));
  target.dispatchEvent(new view.MouseEvent('mouseenter', { ...base, bubbles: false }));
  target.dispatchEvent(new view.MouseEvent('mousemove', base));
}

/** Код клавиши для KeyboardEvent и CDP. */
export const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

/** Клавиша синтетическими событиями в элемент с фокусом. Tab сам фокус не переносит — делаем это вручную. */
function dispatchKey(key: string, win: Window): ActionResult {
  const shift = key.startsWith('Shift+');
  const def = KEY_CODES[shift ? key.slice(6) : key];
  if (!def) return fail(`key "${key}" is not supported`);
  const doc = win.document;
  const target = deepActiveElement(doc) ?? doc.body;
  const view = viewOf(target);
  const init = { ...def, which: def.keyCode, shiftKey: shift, bubbles: true, cancelable: true, composed: true };
  const down = new view.KeyboardEvent('keydown', init);
  target.dispatchEvent(down);
  target.dispatchEvent(new view.KeyboardEvent('keyup', init));
  if (def.key === 'Tab' && !down.defaultPrevented) moveFocus(doc, target, shift ? -1 : 1);
  return ok(`pressed ${key}`);
}

function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable=false])';

function moveFocus(doc: Document, from: Element, dir: 1 | -1): void {
  const all = Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (all.length === 0) return;
  const i = all.indexOf(from as HTMLElement);
  const next = all[(i + dir + all.length) % all.length];
  next?.focus();
}

/** Ждёт, пока текст появится на странице (без учёта регистра и лишних пробелов). */
export async function waitForText(doc: Document, text: string, timeoutMs: number, pollMs = 200): Promise<ActionResult> {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(text);
  const has = () => norm(doc.body?.innerText ?? doc.body?.textContent ?? '').includes(want);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (has()) return ok(`"${text.slice(0, 60)}" is on the page`);
    if (Date.now() >= deadline) return fail(`"${text.slice(0, 60)}" did not appear within ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function performDomAction(action: Exclude<DomAction, { action: 'wait_for' }>, ctx: ActContext): ActionResult {
  if (action.action === 'press_key') return dispatchKey(action.key, ctx.win);
  if (action.action === 'scroll') {
    if (action.index === undefined) return scrollPage(action.direction, action.amount, ctx);
    const entry = lookup(action.index, ctx);
    if (typeof entry === 'string') return fail(entry);
    const box = scrollableAncestor(entry.element);
    return box ? scrollBox(box, action.direction, action.amount) : scrollPage(action.direction, action.amount, ctx);
  }

  const entry = lookup(action.index, ctx);
  if (typeof entry === 'string') return fail(entry);
  if (isDisabled(entry.element)) return fail(`element [${action.index}] is disabled`);

  switch (action.action) {
    case 'click':
      dispatchClick(entry.target);
      return ok('clicked');
    case 'type':
      return typeInto(entry.element, action.text, action.submit);
    case 'select':
      return selectOption(entry.element, action.value);
    case 'hover':
      dispatchHover(entry.target);
      return ok('hovered');
    case 'drag':
      return fail('drag needs real mouse events — enable "Клики через chrome.debugger (CDP)" in the extension settings');
  }
}

export const NO_EFFECT_NOTE = 'but nothing on the page changed — the element may be inactive or need another step first (e.g. choose an option before submitting)';

/**
 * Выполняет действие и ждёт, пока DOM успокоится. Наблюдение за DOM начинается ДО действия,
 * иначе синхронные изменения (раскрытие меню прямо в обработчике клика) не будут замечены.
 * Клик без единого изменения DOM — важный сигнал модели: повторять его бессмысленно.
 */
export async function performAndSettle(action: DomAction, ctx: ActContext, stable: StableOptions = DEFAULT_STABLE): Promise<ActionResult> {
  if (action.action === 'wait_for') return waitForText(ctx.win.document, action.text, action.timeout_ms);
  const settled = waitForStable(ctx.win.document, stable);
  const result = performDomAction(action, ctx);
  const { mutations } = await settled;
  if (result.ok && (action.action === 'click' || action.action === 'hover') && mutations === 0) {
    return { ...result, message: `${result.message}, ${NO_EFFECT_NOTE}` };
  }
  return result;
}

export type ClickPoint = { ok: true; x: number; y: number } | { ok: false; message: string };

/**
 * Точка для настоящего (CDP) клика в координатах вьюпорта этого фрейма: прокручивает цель
 * в центр экрана и ищет внутри неё точку, где верхний элемент — она сама (центр, затем
 * четверти). Так клик не уйдёт в липкую шапку или всплывашку, частично закрывшую кнопку.
 */
export function findClickPoint(entry: RegistryEntry, geom: Geometry, scroll = true): ClickPoint {
  if (!entry.target.isConnected) return { ok: false, message: `element [${entry.index}] is gone — the page changed, look at the new page state` };
  if (isDisabled(entry.element)) return { ok: false, message: `element [${entry.index}] is disabled` };
  if (scroll) entry.target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  const vp = geom.viewport();
  const visible = intersect(geom.rect(entry.target), { x: 0, y: 0, width: vp.width, height: vp.height });
  if (!visible) return { ok: false, message: `element [${entry.index}] is outside the visible area${scroll ? ' even after scrolling' : ''}` };
  const root = entry.target.getRootNode() as Document | ShadowRoot;
  const at = (fx: number, fy: number) => ({ x: visible.x + visible.width * fx, y: visible.y + visible.height * fy });
  let blocker: Element | null = null;
  for (const p of [at(0.5, 0.5), at(0.25, 0.5), at(0.75, 0.5), at(0.5, 0.25), at(0.5, 0.75)]) {
    const hit = geom.hitTest(root, p.x, p.y);
    if (hitsTarget(hit, entry.element, entry.target)) return { ok: true, x: Math.round(p.x), y: Math.round(p.y) };
    blocker ??= hit;
  }
  return { ok: false, message: `element [${entry.index}] is covered by ${blocker ? describeElement(blocker) : 'another element'}` };
}

/** Перед вводом выделяем старое содержимое поля, чтобы новый текст его заменил. */
export function selectFieldContent(el: Element): void {
  // Редактор кода сам выделит всё по Cmd/Ctrl+A — его DOM-выделение он не понимает.
  if (codeEditorSpec(el)) return;
  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea') {
    (el as HTMLInputElement).focus({ preventScroll: true });
    (el as HTMLInputElement).select?.();
    return;
  }
  if (el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== 'false') {
    const sel = el.ownerDocument.getSelection();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

/** Текущее значение поля для проверки ввода; null — не поле (ввод не проверяем). */
export function readFieldValue(el: Element): string | null {
  const code = codeEditorLines(el);
  if (code) return code.join('\n');
  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea') return (el as HTMLInputElement).value;
  if (el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== 'false') return el.textContent ?? '';
  return null;
}
