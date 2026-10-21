import { browser } from '#imports';
import { targetIndex, type AgentAction } from './agent/actions';
import type { ActionResult, ObservationHandle } from './agent/types';
import { isDomAction, NO_EFFECT_NOTE, readTopFor, valueHasText, type DomAction } from './dom/act';
import { planReading } from './dom/reading';
import type { CdpDriver, Point } from './exec/cdp';
import type { ContentRequest } from './messages';
import { ensureContentScript, frameOffset, isRestrictedUrl, sendToContent } from './perception';

/** Только http(s); «example.com» → «https://example.com». null — недопустимый адрес. */
export function normalizeNavigateUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/\//, '')}`;
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ждёт окончания загрузки вкладки (status=complete) с небольшим запасом на старт навигации. */
export async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await sleep(250);
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await sleep(150);
  }
  return false;
}

/** Ошибки, означающие «документ, где был content script, исчез» — то есть страница ушла. */
function isNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message port closed|receiving end does not exist|frame.*(removed|destroyed)|back\/forward cache/i.test(msg);
}

export interface AgentTab {
  tabId: number;
  windowId: number;
}

export interface ExecContext {
  tab: AgentTab;
  /** CDP-драйвер для вкладки; null (или не задан) — действуем DOM-событиями. */
  cdp?: (tabId: number) => Promise<CdpDriver | null>;
  /** Почему CDP недоступен — добавляется к результату, чтобы было видно в ленте. */
  cdpUnavailable?: () => string;
  showCursor: boolean;
  /** Ввод по буквам (только с CDP); не задано — вставка строки целиком. */
  typing?: { byKeys: boolean; delayMs: number };
  /** Потолок времени одного чтения (мс); не задан — по умолчанию из reading.ts. */
  readMaxMs?: number;
}

/**
 * Выполняет действие агента. Клики и ввод — настоящими событиями через CDP (если доступен),
 * иначе DOM-событиями в content script; переходы и вкладки — через API вкладок.
 * При открытии новой вкладки (ссылка target=_blank, new_tab, switch_tab) меняет ctx.tab.tabId.
 */
export async function executeAction(action: AgentAction, handle: ObservationHandle, ctx: ExecContext, signal?: AbortSignal): Promise<ActionResult> {
  const { tab } = ctx;
  if (action.action === 'read') return executeRead(action, handle, ctx, signal);
  if (isDomAction(action)) return executeDom(action, handle, ctx);

  switch (action.action) {
    case 'navigate': {
      const url = normalizeNavigateUrl(action.url);
      if (!url) return { ok: false, message: `invalid URL "${action.url}" — only http(s) addresses are allowed` };
      await browser.tabs.update(tab.tabId, { url });
      const loaded = await waitForTabLoad(tab.tabId);
      return { ok: true, navigated: true, message: loaded ? `opened ${url}` : `opened ${url} (still loading)` };
    }
    case 'go_back': {
      const before = (await browser.tabs.get(tab.tabId)).url;
      try {
        await browser.tabs.goBack(tab.tabId);
      } catch {
        return { ok: false, message: 'there is no previous page in this tab' };
      }
      await waitForTabLoad(tab.tabId);
      const after = (await browser.tabs.get(tab.tabId)).url;
      return { ok: true, navigated: true, message: after !== before ? `went back to ${after}` : 'went back' };
    }
    case 'new_tab': {
      const url = action.url === 'about:blank' ? undefined : normalizeNavigateUrl(action.url);
      if (url === null) return { ok: false, message: `invalid URL "${action.url}"` };
      const created = await browser.tabs.create({ windowId: tab.windowId, url, active: true });
      if (created.id === undefined) return { ok: false, message: 'could not open a tab' };
      tab.tabId = created.id;
      await waitForTabLoad(created.id);
      return { ok: true, navigated: true, message: `opened new tab ${created.id}${url ? ` with ${url}` : ''}` };
    }
    case 'switch_tab': {
      const target = await browser.tabs.get(action.tab_id).catch(() => null);
      if (!target?.id) return { ok: false, message: `tab ${action.tab_id} does not exist` };
      await browser.tabs.update(target.id, { active: true });
      tab.tabId = target.id;
      return { ok: true, navigated: true, message: `switched to tab ${target.id} (${target.title ?? ''})` };
    }
    case 'wait':
      await sleep(action.ms);
      return { ok: true, message: `waited ${action.ms}ms` };
    default:
      return { ok: false, message: `action "${action.action}" is handled by the agent loop` };
  }
}

