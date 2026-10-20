import { browser, defineContentScript } from '#imports';
import type { ActionResult } from '@/lib/agent/types';
import { findClickPoint, performAndSettle, readFieldValue, selectFieldContent, type DomAction } from '@/lib/dom/act';
import { accessibleName, collectSnapshot, framesOf, topRect, type RegistryEntry, type TraceVerdict } from '@/lib/dom/collect';
import { CursorOverlay } from '@/lib/dom/cursor';
import { describeElement, diagnose, type Diagnosis } from '@/lib/dom/diagnose';
import { suggestHideRule } from '@/lib/dom/hide-rules';
import { browserGeometry } from '@/lib/dom/geometry';
import { DebugOverlay } from '@/lib/dom/overlay';
import { ElementPicker } from '@/lib/dom/picker';
import { serializePage } from '@/lib/dom/serialize';
import { waitForStable } from '@/lib/dom/stable';
import type { FrameChildTag, RawFrameObservation } from '@/lib/frames';
import { errorMessage, isContentRequest, type ContentRequest, type FrameGeometry, type FrameInfo, type HidePick, type Result } from '@/lib/messages';

const INSTALLED = Symbol.for('llm-agent.content-installed');
/** Сколько последних снимков помнить: агент действует по своему снимку, даже если панель сняла новый. */
const KEEP_SNAPSHOTS = 3;
/** Ключ сообщения, которым родитель метит iframe с другого сайта. */
const FRAME_TAG = '__llmAgentFrameTag';

interface Snapshot {
  registry: RegistryEntry[];
  scroller: Element | null;
}

