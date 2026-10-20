export type ScrollDirection = 'up' | 'down';

/**
 * Клавиши для press_key. Только навигация: Enter и пробел на кнопке — это клик или отправка формы,
 * их риск проверяется через click и type с submit, а не через «просто клавишу».
 */
export const KEY_NAMES = ['Escape', 'Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export type AgentAction =
  | { action: 'click'; index: number }
  | { action: 'type'; index: number; text: string; submit: boolean }
  | { action: 'select'; index: number; value: string }
  /** index — прокрутить область, в которой лежит этот элемент (список, чат, боковая панель), а не страницу. */
  | { action: 'scroll'; direction: ScrollDirection; amount: number; index?: number }
  | { action: 'hover'; index: number }
  | { action: 'press_key'; key: KeyName }
  | { action: 'drag'; index: number; to_index: number }
  | { action: 'wait_for'; text: string; timeout_ms: number }
  | { action: 'navigate'; url: string }
  | { action: 'go_back' }
  | { action: 'wait'; ms: number }
  | { action: 'new_tab'; url: string }
  | { action: 'switch_tab'; tab_id: number }
  | { action: 'extract'; note: string }
  | { action: 'done'; result: string }
  | { action: 'ask_user'; question: string };

export type ActionName = AgentAction['action'];

/** Решение модели на один шаг: цепочка действий с общим обоснованием. */
export interface AgentStep {
  reasoning: string;
  expected_outcome: string;
  actions: AgentAction[];
  /** Модель считает шаг необратимым. Может только добавить подтверждение, снять — нет. */
  risky?: boolean;
}

export const ACTION_NAMES: readonly ActionName[] = [
  'click',
  'type',
  'select',
  'scroll',
  'hover',
  'press_key',
  'drag',
  'wait_for',
  'navigate',
  'go_back',
  'wait',
  'new_tab',
  'switch_tab',
  'extract',
  'done',
  'ask_user',
];

/** Завершают задачу или передают управление человеку — после них ничего не выполняется. */
export const TERMINAL_ACTIONS: ReadonlySet<ActionName> = new Set(['done', 'ask_user']);
/** Меняют страницу/вкладку — номера элементов после них недействительны. */
export const PAGE_CHANGING_ACTIONS: ReadonlySet<ActionName> = new Set(['navigate', 'go_back', 'new_tab', 'switch_tab']);

export const MAX_WAIT_MS = 30_000;
export const DEFAULT_WAIT_FOR_MS = 10_000;

type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const int = (minimum: number): JsonSchema => ({ type: 'integer', minimum });

function actionSchema(name: ActionName, props: Record<string, JsonSchema> = {}, optional: string[] = []): JsonSchema {
  const required = ['action', ...Object.keys(props).filter((k) => !optional.includes(k))];
  return {
    type: 'object',
    properties: { action: { type: 'string', enum: [name] }, ...props },
    required,
    additionalProperties: false,
  };
}

/**
 * JSON Schema ответа для response_format. Только конструкции, которые понимает
 * конвертер схем в грамматику llama.cpp (его же использует Ollama): enum, anyOf, required, maxItems.
 */
export function agentResponseSchema(maxActions: number): JsonSchema {
  return {
    type: 'object',
    properties: {
      reasoning: str(),
      expected_outcome: str(),
      risky: { type: 'boolean' },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: maxActions,
        items: {
          anyOf: [
            actionSchema('click', { index: int(1) }),
            actionSchema('type', { index: int(1), text: str(), submit: { type: 'boolean' } }, ['submit']),
            actionSchema('select', { index: int(1), value: str() }),
            actionSchema('scroll', { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' }, index: int(1) }, ['amount', 'index']),
            actionSchema('hover', { index: int(1) }),
            actionSchema('press_key', { key: { type: 'string', enum: [...KEY_NAMES] } }),
            actionSchema('drag', { index: int(1), to_index: int(1) }),
            actionSchema('wait_for', { text: str(), timeout_ms: int(0) }, ['timeout_ms']),
            actionSchema('navigate', { url: str() }),
            actionSchema('go_back'),
            actionSchema('wait', { ms: int(0) }),
            actionSchema('new_tab', { url: str() }),
            actionSchema('switch_tab', { tab_id: int(0) }),
            actionSchema('extract', { note: str() }),
            actionSchema('done', { result: str() }),
            actionSchema('ask_user', { question: str() }),
          ],
        },
      },
    },
    required: ['reasoning', 'expected_outcome', 'actions'],
    additionalProperties: false,
  };
}

/** Номер элемента, с которым работает действие (у scroll — необязательный). */
export function targetIndex(a: AgentAction): number | undefined {
  return 'index' in a ? a.index : undefined;
}

/** Короткая запись действия для UI и истории: `click [12]`, `type [3] "почта" ⏎`. */
export function formatAction(a: AgentAction): string {
  const q = (s: string, max = 60) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
  switch (a.action) {
    case 'click':
      return `click [${a.index}]`;
    case 'type':
      return `type [${a.index}] ${q(a.text)}${a.submit ? ' ⏎' : ''}`;
    case 'select':
      return `select [${a.index}] ${q(a.value)}`;
    case 'scroll':
      return `scroll ${a.direction} ${a.amount}${a.index !== undefined ? ` in [${a.index}]` : ''}`;
    case 'hover':
      return `hover [${a.index}]`;
    case 'press_key':
      return `press_key ${a.key}`;
    case 'drag':
      return `drag [${a.index}] → [${a.to_index}]`;
    case 'wait_for':
      return `wait_for ${q(a.text)} ${a.timeout_ms}ms`;
    case 'navigate':
      return `navigate ${a.url}`;
    case 'go_back':
      return 'go_back';
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'new_tab':
      return `new_tab ${a.url}`;
    case 'switch_tab':
      return `switch_tab ${a.tab_id}`;
    case 'extract':
      return `extract ${q(a.note, 120)}`;
    case 'done':
      return `done ${q(a.result, 120)}`;
    case 'ask_user':
      return `ask_user ${q(a.question, 120)}`;
  }
}
