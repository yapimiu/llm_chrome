import { browser } from '#imports';
import type { ElementBrief, ObservationHandle } from './agent/types';
import { serializeElement, serializePage } from './dom/serialize';
import type { ElementFlag, ElementInfo, Rect } from './dom/types';

const NOT_CLICKABLE_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', 'file', '']);

/** Кнопки, ссылки, переключатели — да; поля ввода, списки и редакторы кода — нет. */
function isClickable(e: ElementInfo): boolean {
  if (e.tag === 'textarea' || e.tag === 'select' || e.tag === 'code-editor' || e.contentEditable) return false;
  if (e.tag === 'input') return !NOT_CLICKABLE_TYPES.has(e.type ?? '');
  return true;
}
import { buildFrameTree, completeSingleFrame, mergeObservations, type FrameInfoReport, type FrameNode, type FrameTagReport, type RawFrameObservation } from './frames';
import type { ContentRequest, ContentResponses, ObserveResult, Result } from './messages';

/** Страницы, куда Chrome не пускает расширения. */
const RESTRICTED = [
  /^chrome:/,
  /^chrome-extension:/,
  /^edge:/,
  /^about:/,
  /^view-source:/,
  /^devtools:/,
  /^https:\/\/chromewebstore\.google\.com\//,
  /^https:\/\/chrome\.google\.com\/webstore/,
];

/** Сколько ждать, пока метки postMessage дойдут до iframe (они в других процессах). */
const FRAME_TAG_DELAY_MS = 60;

export function isRestrictedUrl(url: string | undefined): boolean {
  return !!url && RESTRICTED.some((re) => re.test(url));
}

export async function activeTab(windowId: number): Promise<{ id: number; url?: string }> {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab?.id === undefined) throw new Error('Нет активной вкладки.');
  return { id: tab.id, url: tab.url };
}

export async function sendToContent<R extends ContentRequest>(tabId: number, req: R, frameId = 0): Promise<ContentResponses[R['type']]> {
  const res = (await browser.tabs.sendMessage(tabId, req, { frameId })) as Result<ContentResponses[R['type']]> | undefined;
  if (!res) throw new Error('Content script не ответил.');
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function injectionError(err: unknown, url?: string): Error {
  if (url?.startsWith('file:')) return new Error('Для file:// включите «Разрешить доступ к URL файлов» в настройках расширения.');
  return new Error(`Не удалось внедрить скрипт: ${err instanceof Error ? err.message : String(err)}`);
}

/** Внедряет content script в верхний фрейм, если его там ещё нет (страница открыта до установки, навигация). */
export async function ensureContentScript(tabId: number, url?: string): Promise<void> {
  if (isRestrictedUrl(url)) {
    throw new Error('Chrome не разрешает расширениям работать на этой странице (chrome://, магазин расширений и т.п.).');
  }
  try {
    if ((await sendToContent(tabId, { type: 'content:ping' })) === 'pong') return;
  } catch {
    // скрипта нет — внедряем
  }
  try {
    await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['/content-scripts/content.js'] });
  } catch (err) {
    throw injectionError(err, url);
  }
}

/** Внедряет content script во все фреймы (повторная инъекция безопасна) и возвращает их frameId. */
async function injectAllFrames(tabId: number, url?: string): Promise<number[]> {
  if (isRestrictedUrl(url)) {
    throw new Error('Chrome не разрешает расширениям работать на этой странице (chrome://, магазин расширений и т.п.).');
  }
  try {
    const results = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['/content-scripts/content.js'] });
    const ids = [...new Set(results.map((r) => r.frameId))];
    return ids.includes(0) ? ids : [0, ...ids];
  } catch (err) {
    throw injectionError(err, url);
  }
}

export interface PageObservation extends ObserveResult {
  handle: ObservationHandle;
  complete?: boolean;
}

export interface ObserveOptions {
  maxTextPerElement?: number;
  maxChars: number;
  highlight: boolean;
  /** Тексты «скрыть от модели» (нижний регистр). */
  hide: string[];
  /** Правила кнопки «Далее» (см. nextRulesFor). */
  next?: string[];
}

/**
 * Снимок страницы со всеми фреймами: верхний документ и iframe с других сайтов
 * (редакторы кода, виджеты). Номера элементов сквозные, координаты — верхней страницы.
 */