function sameOriginWithParent(): boolean {
  if (window.parent === window) return false;
  try {
    return !!window.parent.document; // чужой origin бросает SecurityError
  } catch {
    return false;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  // Не встраиваемся во все страницы: background внедряет скрипт по требованию (во все фреймы вкладки).
  registration: 'runtime',
  main() {
    // Повторная инъекция в тот же документ попадает в тот же isolated world — не регистрируемся дважды.
    const g = globalThis as Record<symbol, boolean>;
    if (g[INSTALLED]) return;
    g[INSTALLED] = true;

    const geom = browserGeometry(window);
    const overlay = new DebugOverlay(document);
    const hoverBox = new DebugOverlay(document);
    const cursor = new CursorOverlay(document);
    const isOwn = (el: Element) => overlay.isOwn(el) || hoverBox.isOwn(el) || cursor.isOwn(el);
    const picker = new ElementPicker(document, {
      ignore: isOwn,
      onHover: (item) => (item ? hoverBox.show([item]) : hoverBox.hide()),
    });
    let registry: RegistryEntry[] = [];
    let shown: number[] = [];
    let nextSnapshotId = 1;
    const snapshots = new Map<number, Snapshot>();

    // ——— фреймы: родитель метит iframe с других сайтов токенами, фрейм запоминает свой ———
    let parentToken: string | null = null;
    const childFrames = new Map<string, Element>();
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window.parent || window.parent === window) return;
      const data: unknown = e.data;
      if (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>)[FRAME_TAG] === 'string') {
        parentToken = (data as Record<string, string>)[FRAME_TAG]!;
      }
    });

    const tagChildFrames = (): FrameChildTag[] => {
      childFrames.clear();
      const tags: FrameChildTag[] = [];
      for (const frame of Array.from(document.querySelectorAll('iframe, frame'))) {
        let accessible = false;
        try {
          accessible = !!(frame as HTMLIFrameElement).contentDocument;
        } catch {
          accessible = false;
        }
        // Фреймы того же origin обходит сам сборщик через contentDocument.
        const win = (frame as HTMLIFrameElement).contentWindow;
        if (accessible || !win) continue;
        const token = crypto.randomUUID();
        childFrames.set(token, frame);
        win.postMessage({ [FRAME_TAG]: token }, '*');
        tags.push({ token, box: geom.frameContentBox(frame), visible: geom.isVisible(frame) });
      }
      return tags;
    };

    const frameInfo = (): FrameInfo => ({
      parentToken,
      sameOriginWithParent: sameOriginWithParent(),
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });

    // ——— наблюдение ———
    const highlight = (enabled: boolean) => {
      if (!enabled) return overlay.hide();
      const visible = new Set(shown);
      overlay.show(registry.filter((e) => visible.has(e.index)).map((e) => ({ index: e.index, rect: () => topRect(e, geom) })));
    };

    const observe = (maxChars: number, hide: string[], next: string[], indexBase: number, frame?: FrameGeometry): RawFrameObservation => {
      const snapshotId = nextSnapshotId++;
      // Фрейм того же origin уже обошёл родитель через contentDocument.
      if (sameOriginWithParent()) {
        snapshots.set(snapshotId, { registry: [], scroller: null });
        return {
          snapshotId,
          url: location.href,
          title: document.title,
          scroll: { x: 0, y: 0, maxY: 0, viewportWidth: innerWidth, viewportHeight: innerHeight },
          elements: [],
          text: '',
          stats: { nodesVisited: 0, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 },
        };
      }
      const { snapshot, registry: reg, scroller } = collectSnapshot(document, geom, {
        ignore: isOwn,
        maxTextChars: maxChars,
        hideNames: hide,
        nextNames: next,
        indexBase,
        frame,
      });
      registry = reg;
      snapshots.set(snapshotId, { registry: reg, scroller });
      for (const id of snapshots.keys()) if (id <= snapshotId - KEEP_SNAPSHOTS) snapshots.delete(id);
      return { snapshotId, ...snapshot };
    };

    const entryOf = (snapshotId: number, index: number): RegistryEntry => {
      const snap = snapshots.get(snapshotId);
      if (!snap) throw new Error('the page state is outdated (page reloaded); look at the new page state');
      const entry = snap.registry.find((r) => r.index === index);
      if (!entry) throw new Error(`element [${index}] does not exist in the current page state`);
      return entry;
    };

    /** Действие DOM-событиями (фолбэк без CDP, а также select и scroll), затем ждём, пока DOM успокоится. */
    const act = async (action: DomAction, snapshotId: number): Promise<ActionResult> => {
      const snap = snapshots.get(snapshotId);
      if (!snap) return { ok: false, message: 'the page state is outdated (page reloaded); look at the new page state' };
      return performAndSettle(action, { registry: snap.registry, scroller: snap.scroller, win: window });
    };

    // ——— наблюдение за изменениями DOM вокруг CDP-действия («клик ничего не изменил») ———
    let watcher: { observer: MutationObserver; count: number } | null = null;
    const watchStart = () => {
      watcher?.observer.disconnect();
      const w = { observer: new MutationObserver((records) => (w.count += records.length)), count: 0 };
      w.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      watcher = w;
    };
    const watchEnd = async (): Promise<{ mutations: number }> => {
      const settled = await waitForStable(document);
      const before = watcher?.count ?? 0;
      watcher?.observer.disconnect();
      watcher = null;
      return { mutations: before + settled.mutations };
    };

    /** Пользователь кликает элемент — объясняем, видит ли его модель и почему. */
    const pickAndDiagnose = async (maxChars: number, hide: string[]): Promise<Diagnosis | null> => {
      const el = await picker.pick((target) => () => topRect({ index: 0, element: target, target, frames: framesOf(target) }, geom));
      if (!el) return null;
      // Свежий снимок с журналом решений — страница могла измениться с прошлого «Показать».
      const trace = new Map<Element, TraceVerdict>();
      const { snapshot } = collectSnapshot(document, geom, { ignore: isOwn, maxTextChars: maxChars, trace, hideNames: hide });
      const page = serializePage(snapshot, { maxChars });
      return diagnose(el, {
        trace,
        shown: new Set(page.shownIndices),
        totalElements: snapshot.elements.length,
        walkTruncated: snapshot.stats.walkTruncated,
      });
    };

    /**
     * Пользователь кликает элемент, который надо скрыть от модели. Правило строится для того
     * элемента, который видит модель (кнопка, а не иконка внутри неё).
     */
    const pickHideRule = async (maxChars: number, hide: string[], preferSelector: boolean): Promise<HidePick | null> => {
      const el = await picker.pick((target) => () => topRect({ index: 0, element: target, target, frames: framesOf(target) }, geom));
      if (!el) return null;
      const trace = new Map<Element, TraceVerdict>();
      collectSnapshot(document, geom, { ignore: isOwn, maxTextChars: maxChars, trace, hideNames: hide });
      let target = el;
      let alreadyHidden = false;
      for (let n: Element | null = el; n; n = n.parentElement ?? (n.getRootNode() as Partial<ShadowRoot>).host ?? null) {
        const v = trace.get(n);
        if (v?.kind === 'accepted') {
          target = n;
          break;
        }
        if (v?.kind === 'skipped' && v.reason === 'user-hidden') {
          target = n;
          alreadyHidden = true;
          break;
        }
      }
      const suggestion = suggestHideRule(target, accessibleName(target, geom), preferSelector);
      return { element: describeElement(target), rule: suggestion.rule, matches: suggestion.matches, alreadyHidden, url: location.href };
    };

    const handle = async (msg: ContentRequest): Promise<Result<unknown>> => {
      switch (msg.type) {
        case 'content:ping':
          return { ok: true, value: 'pong' };
        case 'content:frame-tag':
          return { ok: true, value: tagChildFrames() };
        case 'content:frame-info':
          return { ok: true, value: frameInfo() };
        case 'content:frame-box': {
          const frame = childFrames.get(msg.token);
          return { ok: true, value: frame?.isConnected ? geom.frameContentBox(frame) : null };
        }
        case 'content:observe':
          return { ok: true, value: observe(msg.maxChars, msg.hide, msg.next ?? [], msg.indexBase, msg.frame) };
        case 'content:show': {
          const snap = snapshots.get(msg.snapshotId);
          if (snap) registry = snap.registry;
          shown = msg.shown;
          highlight(msg.highlight);
          return { ok: true, value: null };
        }
        case 'content:highlight':
          highlight(msg.enabled);
          return { ok: true, value: null };
        case 'content:target-point':
          return { ok: true, value: findClickPoint(entryOf(msg.snapshotId, msg.index), geom, !msg.noScroll) };
        case 'content:focus-select':
          selectFieldContent(entryOf(msg.snapshotId, msg.index).element);
          return { ok: true, value: null };
        case 'content:read-value':
          return { ok: true, value: readFieldValue(entryOf(msg.snapshotId, msg.index).element) };
        case 'content:watch-start':
          watchStart();
          return { ok: true, value: null };
        case 'content:watch-end':
          return { ok: true, value: await watchEnd() };
        case 'content:cursor':
          await cursor.moveTo(msg.x, msg.y, msg.durationMs);
          if (msg.click) cursor.click();
          cursor.hideLater();
          return { ok: true, value: null };
        case 'content:pick':
          return { ok: true, value: await pickAndDiagnose(msg.maxChars, msg.hide) };
        case 'content:pick-rule':
          return { ok: true, value: await pickHideRule(msg.maxChars, msg.hide, msg.preferSelector ?? false) };
        case 'content:pick-cancel':
          picker.cancel();
          return { ok: true, value: null };
        case 'content:act':
          return { ok: true, value: await act(msg.action, msg.snapshotId) };
      }
    };

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      if (!isContentRequest(msg)) return;
      handle(msg).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: errorMessage(err) }));
      return true; // ответ асинхронный (pick ждёт клика, watch-end — тишины)
    });
  },
});
