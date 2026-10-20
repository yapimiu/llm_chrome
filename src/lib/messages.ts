import { browser } from '#imports';
import type { CourseState } from './agent/course';
import type { Macro, ReplayState } from './agent/macro';
import type { StepEvent } from './agent/step';
import type { ActionResult, DeferredItem, RunState, RunSummary, StepDetail } from './agent/types';
import type { ClickPoint } from './dom/act';
import type { Rect } from './dom/types';
import type { FrameChildTag, RawFrameObservation } from './frames';
import type { DomAction } from './dom/act';
import type { Diagnosis } from './dom/diagnose';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ObserveStats {
  url: string;
  totalElements: number;
  shownElements: number;
  omittedElements: number;
  covered: number;
  hidden: number;
  offscreen: number;
  userHidden: number;
  chars: number;
  maxChars: number;
  textTruncated: boolean;
  walkTruncated: boolean;
  durationMs: number;
}

export interface ObserveResult {
  /** Ровно то, что уйдёт модели как наблюдение. */
  text: string;
  stats: ObserveStats;
}

/** Где этот фрейм лежит в верхней странице (для сбора внутри iframe с другого сайта). */
export interface FrameGeometry {
  offset: { x: number; y: number };
  clip: Rect;
  viewport: { width: number; height: number };
}

export interface FrameInfo {
  parentToken: string | null;
  sameOriginWithParent: boolean;
  url: string;
  viewport: { width: number; height: number };
}

/** Элемент, выбранный мышью для «Скрыть от модели». */
export interface HidePick {
  /** `button.prisma-button "Мои курсы"` — чтобы человек узнал элемент. */
  element: string;
  /** Предложенное правило: текст или `css: селектор`. */
  rule: string;
  /** Сколько элементов на странице попадает под правило. */
  matches: number;
  /** Элемент уже скрыт существующим правилом. */
  alreadyHidden: boolean;
  url: string;
}

/** background → content script */
export type ContentRequest =
  | { type: 'content:ping' }
  | { type: 'content:observe'; maxChars: number; hide: string[]; next?: string[]; indexBase: number; frame?: FrameGeometry }
  /** После склейки фреймов: какие номера попали в текст — их и подсвечиваем. */
  | { type: 'content:show'; snapshotId: number; shown: number[]; highlight: boolean }
  | { type: 'content:frame-tag' }
  | { type: 'content:frame-info' }
  | { type: 'content:frame-box'; token: string }
  | { type: 'content:target-point'; snapshotId: number; index: number; noScroll?: boolean }
  | { type: 'content:focus-select'; snapshotId: number; index: number }
  | { type: 'content:read-value'; snapshotId: number; index: number }
  | { type: 'content:watch-start' }
  | { type: 'content:watch-end' }
  | { type: 'content:cursor'; x: number; y: number; durationMs: number; click: boolean }
  | { type: 'content:highlight'; enabled: boolean }
  /** Режим выбора элемента мышью; ответ приходит после клика (null — отмена по Esc). */
  | { type: 'content:pick'; maxChars: number; hide: string[] }
  | { type: 'content:pick-cancel' }
  /** Выбор элемента мышью, чтобы скрыть его от модели: ответ — предложенное правило. */
  | { type: 'content:pick-rule'; maxChars: number; hide: string[]; preferSelector?: boolean }
  | { type: 'content:act'; action: DomAction; snapshotId: number };

