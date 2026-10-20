import {
  ACTION_NAMES,
  DEFAULT_WAIT_FOR_MS,
  KEY_NAMES,
  MAX_WAIT_MS,
  PAGE_CHANGING_ACTIONS,
  TERMINAL_ACTIONS,
  type ActionName,
  type AgentAction,
  type KeyName,
  type AgentStep,
} from './actions';

export type ParseResult =
  | { ok: true; step: AgentStep; warnings: string[] }
  | { ok: false; error: string };

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Блоки рассуждений, которые некоторые серверы оставляют прямо в content. */
const THINK_TAGS = ['think', 'thinking', 'reasoning', 'thought'];

/**
 * Убирает рассуждения thinking-моделей: <think>…</think> и т.п., а также
 * незакрытый блок в начале ответа (модель упёрлась в лимит, не дойдя до ответа).
 */
export function stripThinking(text: string): string {
  let out = text;
  for (const tag of THINK_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '');
    // Только закрывающий тег: открывающий съел шаблон чата (так делает Qwen3 в некоторых серверах).
    const close = new RegExp(`^[\\s\\S]*?</${tag}>`, 'i');
    if (!new RegExp(`<${tag}>`, 'i').test(out)) out = out.replace(close, '');
    // Незакрытый открывающий — всё после него рассуждения.
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, 'i'), '');
  }
  // gpt-oss (harmony), если сервер не разобрал каналы: берём только финальный канал.
  const final = /<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|$)/.exec(out);
  if (final) out = final[1]!;
  return out.trim();
}

/** Все сбалансированные JSON-объекты верхнего уровня в тексте (с учётом строк и экранирования). */
export function findJsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/** Мелкий ремонт частых ошибок: висячие запятые, «умные» кавычки вокруг ключей и строк. */
function repairJson(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(repairJson(s));
    } catch {
      return undefined;
    }
  }
}

const ACTION_ALIASES: Record<string, ActionName> = {
  input: 'type',
  fill: 'type',
  type_text: 'type',
  input_text: 'type',
  select_option: 'select',
  goto: 'navigate',
  go_to: 'navigate',
  go_to_url: 'navigate',
  open: 'navigate',
  open_url: 'navigate',
  back: 'go_back',
  open_tab: 'new_tab',
  finish: 'done',
  complete: 'done',
  answer: 'done',
  ask: 'ask_user',
  click_element: 'click',
  mouse_over: 'hover',
  hover_element: 'hover',
  key: 'press_key',
  press: 'press_key',
  keypress: 'press_key',
  drag_and_drop: 'drag',
  drag_drop: 'drag',
  wait_for_text: 'wait_for',
};

const KEY_ALIASES: Record<string, KeyName> = {
  esc: 'Escape',
  down: 'ArrowDown',
  up: 'ArrowUp',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  'shift-tab': 'Shift+Tab',
  shift_tab: 'Shift+Tab',
};

/** «escape», «Esc», «arrowdown» → имя из KEY_NAMES; null — клавиша не разрешена. */
function keyName(raw: unknown): KeyName | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase().replace(/\s+/g, '');
  return KEY_NAMES.find((n) => n.toLowerCase() === k) ?? KEY_ALIASES[k] ?? null;
}

function actionName(raw: unknown): ActionName | null {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().toLowerCase();
  if ((ACTION_NAMES as readonly string[]).includes(n)) return n as ActionName;
  return ACTION_ALIASES[n] ?? null;
}

/** 12, "12", "[12]" → 12 */
function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*\[?\s*(\d+)\s*\]?\s*$/.exec(v);
    if (m) return Number(m[1]);
  }
  return null;
}

function toText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function pick(r: Rec, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
}

type ActionResult = { ok: true; action: AgentAction } | { ok: false; error: string };

