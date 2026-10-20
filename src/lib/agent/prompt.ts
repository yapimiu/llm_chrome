import { imageCount, messageText, type ChatMessage } from '../llm/client';

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface StepPromptInput {
  /** Шаблон системного промпта из src/prompts/system.md. */
  systemTemplate: string;
  task: string;
  /** Текст наблюдения от content script. */
  observation: string;
  tabs: TabInfo[];
  /** Случайная метка границ страницы — постоянна в пределах задачи (не ломает кэш префикса сервера). */
  boundary: string;
  maxActions: number;
  /** Сжатая история предыдущих шагов (этап 4). */
  history?: string;
  /** Заметки пользователя для текущего сайта. */
  siteNotes?: string;
  /** Скриншот видимой части страницы с номерами элементов (data:-адрес) — для моделей со зрением. */
  image?: string;
}

const MAX_TABS = 12;
const MAX_TAB_TITLE = 60;
const MAX_TAB_URL = 80;

export function newBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatTabs(tabs: readonly TabInfo[]): string {
  if (tabs.length === 0) return 'Open tabs: none';
  const lines = tabs.slice(0, MAX_TABS).map((t) => `[tab ${t.id}]${t.active ? ' (current)' : ''} ${cut(t.title || 'untitled', MAX_TAB_TITLE)} — ${cut(t.url, MAX_TAB_URL)}`);
  if (tabs.length > MAX_TABS) lines.push(`… and ${tabs.length - MAX_TABS} more tabs`);
  return ['Open tabs:', ...lines].join('\n');
}

/** Страница не должна суметь «закрыть» блок данных и дописать свои инструкции. */
function neutralizeMarkers(text: string, boundary: string): string {
  return text.split(boundary).join('[removed]');
}

/**
 * Сообщения для одного шага. Изменчивая часть (страница) — в самом конце,
 * чтобы сервер переиспользовал кэш префикса (системный промпт + задача + история).
 */
export function buildStepMessages(input: StepPromptInput): ChatMessage[] {
  const system = renderTemplate(input.systemTemplate, { MAX_ACTIONS: input.maxActions, BOUNDARY: input.boundary });
  const page = neutralizeMarkers(`${formatTabs(input.tabs)}\n\n${input.observation}`, input.boundary);
  const parts = [`TASK:\n${input.task.trim()}`];
  if (input.history?.trim()) parts.push(`HISTORY:\n${input.history.trim()}`);
  parts.push(`PAGE STATE:\n===== BEGIN PAGE ${input.boundary} =====\n${page}\n===== END PAGE ${input.boundary} =====`);
  // Заметки — в самом конце: маленькие модели лучше всего слушаются последнего перед ответом.
  // Страница и так меняется каждый шаг, поэтому кэш префикса на сервере от этого не страдает.
  if (input.siteNotes?.trim()) {
    parts.push(`SITE NOTES (from the user, about this website — they override your own guesses):\n${input.siteNotes.trim()}`);
  }
  if (input.image) parts.push('SCREENSHOT: attached below — the visible part of the page; boxes with numbers are the [index] of elements from PAGE STATE.');
  parts.push('Reply with the JSON object for the next step.');
  const text = parts.join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: input.image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: input.image } }] : text },
  ];
}

/** Сообщение-поправка после неразборчивого ответа. */
export function correctionMessage(error: string, truncated: boolean): ChatMessage {
  const hint = truncated ? ' Your reply was cut off by the token limit — keep reasoning shorter.' : '';
  return {
    role: 'user',
    content: `Your previous reply could not be used: ${error}.${hint} Reply again with exactly one JSON object in the required format and nothing else.`,
  };
}

/** Сколько токенов в среднем стоит скриншот ~1280×800 у визуальных моделей. */
export const IMAGE_TOKENS = 1000;

/** Грубая оценка токенов: ~3 символа на токен для смеси кириллицы, латиницы и разметки; картинка — IMAGE_TOKENS. */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  const text = messages.reduce((n, m) => n + messageText(m).length + 8, 0);
  return Math.ceil(text / 3) + messages.reduce((n, m) => n + imageCount(m) * IMAGE_TOKENS, 0);
}

/** Строка элемента из наблюдения по номеру: `[12] button "Войти"` → `button "Войти"`. */
export function elementLine(observation: string, index: number): string | undefined {
  const prefix = `[${index}] `;
  return observation.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length);
}
