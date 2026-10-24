import { describe, expect, it } from 'vitest';
import { buildFrameTree, completeSingleFrame, mergeObservations, type FrameNode, type RawFrameObservation } from '@/lib/frames';
import type { ElementInfo } from '@/lib/dom/types';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('buildFrameTree', () => {
  it('сопоставляет iframe с другого сайта по токену и считает сдвиг и видимую область', () => {
    const nodes = buildFrameTree(
      [
        { frameId: 0, children: [{ token: 't-editor', box: box(100, 200, 900, 600), visible: true }] },
        { frameId: 7, children: [{ token: 't-inner', box: box(10, 20, 300, 100), visible: true }] },
      ],
      [
        { frameId: 0, parentToken: null, sameOriginWithParent: false, url: 'https://practicum.yandex.ru/learn/' },
        { frameId: 7, parentToken: 't-editor', sameOriginWithParent: false, url: 'https://sandbox.practicum-team.ru/' },
        { frameId: 9, parentToken: 't-inner', sameOriginWithParent: false, url: 'https://preview.example/' },
      ],
    );
    expect(nodes.map((n) => [n.frameId, n.parentFrameId, n.offset])).toEqual([
      [0, null, { x: 0, y: 0 }],
      [7, 0, { x: 100, y: 200 }],
      [9, 7, { x: 110, y: 220 }],
    ]);
    expect(nodes[1]!.clip).toEqual(box(100, 200, 900, 600));
    expect(nodes[2]!.clip).toEqual(box(110, 220, 300, 100));
    expect(nodes[1]!.token).toBe('t-editor');
  });

  it('пропускает фреймы того же origin, невидимые, нулевые и не опознанные', () => {
    const nodes = buildFrameTree(
      [
        {
          frameId: 0,
          children: [
            { token: 'hidden', box: box(0, 0, 900, 600), visible: false },
            { token: 'pixel', box: box(0, 0, 0, 0), visible: true },
            { token: 'orphan', box: box(0, 0, 500, 500), visible: true },
          ],
        },
      ],
      [
        { frameId: 0, parentToken: null, sameOriginWithParent: false, url: 'https://a/' },
        { frameId: 2, parentToken: 'hidden', sameOriginWithParent: false, url: 'https://b/' },
        { frameId: 3, parentToken: 'pixel', sameOriginWithParent: false, url: 'https://pixels/' },
        { frameId: 4, parentToken: null, sameOriginWithParent: true, url: 'about:blank' },
      ],
    );
    expect(nodes.map((n) => n.frameId)).toEqual([0]);
  });

  it('фрейм, вложенный в обрезанный родитель, обрезается его границей', () => {
    const nodes = buildFrameTree(
      [
        { frameId: 0, children: [{ token: 'a', box: box(0, 0, 400, 300), visible: true }] },
        { frameId: 1, children: [{ token: 'b', box: box(300, 200, 400, 400), visible: true }] },
      ],
      [
        { frameId: 0, parentToken: null, sameOriginWithParent: false, url: 'https://top/' },
        { frameId: 1, parentToken: 'a', sameOriginWithParent: false, url: 'https://a/' },
        { frameId: 2, parentToken: 'b', sameOriginWithParent: false, url: 'https://b/' },
      ],
    );
    expect(nodes[2]!.clip).toEqual(box(300, 200, 100, 100));
  });
});