/** Приводит одно действие к строгому типу, принимая распространённые вариации полей. */
export function normalizeAction(raw: unknown): ActionResult {
  if (!isRecord(raw)) return { ok: false, error: 'action must be a JSON object' };

  let r: Rec = raw;
  let name = actionName(pick(r, 'action', 'type', 'name', 'tool'));
  // Вид {"click": {"index": 3}}
  if (!name) {
    const keys = Object.keys(r).filter((k) => actionName(k));
    if (keys.length === 1) {
      name = actionName(keys[0]);
      const inner = r[keys[0]!];
      r = isRecord(inner) ? inner : {};
    }
  }
  // «type» — и имя действия, и поле: {"action":"type",...} — нормально; {"type":"type"} тоже.
  if (!name) {
    const given = pick(r, 'action', 'name');
    return { ok: false, error: `unknown action ${JSON.stringify(given ?? null)}; valid: ${ACTION_NAMES.join(', ')}` };
  }

  const need = (field: string, v: unknown): string => `"${name}" requires ${field}, got ${JSON.stringify(v ?? null)}`;
  const indexOf = () => toInt(pick(r, 'index', 'element', 'element_index', 'element_id', 'id'));

  switch (name) {
    case 'click': {
      const index = indexOf();
      return index !== null && index >= 1 ? { ok: true, action: { action: name, index } } : { ok: false, error: need('integer "index" >= 1', r.index) };
    }
    case 'type': {
      const index = indexOf();
      const text = toText(pick(r, 'text', 'value', 'content'));
      if (index === null || index < 1) return { ok: false, error: need('integer "index" >= 1', r.index) };
      if (text === null) return { ok: false, error: need('string "text"', r.text) };
      const submit = pick(r, 'submit', 'enter', 'press_enter');
      return { ok: true, action: { action: name, index, text, submit: submit === true || submit === 'true' } };
    }
    case 'select': {
      const index = indexOf();
      const value = toText(pick(r, 'value', 'option', 'text'));
      if (index === null || index < 1) return { ok: false, error: need('integer "index" >= 1', r.index) };
      if (value === null) return { ok: false, error: need('string "value"', r.value) };
      return { ok: true, action: { action: name, index, value } };
    }
    case 'scroll': {
      const dir = toText(pick(r, 'direction', 'dir'))?.toLowerCase() ?? 'down';
      if (dir !== 'up' && dir !== 'down') return { ok: false, error: need('"direction" up|down', r.direction) };
      const rawAmount = Number(pick(r, 'amount', 'pages') ?? 1);
      const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? Math.min(rawAmount, 10) : 1;
      const index = indexOf();
      return { ok: true, action: index !== null && index >= 1 ? { action: name, direction: dir, amount, index } : { action: name, direction: dir, amount } };
    }
    case 'hover': {
      const index = indexOf();
      return index !== null && index >= 1 ? { ok: true, action: { action: name, index } } : { ok: false, error: need('integer "index" >= 1', r.index) };
    }
    case 'press_key': {
      const key = keyName(pick(r, 'key', 'keys', 'name', 'value'));
      if (key) return { ok: true, action: { action: name, key } };
      return { ok: false, error: `"press_key" requires "key", one of: ${KEY_NAMES.join(', ')} (got ${JSON.stringify(r.key ?? null)}); for Enter use "type" with "submit": true, to press a button use "click"` };
    }
    case 'drag': {
      const index = indexOf();
      const to = toInt(pick(r, 'to_index', 'to', 'target', 'target_index', 'drop_index'));
      if (index === null || index < 1) return { ok: false, error: need('integer "index" >= 1', r.index) };
      if (to === null || to < 1) return { ok: false, error: need('integer "to_index" >= 1', r.to_index) };
      return { ok: true, action: { action: name, index, to_index: to } };
    }
    case 'wait_for': {
      const text = toText(pick(r, 'text', 'value', 'content'))?.trim();
      if (!text) return { ok: false, error: need('string "text"', r.text) };
      const ms = Number(pick(r, 'timeout_ms', 'timeout', 'ms') ?? DEFAULT_WAIT_FOR_MS);
      const timeout = Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), MAX_WAIT_MS) : DEFAULT_WAIT_FOR_MS;
      return { ok: true, action: { action: name, text, timeout_ms: timeout } };
    }
    case 'navigate':
    case 'new_tab': {
      const url = toText(pick(r, 'url', 'href', 'link'))?.trim();
      if (!url && name === 'navigate') return { ok: false, error: need('string "url"', r.url) };
      return { ok: true, action: { action: name, url: url ?? 'about:blank' } };
    }
    case 'go_back':
      return { ok: true, action: { action: name } };
    case 'wait': {
      const ms = Number(pick(r, 'ms', 'milliseconds', 'duration') ?? 1000);
      return { ok: true, action: { action: name, ms: Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), MAX_WAIT_MS) : 1000 } };
    }
    case 'switch_tab': {
      const id = toInt(pick(r, 'tab_id', 'tabId', 'id', 'tab'));
      return id !== null ? { ok: true, action: { action: name, tab_id: id } } : { ok: false, error: need('integer "tab_id"', r.tab_id) };
    }
    case 'extract': {
      const note = toText(pick(r, 'note', 'data', 'text', 'content'));
      return note !== null ? { ok: true, action: { action: name, note } } : { ok: false, error: need('string "note"', r.note) };
    }
    case 'done': {
      const result = toText(pick(r, 'result', 'answer', 'text', 'summary', 'message')) ?? '';
      return { ok: true, action: { action: name, result } };
    }
    case 'ask_user': {
      const question = toText(pick(r, 'question', 'text', 'message'));
      return question ? { ok: true, action: { action: name, question } } : { ok: false, error: need('string "question"', r.question) };
    }
  }
}