type DomAgentAction = DomAction;

interface Located {
  frameId: number;
  snapshotId: number;
}

/** В каком фрейме и снимке живёт элемент; действия без элемента (прокрутка страницы, клавиша) — в верхнем документе. */
function locate(action: DomAgentAction, handle: ObservationHandle, index = targetIndex(action)): Located | string {
  const frameId = index === undefined ? 0 : handle.owner[index];
  if (frameId === undefined) return `element [${index}] does not exist in the current page state`;
  const snapshotId = handle.frames.find((f) => f.frameId === frameId)?.snapshotId;
  return snapshotId === undefined ? 'the page state is outdated; look at the new page state' : { frameId, snapshotId };
}

/** Действия, которым нужны настоящие события мыши и клавиатуры (CDP); select и ожидание — через DOM; прокрутка — колесом мыши (CDP), без него DOM-прокруткой. */
const CDP_ACTIONS: ReadonlySet<AgentAction['action']> = new Set(['click', 'type', 'hover', 'drag', 'press_key', 'scroll']);

async function executeDom(action: DomAgentAction, handle: ObservationHandle, ctx: ExecContext): Promise<ActionResult> {
  const { tab } = ctx;
  const before = await browser.tabs.get(tab.tabId);
  if (isRestrictedUrl(before.url)) return { ok: false, message: 'this page cannot be controlled; navigate to a website first' };
  const where = locate(action, handle);
  if (typeof where === 'string') return { ok: false, message: where };

  const wantsCdp = CDP_ACTIONS.has(action.action);
  const driver = wantsCdp && ctx.cdp ? await ctx.cdp(tab.tabId) : null;
  const fallbackNote = wantsCdp && ctx.cdp && !driver ? ctx.cdpUnavailable?.() : '';

  // Ссылка с target=_blank откроет вкладку — ловим её и переключаемся.
  let opened: number | null = null;
  const onCreated = (t: { id?: number; openerTabId?: number }) => {
    if (t.openerTabId === tab.tabId && t.id !== undefined) opened = t.id;
  };
  browser.tabs.onCreated.addListener(onCreated);

  let result: ActionResult;
  try {
    await ensureContentScript(tab.tabId, before.url);
    if (driver && action.action === 'click') result = await cdpClick(action.index, where, handle, ctx, driver);
    else if (driver && action.action === 'type') result = await cdpType(action, where, handle, ctx, driver);
    else if (driver && action.action === 'hover') result = await cdpHover(action.index, where, handle, ctx, driver);
    else if (driver && action.action === 'drag') result = await cdpDrag(action, where, handle, ctx, driver);
    else if (driver && action.action === 'scroll') result = await cdpScroll(action, where, handle, ctx, driver);
    else if (driver && action.action === 'press_key') {
      await driver.pressKey(action.key);
      result = { ok: true, message: `pressed ${action.key}` };
    } else {
      if (ctx.showCursor && action.action === 'click') await showCursorAt(action.index, where, handle, ctx);
      result = await sendToContent(tab.tabId, { type: 'content:act', action, snapshotId: where.snapshotId }, where.frameId);
    }
  } catch (err) {
    if (!isNavigationError(err)) {
      browser.tabs.onCreated.removeListener(onCreated);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    result = { ok: true, message: 'done; the page started loading' };
  } finally {
    // Даём вкладке, открытой кликом, успеть появиться.
    await sleep(150);
    browser.tabs.onCreated.removeListener(onCreated);
  }
  if (fallbackNote && result.ok) result = { ...result, message: `${result.message} (DOM events: ${fallbackNote})` };

  if (opened !== null) {
    tab.tabId = opened;
    await browser.tabs.update(opened, { active: true }).catch(() => {});
    await waitForTabLoad(opened);
    return { ...result, navigated: true, message: `${result.message}; it opened a new tab ${opened}, now working there` };
  }

  const loading = (await browser.tabs.get(tab.tabId).catch(() => null))?.status === 'loading';
  if (loading) await waitForTabLoad(tab.tabId);
  const after = await browser.tabs.get(tab.tabId).catch(() => null);
  if (after && after.url !== before.url) {
    return { ...result, navigated: true, message: `${result.message}; page changed to ${after.url}` };
  }
  if (loading) return { ...result, navigated: true };
  // Модель часто ждёт от клика перехода — явно говорим, что его не было.
  return result.ok && action.action === 'click' ? { ...result, message: `${result.message}; ${SAME_PAGE_NOTE}` } : result;
}

export const SAME_PAGE_NOTE = 'still on the same page (URL unchanged)';

/** Точка клика в координатах верхней страницы (с учётом iframe). */
async function topPoint(index: number, where: Located, handle: ObservationHandle, ctx: ExecContext, noScroll = false): Promise<Point | string> {
  const local = await sendToContent(ctx.tab.tabId, { type: 'content:target-point', snapshotId: where.snapshotId, index, noScroll }, where.frameId);
  if (!local.ok) return local.message;
  const off = await frameOffset(ctx.tab.tabId, handle.nodes, where.frameId);
  return { x: local.x + off.x, y: local.y + off.y };
}

const CURSOR_MS = 260;

function animateCursor(ctx: ExecContext, p: Point): Promise<void> {
  if (!ctx.showCursor) return Promise.resolve();
  return sendToContent(ctx.tab.tabId, { type: 'content:cursor', x: p.x, y: p.y, durationMs: CURSOR_MS, click: true }, 0).then(
    () => {},
    () => {},
  );
}

/** Окно, в течение которого курсор повторяет настоящую мышь; обновляется перед каждым CDP-действием. */
const FOLLOW_MS = 15_000;

/** Включает во всех фреймах вкладки показ курсора по настоящим событиям мыши. */
async function followCursor(ctx: ExecContext): Promise<void> {
  if (!ctx.showCursor) return;
  await browser.tabs.sendMessage(ctx.tab.tabId, { type: 'content:cursor-follow', ms: FOLLOW_MS } satisfies ContentRequest).catch(() => {});
}

/** Курсор для DOM-клика (без CDP) — чтобы было видно, куда нажимает агент. */
async function showCursorAt(index: number, where: Located, handle: ObservationHandle, ctx: ExecContext): Promise<void> {
  const p = await topPoint(index, where, handle, ctx).catch(() => null);
  if (p && typeof p !== 'string') await animateCursor(ctx, p);
}

/** Следим за DOM в фрейме элемента и в верхнем документе: клик в iframe может менять верхний и наоборот. */
async function watchFrames(ctx: ExecContext, frameId: number): Promise<() => Promise<number>> {
  const frames = [...new Set([0, frameId])];
  await Promise.all(frames.map((f) => sendToContent(ctx.tab.tabId, { type: 'content:watch-start' }, f).catch(() => null)));
  return async () => {
    const counts = await Promise.all(
      frames.map((f) => sendToContent(ctx.tab.tabId, { type: 'content:watch-end' }, f).then((r) => r.mutations)),
    );
    return counts.reduce((a, b) => a + b, 0);
  };
}

async function cdpClick(index: number, where: Located, handle: ObservationHandle, ctx: ExecContext, driver: CdpDriver): Promise<ActionResult> {
  const p = await topPoint(index, where, handle, ctx);
  if (typeof p === 'string') return { ok: false, message: p };
  const settled = await watchFrames(ctx, where.frameId);
  await followCursor(ctx);
  await driver.click(p);
  const mutations = await settled();
  return { ok: true, message: mutations === 0 ? `clicked, ${NO_EFFECT_NOTE}` : 'clicked' };
}

/** Пауза, которую можно прервать (кнопка «Стоп»): проверяем сигнал каждые полсекунды. */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  for (let left = ms; left > 0; left -= 500) {
    if (signal?.aborted) throw new Error('stopped');
    await sleep(Math.min(500, left));
  }
  if (signal?.aborted) throw new Error('stopped');
}

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

