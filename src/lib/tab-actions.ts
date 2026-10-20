import { browser } from '#imports';
import type { AgentAction } from './agent/actions';
import type { ActionResult, ObservationHandle } from './agent/types';
import { isDomAction, NO_EFFECT_NOTE, valueHasText } from './dom/act';
import type { CdpDriver, Point } from './exec/cdp';
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
}

/**
 * Выполняет действие агента. Клики и ввод — настоящими событиями через CDP (если доступен),
 * иначе DOM-событиями в content script; переходы и вкладки — через API вкладок.
 * При открытии новой вкладки (ссылка target=_blank, new_tab, switch_tab) меняет ctx.tab.tabId.
 */
export async function executeAction(action: AgentAction, handle: ObservationHandle, ctx: ExecContext): Promise<ActionResult> {
  const { tab } = ctx;
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

type DomAgentAction = Extract<AgentAction, { action: 'click' | 'type' | 'select' | 'scroll' }>;

interface Located {
  frameId: number;
  snapshotId: number;
}

/** В каком фрейме и снимке живёт элемент; прокрутка — всегда в верхнем документе. */
function locate(action: DomAgentAction, handle: ObservationHandle): Located | string {
  const frameId = action.action === 'scroll' ? 0 : handle.owner[action.index];
  if (frameId === undefined) return `element [${(action as { index: number }).index}] does not exist in the current page state`;
  const snapshotId = handle.frames.find((f) => f.frameId === frameId)?.snapshotId;
  return snapshotId === undefined ? 'the page state is outdated; look at the new page state' : { frameId, snapshotId };
}

async function executeDom(action: DomAgentAction, handle: ObservationHandle, ctx: ExecContext): Promise<ActionResult> {
  const { tab } = ctx;
  const before = await browser.tabs.get(tab.tabId);
  if (isRestrictedUrl(before.url)) return { ok: false, message: 'this page cannot be controlled; navigate to a website first' };
  const where = locate(action, handle);
  if (typeof where === 'string') return { ok: false, message: where };

  // CDP — для кликов и ввода; select (нативный список) и прокрутка надёжнее через DOM.
  const driver = (action.action === 'click' || action.action === 'type') && ctx.cdp ? await ctx.cdp(tab.tabId) : null;
  const fallbackNote = (action.action === 'click' || action.action === 'type') && ctx.cdp && !driver ? ctx.cdpUnavailable?.() : '';

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
    else {
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
async function topPoint(index: number, where: Located, handle: ObservationHandle, ctx: ExecContext): Promise<Point | string> {
  const local = await sendToContent(ctx.tab.tabId, { type: 'content:target-point', snapshotId: where.snapshotId, index }, where.frameId);
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
  await Promise.all([animateCursor(ctx, p), driver.click(p)]);
  const mutations = await settled();
  return { ok: true, message: mutations === 0 ? `clicked, ${NO_EFFECT_NOTE}` : 'clicked' };
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
  await Promise.all([animateCursor(ctx, p), driver.click(p)]);
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