interface RawStep {
  raw: unknown[];
  reasoning: string;
  expected: string;
  risky: boolean;
}

function rootToStep(root: unknown): RawStep | null {
  if (Array.isArray(root)) return { raw: root, reasoning: '', expected: '', risky: false };
  if (!isRecord(root)) return null;
  const reasoning = toText(pick(root, 'reasoning', 'thought', 'thoughts', 'reason', 'thinking')) ?? '';
  const expected = toText(pick(root, 'expected_outcome', 'expected', 'expectation', 'expected_result')) ?? '';
  const flag = pick(root, 'risky', 'irreversible', 'needs_confirmation');
  const risky = flag === true || flag === 'true';
  const actions = root.actions;
  if (Array.isArray(actions)) return { raw: actions, reasoning, expected, risky };
  if (isRecord(actions)) return { raw: [actions], reasoning, expected, risky };
  // Одно действие прямо в корне.
  if (normalizeAction(root).ok) return { raw: [root], reasoning, expected, risky };
  if (isRecord(root.action)) return { raw: [root.action], reasoning, expected, risky };
  return null;
}

/**
 * Разбирает ответ модели в шаг агента. Терпим к рассуждениям, markdown-ограждениям,
 * тексту вокруг JSON и вариациям полей; строг к смыслу (номера, обязательные поля).
 * Ошибка формулируется так, чтобы её можно было вернуть модели для исправления.
 */
export function parseAgentStep(text: string, maxActions: number): ParseResult {
  const clean = stripThinking(text).replace(/```(?:json)?/gi, '');
  if (!clean) return { ok: false, error: 'empty reply (only reasoning, no JSON)' };

  const candidates: unknown[] = [];
  const whole = tryParse(clean);
  if (whole !== undefined) candidates.push(whole);
  for (const obj of findJsonObjects(clean).reverse()) {
    const v = tryParse(obj);
    if (v !== undefined) candidates.push(v);
  }
  if (candidates.length === 0) return { ok: false, error: 'no valid JSON object found in the reply' };

  let lastError = 'JSON does not contain "actions"';
  for (const candidate of candidates) {
    const root = rootToStep(candidate);
    if (!root) continue;
    if (root.raw.length === 0) {
      lastError = '"actions" is empty — return at least one action';
      continue;
    }

    const actions: AgentAction[] = [];
    let error: string | null = null;
    for (const [i, raw] of root.raw.entries()) {
      const res = normalizeAction(raw);
      if (!res.ok) {
        error = `actions[${i}]: ${res.error}`;
        break;
      }
      actions.push(res.action);
    }
    if (error) {
      lastError = error;
      continue;
    }

    const warnings: string[] = [];
    // После завершающего или меняющего страницу действия остальное бессмысленно.
    const cut = actions.findIndex((a) => TERMINAL_ACTIONS.has(a.action) || PAGE_CHANGING_ACTIONS.has(a.action));
    if (cut !== -1 && cut < actions.length - 1) {
      warnings.push(`dropped ${actions.length - cut - 1} action(s) after "${actions[cut]!.action}"`);
      actions.length = cut + 1;
    }
    if (actions.length > maxActions) {
      warnings.push(`dropped ${actions.length - maxActions} action(s) over the limit of ${maxActions}`);
      actions.length = maxActions;
    }
    const step: AgentStep = { reasoning: root.reasoning, expected_outcome: root.expected, actions };
    if (root.risky) step.risky = true;
    return { ok: true, step, warnings };
  }
  return { ok: false, error: lastError };
}
