import { intersect } from './dom/collect';
import type { CollectStats, ElementInfo, PageSnapshot, Rect, ScrollInfo } from './dom/types';

/** iframe с другого сайта, найденный во фрейме-родителе и помеченный токеном. */
export interface FrameChildTag {
  token: string;
  /** Область содержимого iframe в координатах вьюпорта родителя. */
  box: Rect;
  visible: boolean;
}

export interface FrameTagReport {
  frameId: number;
  children: FrameChildTag[];
}

export interface FrameInfoReport {
  frameId: number;
  /** Токен, полученный от родителя через postMessage; null — верхний фрейм или метка не дошла. */
  parentToken: string | null;
  /** Родитель того же origin уже собрал этот фрейм через contentDocument. */
  sameOriginWithParent: boolean;
  url: string;
}

export interface FrameNode {
  frameId: number;
  parentFrameId: number | null;
  /** Токен, по которому родитель находит этот iframe (для пересчёта координат перед кликом). */
  token: string | null;
  url: string;
  /** Сдвиг вьюпорта фрейма относительно вьюпорта верхней страницы. */
  offset: { x: number; y: number };
  /** Видимая область фрейма в координатах верхней страницы. */
  clip: Rect;
}

export const INFINITE_CLIP: Rect = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 };

/**
 * Дерево фреймов, которые нужно собирать отдельно: верхний и iframe с других сайтов.
 * Фреймы того же origin пропускаются — их уже обошёл родитель. Невидимые и не найденные — тоже.
 * Порядок — обход в глубину, как фреймы стоят в документе.
 */
export function buildFrameTree(tags: readonly FrameTagReport[], infos: readonly FrameInfoReport[]): FrameNode[] {
  const byToken = new Map<string, FrameInfoReport>();
  for (const info of infos) if (info.parentToken && !info.sameOriginWithParent) byToken.set(info.parentToken, info);
  const tagsOf = new Map(tags.map((t) => [t.frameId, t.children]));
  const top = infos.find((i) => i.frameId === 0);

  const out: FrameNode[] = [];
  const visit = (node: FrameNode) => {
    out.push(node);
    for (const child of tagsOf.get(node.frameId) ?? []) {
      const info = byToken.get(child.token);
      if (!info || !child.visible || child.box.width <= 1 || child.box.height <= 1) continue;
      const offset = { x: node.offset.x + child.box.x, y: node.offset.y + child.box.y };
      const clip = intersect(node.clip, { ...child.box, x: offset.x, y: offset.y });
      if (!clip) continue;
      visit({ frameId: info.frameId, parentFrameId: node.frameId, token: child.token, url: info.url, offset, clip });
    }
  };
  visit({ frameId: 0, parentFrameId: null, token: null, url: top?.url ?? '', offset: { x: 0, y: 0 }, clip: INFINITE_CLIP });
  return out;
}

/** Что фрейм вернул на observe (без сериализации — её делает background для всех фреймов сразу). */
export interface RawFrameObservation {
  snapshotId: number;
  url: string;
  title: string;
  scroll: ScrollInfo;
  elements: ElementInfo[];
  text: string;
  stats: CollectStats;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Склеивает наблюдения фреймов в один снимок страницы; номера уже глобальные (indexBase). */
export function mergeObservations(parts: readonly { node: FrameNode; obs: RawFrameObservation }[]): PageSnapshot {
  const top = parts.find((p) => p.node.frameId === 0)?.obs ?? parts[0]!.obs;
  const stats: CollectStats = { textTruncated: false, nodesVisited: 0, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 };
  const texts: string[] = [];
  for (const { node, obs } of parts) {
    if (obs.stats.textTruncated !== false) stats.textTruncated = true;
    stats.nodesVisited += obs.stats.nodesVisited;
    stats.walkTruncated ||= obs.stats.walkTruncated;
    stats.covered += obs.stats.covered;
    stats.offscreen += obs.stats.offscreen;
    stats.hidden += obs.stats.hidden;
    stats.userHidden += obs.stats.userHidden;
    if (!obs.text.trim()) continue;
    texts.push(node.frameId === 0 ? obs.text : `[embedded frame ${hostOf(obs.url)}]\n${obs.text}`);
  }
  return {
    url: top.url,
    title: top.title,
    scroll: top.scroll,
    elements: parts.flatMap((p) => p.obs.elements).sort((a, b) => a.index - b.index),
    text: texts.join('\n'),
    stats,
  };
}

/** Conservative: multi-frame or incomplete metadata never enables reduced observations. */
export function completeSingleFrame(frameIds: readonly number[], tags: readonly FrameTagReport[], infos: readonly FrameInfoReport[], parts: readonly { node: FrameNode; obs: RawFrameObservation }[], page: { textTruncated: boolean; omittedElements: number }): boolean {
  const part = parts[0];
  return frameIds.length === 1 &&
    frameIds[0] === 0 &&
    tags.length === 1 &&
    tags[0]?.frameId === 0 &&
    tags[0]?.children.length === 0 &&
    infos.length === 1 &&
    infos[0]?.frameId === 0 &&
    parts.length === 1 &&
    part?.node.frameId === 0 &&
    part.obs.stats.textTruncated === false &&
    part.obs.stats.walkTruncated === false &&
    !page.textTruncated &&
    page.omittedElements === 0;
}