describe('mergeObservations', () => {
  const el = (index: number, name: string): ElementInfo => ({
    index,
    tag: 'button',
    name,
    attrs: [],
    states: [],
    zone: 'visible',
    distance: 0,
    rect: box(0, 0, 10, 10),
  });
  const obs = (patch: Partial<RawFrameObservation>): RawFrameObservation => ({
    snapshotId: 1,
    url: 'https://practicum.yandex.ru/learn/',
    title: 'Урок',
    scroll: { x: 0, y: 100, maxY: 900, viewportWidth: 1000, viewportHeight: 800 },
    elements: [],
    text: '',
    stats: { nodesVisited: 10, walkTruncated: false, covered: 1, offscreen: 0, hidden: 2, userHidden: 0 },
    ...patch,
  });
  const node = (frameId: number): FrameNode => ({ frameId, parentFrameId: frameId ? 0 : null, token: null, url: '', offset: { x: 0, y: 0 }, clip: box(0, 0, 1, 1) });

  it('элементы по номерам, текст фрейма под своей подписью, статистика суммируется, адрес — верхний', () => {
    const merged = mergeObservations([
      { node: node(0), obs: obs({ elements: [el(1, 'Назад'), el(2, 'Далее')], text: 'Текст урока [2]' }) },
      {
        node: node(7),
        obs: obs({ url: 'https://sandbox.practicum-team.ru/x', title: 'sandbox', elements: [el(3, 'Проверить')], text: 'index.html [3]' }),
      },
    ]);
    expect(merged.url).toBe('https://practicum.yandex.ru/learn/');
    expect(merged.scroll.y).toBe(100);
    expect(merged.elements.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(merged.text).toBe('Текст урока [2]\n[embedded frame sandbox.practicum-team.ru]\nindex.html [3]');
    expect(merged.stats).toMatchObject({ nodesVisited: 20, covered: 2, hidden: 4 });
  });
});


describe('conservative completeness metadata', () => {
  const node: FrameNode = { frameId: 0, parentFrameId: null, token: null, url: '', offset: { x: 0, y: 0 }, clip: box(0, 0, 100, 100) };
  const obs: RawFrameObservation = { snapshotId: 1, url: '', title: '', scroll: { x: 0, y: 0, maxY: 0, viewportWidth: 100, viewportHeight: 100 }, elements: [], text: 'short', stats: { textTruncated: false, nodesVisited: 2, walkTruncated: false, covered: 0, offscreen: 0, hidden: 0, userHidden: 0 } };
  const tags = [{ frameId: 0, children: [] }];
  const infos = [{ frameId: 0, parentToken: null, sameOriginWithParent: false, url: '' }];
  const page = { textTruncated: false, omittedElements: 0 };
  it('only marks fully known single-frame collections complete', () => {
    expect(completeSingleFrame([0], tags, infos, [{ node, obs }], page)).toBe(true);
    expect(completeSingleFrame([0, 2], tags, infos, [{ node, obs }], page)).toBe(false);
    expect(completeSingleFrame([0], [], infos, [{ node, obs }], page)).toBe(false);
    expect(completeSingleFrame([0], tags, [], [{ node, obs }], page)).toBe(false);
    expect(completeSingleFrame([0], tags, infos, [], page)).toBe(false);
    expect(completeSingleFrame([0], [{ frameId: 0, children: [{ token: 'unknown', box: box(0, 0, 10, 10), visible: true }] }], infos, [{ node, obs }], page)).toBe(false);
  });
  it('unknown, collection/serializer truncation, omissions and walk limits prevent completeness', () => {
    for (const textTruncated of [undefined, true]) expect(completeSingleFrame([0], tags, infos, [{ node, obs: { ...obs, stats: { ...obs.stats, textTruncated } } }], page)).toBe(false);
    expect(completeSingleFrame([0], tags, infos, [{ node, obs: { ...obs, stats: { ...obs.stats, walkTruncated: true } } }], page)).toBe(false);
    expect(completeSingleFrame([0], tags, infos, [{ node, obs }], { ...page, textTruncated: true })).toBe(false);
    expect(completeSingleFrame([0], tags, infos, [{ node, obs }], { ...page, omittedElements: 1 })).toBe(false);
  });
  it('merged unknown metadata remains conservative without changing rendered content', () => {
    const known = mergeObservations([{ node, obs }]);
    expect(known.stats.textTruncated).toBe(false);
    const unknown = mergeObservations([{ node, obs: { ...obs, stats: { ...obs.stats, textTruncated: undefined } } }]);
    expect(unknown.stats.textTruncated).toBe(true);
    expect(unknown.text).toBe(known.text);
    expect(unknown.elements).toEqual(known.elements);
  });
});