/**
 * Чтение: колесо мыши медленно ведёт страницу от одного места к другому в темпе человека,
 * который читает (лёгкий текст быстрее, код и селекторы — медленнее), со случайными остановками.
 * Нужен CDP: ждать минутами синтетическую прокрутку нет смысла — страница её не отличит.
 */
async function executeRead(
  action: Extract<AgentAction, { action: 'read' }>,
  handle: ObservationHandle,
  ctx: ExecContext,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const { tabId } = ctx.tab;
  const before = await browser.tabs.get(tabId);
  if (isRestrictedUrl(before.url)) return { ok: false, message: 'this page cannot be controlled; navigate to a website first' };
  for (const i of [action.index, action.to_index]) {
    if (i === undefined) continue;
    const owner = handle.owner[i];
    if (owner === undefined) return { ok: false, message: `element [${i}] does not exist in the current page state` };
    if (owner !== 0) return { ok: false, message: `element [${i}] is inside an embedded frame — reading works on the main page; use scroll there` };
  }
  const driver = ctx.cdp ? await ctx.cdp(tabId) : null;
  if (!driver) return { ok: false, message: `reading needs real mouse wheel events (debugger): ${ctx.cdpUnavailable?.() || 'unavailable'}; use scroll instead` };
  const snapshotId = handle.frames.find((f) => f.frameId === 0)?.snapshotId;
  if (snapshotId === undefined) return { ok: false, message: 'the page state is outdated; look at the new page state' };

  await ensureContentScript(tabId, before.url);
  const src = await sendToContent(tabId, { type: 'content:read-plan', snapshotId, from: action.index, to: action.to_index }, 0);
  if (!src.ok) return { ok: false, message: src.message };
  const plan = planReading(src.segments, src.from, src.to, action.pace ?? 'auto', Math.random, ctx.readMaxMs);
  if (plan.steps.length === 0) return { ok: false, message: 'there is no text between these places' };

  const at = { x: src.x, y: src.y };
  // Колесо — если под мышью именно страница; иначе (в центре вложенный скролл, фрейм) — прямая прокрутка.
  const move = async (dy: number) => {
    if (src.wheel) return driver.wheel(at, dy);
    const amount = Math.abs(dy) / Math.max(1, src.viewport * 0.8);
    await sendToContent(tabId, { type: 'content:act', action: { action: 'scroll', direction: dy > 0 ? 'down' : 'up', amount }, snapshotId }, 0);
  };
  // Сначала быстро подводим начало текста к строке чтения, затем читаем.
  const startTop = Math.min(src.target, readTopFor(src.from, src.viewport));
  if (Math.abs(startTop - src.top) > 4) await move(startTop - src.top);
  await sleepAbortable(400, signal);
  let scrolled = 0;
  for (const step of plan.steps) {
    if (signal?.aborted) throw new Error('stopped');
    if (src.wheel) await followCursor(ctx);
    await move(step.deltaY);
    scrolled += step.deltaY;
    await sleepAbortable(step.waitMs, signal);
  }

  // Страница могла дорисоваться по дороге — довод до конца, если не дошли.
  const info = await sendToContent(tabId, { type: 'content:scroll-info', snapshotId }, 0).catch(() => null);
  if (info?.ok) {
    const expected = Math.min(src.target, startTop + scrolled);
    if (Math.abs(info.top - expected) > 60) await move(expected - info.top);
  }
  const where = `${action.index !== undefined ? `[${action.index}]` : 'here'} → ${action.to_index !== undefined ? `[${action.to_index}]` : 'the end of the page'}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const mix = `${pct(plan.carefulShare)} code/technical read slowly, ${pct(plan.junkShare)} off-topic skimmed`;
  return { ok: true, message: `read ${where}: ~${plan.chars} characters in ${fmtDuration(plan.totalMs)} (${mix})${plan.capped ? ', shortened to the time limit' : ''}` };
}

/** Сколько раз и как часто проверять, что плавная прокрутка браузера закончилась. */
const SCROLL_SETTLE_POLLS = 8;
const SCROLL_SETTLE_MS = 80;

/**
 * Прокрутка колесом мыши (CDP): мышь встаёт над областью прокрутки (или над элементом index),
 * браузер сам решает, что листать. Результат меряем по смещению — как у DOM-прокрутки.
 */
async function cdpScroll(
  action: Extract<AgentAction, { action: 'scroll' }>,
  where: Located,
  handle: ObservationHandle,
  ctx: ExecContext,
  driver: CdpDriver,
): Promise<ActionResult> {
  const { tabId } = ctx.tab;
  const info = await sendToContent(tabId, { type: 'content:scroll-info', snapshotId: where.snapshotId, index: action.index }, where.frameId);
  if (!info.ok) return { ok: false, message: info.message };
  // Под любой точкой области — вложенный скролл, фрейм или карта: колесо прокрутило бы их, а не то, что нужно.
  const domScroll = () => sendToContent(tabId, { type: 'content:act', action, snapshotId: where.snapshotId }, where.frameId);
  if (!info.wheel) return domScroll();
  const off = await frameOffset(tabId, handle.nodes, where.frameId);
  const at = { x: info.x + off.x, y: info.y + off.y };
  const delta = (action.direction === 'down' ? 1 : -1) * action.amount * info.page * 0.8;

  // Позицию читаем у целевого фрейма и у верхней страницы: колесо может докрутить и родителя.
  const frames = [...new Set([0, where.frameId])];
  const position = async (): Promise<number> => {
    let sum = 0;
    for (const frameId of frames) {
      const snapshotId = handle.frames.find((f) => f.frameId === frameId)?.snapshotId;
      if (snapshotId === undefined) continue;
      const index = frameId === where.frameId ? action.index : undefined;
      const r = await sendToContent(tabId, { type: 'content:scroll-info', snapshotId, index }, frameId).catch(() => null);
      if (r?.ok) sum += r.top;
    }
    return sum;
  };

  const before = await position();
  const settled = await watchFrames(ctx, where.frameId);
  await followCursor(ctx);
  await driver.wheel(at, delta);
  await settled();
  // Браузер прокручивает плавно, уже после последнего события колеса — ждём, пока позиция перестанет меняться.
  let after = await position();
  for (let i = 0; i < SCROLL_SETTLE_POLLS; i++) {
    await sleep(SCROLL_SETTLE_MS);
    const now = await position();
    if (now === after) break;
    after = now;
  }

  const moved = Math.abs(after - before);
  // Колесо ничего не сдвинуло: это край или колесо съел виджет страницы. Проверяем прямой прокруткой —
  // ложное «уже внизу» заставит модель решить, что страница кончилась.
  if (moved < 1) return domScroll();
  return { ok: true, message: `scrolled ${action.index !== undefined ? 'the area ' : ''}${action.direction} by ${Math.round(moved)}px` };
}

async function cdpHover(index: number, where: Located, handle: ObservationHandle, ctx: ExecContext, driver: CdpDriver): Promise<ActionResult> {
  const p = await topPoint(index, where, handle, ctx);
  if (typeof p === 'string') return { ok: false, message: p };
  const settled = await watchFrames(ctx, where.frameId);
  await followCursor(ctx);
  await driver.moveTo(p);
  const mutations = await settled();
  return { ok: true, message: mutations === 0 ? `hovered, ${NO_EFFECT_NOTE}` : 'hovered' };
}

async function cdpDrag(
  action: Extract<AgentAction, { action: 'drag' }>,
  where: Located,
  handle: ObservationHandle,
  ctx: ExecContext,
  driver: CdpDriver,
): Promise<ActionResult> {
  const from = await topPoint(action.index, where, handle, ctx);
  if (typeof from === 'string') return { ok: false, message: from };
  const target = locate(action, handle, action.to_index);
  if (typeof target === 'string') return { ok: false, message: target };
  // Цель не прокручиваем: источник уже в центре экрана и уехал бы из-под мыши.
  const to = await topPoint(action.to_index, target, handle, ctx, true);
  if (typeof to === 'string') return { ok: false, message: `drop target: ${to} — both elements must be visible at once (scroll first)` };
  const settled = await watchFrames(ctx, where.frameId);
  await followCursor(ctx);
  await driver.drag(from, to);
  const mutations = await settled();
  return { ok: true, message: mutations === 0 ? `dragged, ${NO_EFFECT_NOTE}` : 'dragged' };
}

async function cdpType(
  action: Extract<AgentAction, { action: 'type' }>,
  where: Located,
  handle: ObservationHandle,
  ctx: ExecContext,
  driver: CdpDriver,
): Promise<ActionResult> {
  const p = await topPoint(action.index, where, handle, ctx);
  if (typeof p === 'string') return { ok: false, message: p };
  // Настоящий клик даёт фокус (в том числе редактору кода в iframe), затем заменяем содержимое.
  await followCursor(ctx);
  await driver.click(p);
  await sendToContent(ctx.tab.tabId, { type: 'content:focus-select', snapshotId: where.snapshotId, index: action.index }, where.frameId);
  await driver.selectAll();
  // Редактор кода сам закрывает скобки и ставит отступы — по буквам туда вводить нельзя, только вставкой.
  const editor = handle.elements?.find((e) => e.index === action.index)?.line.startsWith('code-editor') ?? false;
  if (!action.text) await driver.pressBackspace();
  else if (ctx.typing?.byKeys && !editor) await driver.typeChars(action.text, ctx.typing.delayMs);
  else await driver.insertText(action.text);
  if (action.submit) {
    await driver.pressEnter();
    return { ok: true, message: 'typed and pressed Enter' };
  }
  const value = await sendToContent(ctx.tab.tabId, { type: 'content:read-value', snapshotId: where.snapshotId, index: action.index }, where.frameId).catch(
    () => null,
  );
  if (value !== null && action.text && !valueHasText(value, action.text)) {
    return { ok: false, message: `the text did not appear in the field (it now contains "${value.slice(0, 40)}")` };
  }
  return { ok: true, message: 'typed' };
}