export async function observePage(tabId: number, url: string | undefined, opts: ObserveOptions): Promise<PageObservation> {
  const started = performance.now();
  const frameIds = await injectAllFrames(tabId, url);
  const ask = <R extends ContentRequest>(req: R, frameId: number) => sendToContent(tabId, req, frameId);

  // 1. Каждый фрейм метит свои iframe с других сайтов и сообщает их положение.
  const tags = (await Promise.all(
    frameIds.map((frameId) =>
      ask({ type: 'content:frame-tag' }, frameId)
        .then((children) => ({ frameId, children }))
        .catch(() => null),
    ),
  )).filter((tag): tag is FrameTagReport => tag !== null);
  await new Promise((r) => setTimeout(r, FRAME_TAG_DELAY_MS));
  // 2. Каждый фрейм сообщает полученную метку — так frameId сопоставляется с iframe-элементом.
  const infos = (
    await Promise.all(frameIds.map((frameId) => ask({ type: 'content:frame-info' }, frameId).then((info) => ({ frameId, ...info }), () => null)))
  ).filter((i): i is FrameInfoReport & { frameId: number; viewport: { width: number; height: number } } => i !== null);
  const nodes = buildFrameTree(tags, infos);
  const viewport = infos.find((i) => i.frameId === 0)?.viewport ?? { width: 0, height: 0 };

  // 3. Фреймы собираются по очереди, чтобы номера шли сплошь: верхний, затем вложенные.
  const parts: { node: FrameNode; obs: RawFrameObservation }[] = [];
  let indexBase = 0;
  for (const node of nodes) {
    try {
      const obs = await ask(
        {
          type: 'content:observe',
          maxChars: opts.maxChars,
          hide: opts.hide,
          next: opts.next,
          indexBase,
          frame: node.frameId === 0 ? undefined : { offset: node.offset, clip: node.clip, viewport },
        },
        node.frameId,
      );
      parts.push({ node, obs });
      indexBase = Math.max(indexBase, ...obs.elements.map((e) => e.index));
    } catch (err) {
      if (node.frameId === 0) throw err;
      // Фрейм перезагрузился между шагами — без него наблюдение всё равно полезно.
    }
  }

  const snapshot = mergeObservations(parts);
  const page = serializePage(snapshot, { maxChars: opts.maxChars, maxTextPerElement: opts.maxTextPerElement });
  await Promise.all(
    parts.map(({ node, obs }) =>
      ask({ type: 'content:show', snapshotId: obs.snapshotId, shown: page.shownIndices, highlight: opts.highlight }, node.frameId).catch(() => {}),
    ),
  );

  const owner: Record<number, number> = {};
  const flags: Record<number, ElementFlag[]> = {};
  const formSubmit: Record<number, string> = {};
  const elements: ElementBrief[] = snapshot.elements.map((e) => ({
    index: e.index,
    line: serializeElement(e).replace(/^\[\d+\] /, ''),
    y: Math.round(e.rect.y + snapshot.scroll.y),
    disabled: e.states.includes('disabled'),
    next: !!e.next,
    clickable: isClickable(e),
    pinned: !!e.pinned,
    inFrame: !!e.inFrame,
  }));
  for (const { node, obs } of parts) {
    for (const e of obs.elements) {
      owner[e.index] = node.frameId;
      if (e.flags?.length) flags[e.index] = e.flags;
      if (e.formSubmit) formSubmit[e.index] = e.formSubmit;
    }
  }

  return {
    text: page.text,
    complete: completeSingleFrame(frameIds, tags, infos, parts, page),
    stats: {
      url: snapshot.url,
      totalElements: snapshot.elements.length,
      shownElements: page.shownIndices.length,
      omittedElements: page.omittedElements,
      covered: snapshot.stats.covered,
      hidden: snapshot.stats.hidden,
      offscreen: snapshot.stats.offscreen,
      userHidden: snapshot.stats.userHidden,
      chars: page.text.length,
      maxChars: opts.maxChars,
      textTruncated: page.textTruncated,
      walkTruncated: snapshot.stats.walkTruncated,
      durationMs: Math.round(performance.now() - started),
    },
    handle: { frames: parts.map((p) => ({ frameId: p.node.frameId, snapshotId: p.obs.snapshotId })), owner, nodes, flags, formSubmit, elements },
  };
}

/**
 * Текущий сдвиг фрейма в координатах верхней страницы: спрашиваем у каждого родителя
 * положение его iframe прямо сейчас — после прокрутки к элементу оно могло измениться.
 */
export async function frameOffset(tabId: number, nodes: readonly FrameNode[], frameId: number): Promise<{ x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.frameId, n]));
  const node = byId.get(frameId);
  if (!node || node.parentFrameId === null) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (let n: FrameNode | undefined = node; n && n.parentFrameId !== null && n.token; n = byId.get(n.parentFrameId)) {
    const box: Rect | null = await sendToContent(tabId, { type: 'content:frame-box', token: n.token }, n.parentFrameId).catch(() => null);
    if (!box) return node.offset; // родитель перезагрузился — берём координаты из снимка
    x += box.x;
    y += box.y;
  }
  return { x, y };
}

export async function setHighlight(tabId: number, url: string | undefined, enabled: boolean): Promise<void> {
  if (!enabled && isRestrictedUrl(url)) return;
  await ensureContentScript(tabId, url);
  if (enabled) {
    await sendToContent(tabId, { type: 'content:highlight', enabled });
    return;
  }
  // Выключаем во всех фреймах: без frameId сообщение уходит каждому.
  await browser.tabs.sendMessage(tabId, { type: 'content:highlight', enabled: false } satisfies ContentRequest).catch(() => {});
}