/** UI → background */
export type BackgroundRequest =
  | { type: 'bg:observe'; windowId: number; highlight: boolean }
  | { type: 'bg:highlight'; windowId: number; enabled: boolean }
  /** Скриншот с номерами элементов — ровно то, что увидит модель со зрением. */
  | { type: 'bg:screenshot'; windowId: number }
  | { type: 'bg:run-start'; windowId: number; task: string }
  | { type: 'bg:run-control'; command: 'pause' | 'resume' | 'stop' }
  | { type: 'bg:run-approve'; approved: boolean }
  | { type: 'bg:run-answer'; text: string }
  | { type: 'bg:run-get' }
  | { type: 'bg:run-detail'; runId: string; n: number }
  | { type: 'bg:runs-list' }
  | { type: 'bg:run-export'; runId: string }
  /** Прерванный перезапуском запуск: продолжить или забыть. */
  | { type: 'bg:run-recover'; command: 'resume' | 'discard' }
  | { type: 'bg:queue-list' }
  /** Утром: начать обычный запуск с отложенного действия. */
  | { type: 'bg:queue-resume'; id: string; windowId: number }
  | { type: 'bg:queue-dismiss'; id: string }
  /** Проверить звук и уведомление из настроек. */
  | { type: 'bg:alert-test' }
  /** Тестовое сообщение в Telegram (настройки ещё могут быть не сохранены). */
  | { type: 'bg:telegram-test'; config: { botToken: string; chatId: string } }
  /** Найти chat id по последнему сообщению боту. */
  | { type: 'bg:telegram-chat-id'; botToken: string }
  /** Пролистывание курса без модели (см. lib/agent/skipper.ts). */
  | { type: 'bg:skip-start'; windowId: number }
  | { type: 'bg:skip-stop' }
  | { type: 'bg:skip-get' }
  /** Сценарии: сохранить запуск, список, удалить, повторить, ответить повтору, передать нейросети. */
  | { type: 'bg:macro-save'; runId: string; name: string }
  | { type: 'bg:macro-list' }
  | { type: 'bg:macro-delete'; id: string }
  | { type: 'bg:macro-run'; id: string; windowId: number }
  | { type: 'bg:macro-stop' }
  | { type: 'bg:macro-get' }
  | { type: 'bg:macro-reply'; approved?: boolean; text?: string | null }
  | { type: 'bg:macro-handoff'; windowId: number };

/** Текущий запуск для панели; interrupted — прерван перезапуском и ждёт «Продолжить». */
export interface RunInfo {
  state: RunState;
  interrupted: boolean;
}

/** background → UI (широковещательно всем страницам расширения) */
export type UiEvent =
  | { type: 'ui:step-progress'; event: StepEvent }
  | { type: 'ui:run-state'; info: RunInfo }
  | { type: 'ui:queue-changed' }
  | { type: 'ui:skip-state'; state: CourseState }
  | { type: 'ui:macro-state'; state: ReplayState }
  | { type: 'ui:macros-changed' };

export function isUiEvent(msg: unknown): msg is UiEvent {
  return hasType(msg, 'ui:');
}

export interface ContentResponses {
  'content:ping': 'pong';
  'content:observe': RawFrameObservation;
  'content:show': null;
  'content:frame-tag': FrameChildTag[];
  'content:frame-info': FrameInfo;
  'content:frame-box': Rect | null;
  'content:target-point': ClickPoint;
  'content:focus-select': null;
  'content:read-value': string | null;
  'content:watch-start': null;
  'content:watch-end': { mutations: number };
  'content:cursor': null;
  'content:highlight': null;
  'content:pick': Diagnosis | null;
  'content:pick-cancel': null;
  'content:pick-rule': HidePick | null;
  'content:act': ActionResult;
}

export interface BackgroundResponses {
  'bg:observe': ObserveResult;
  'bg:highlight': null;
  'bg:screenshot': string;
  'bg:run-start': RunState;
  'bg:run-control': null;
  'bg:run-approve': null;
  'bg:run-answer': null;
  'bg:run-get': RunInfo | null;
  'bg:run-detail': StepDetail | null;
  'bg:runs-list': RunSummary[];
  'bg:run-export': unknown;
  'bg:run-recover': null;
  'bg:queue-list': DeferredItem[];
  'bg:queue-resume': RunState;
  'bg:queue-dismiss': null;
  'bg:alert-test': null;
  'bg:telegram-test': null;
  'bg:telegram-chat-id': string;
  'bg:skip-start': null;
  'bg:skip-stop': null;
  'bg:skip-get': CourseState | null;
  'bg:macro-save': Macro;
  'bg:macro-list': Macro[];
  'bg:macro-delete': null;
  'bg:macro-run': null;
  'bg:macro-stop': null;
  'bg:macro-get': ReplayState | null;
  'bg:macro-reply': null;
  'bg:macro-handoff': RunState;
}

function hasType(msg: unknown, prefix: string): msg is { type: string } {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string' && (msg as { type: string }).type.startsWith(prefix);
}

export const isContentRequest = (msg: unknown): msg is ContentRequest => hasType(msg, 'content:');
export const isBackgroundRequest = (msg: unknown): msg is BackgroundRequest => hasType(msg, 'bg:');

export async function sendToBackground<R extends BackgroundRequest>(req: R): Promise<Result<BackgroundResponses[R['type']]>> {
  try {
    return (await browser.runtime.sendMessage(req)) as Result<BackgroundResponses[R['type']]>;
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
