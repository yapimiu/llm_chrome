import { parseExtraBody, type LlmProfile } from '../settings';
import { providerInfo } from './providers';
import { readSse } from './sse';
import { apiUrl, normalizeBaseUrl } from './url';

export type FetchFn = typeof fetch;

/** Часть мультимодального сообщения (формат OpenAI): текст или картинка data:-адресом. */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Строка или части с картинками — только для моделей, которые видят изображения. */
  content: string | ChatPart[];
}

/** Текст сообщения без картинок. */
export function messageText(m: ChatMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

export const imageCount = (m: ChatMessage): number => (typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image_url').length);

/** Как реально был запрошен структурированный ответ. */
export type StructuredFormat = 'json_schema' | 'json_object' | 'none';

export interface ChatDelta {
  content: string;
  reasoning: string;
}

export interface ChatOptions {
  profile: LlmProfile;
  messages: ChatMessage[];
  /** JSON Schema ответа; без неё structured output не запрашивается. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
  /** Сервис перегружен, ждём и повторяем — чтобы показать это в панели. */
  onRetry?: (info: { attempt: number; waitMs: number; error: string }) => void;
  fetchImpl?: FetchFn;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  finishReason?: string;
  format: StructuredFormat;
  /** Время до первого токена, включая токены рассуждений. */
  ttftMs?: number;
  totalMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
    /** Заголовок Retry-After, если сервер его прислал, в миллисекундах. */
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** Retry-After: секунды или HTTP-дата. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function authHeaders(profile: Pick<LlmProfile, 'apiKey'>): Record<string, string> {
  return profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {};
}

/** Человекочитаемое описание ошибки сети/HTTP с подсказкой, что проверить. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body.trim().slice(0, 300);
    const tail = body ? ` Ответ сервера: ${body}` : '';
    if (/API_KEY_INVALID|API key not valid|api key expired/i.test(err.body)) {
      return `Неверный API-ключ.${tail}`;
    }
    switch (err.status) {
      case 429:
        return `429: слишком много запросов или кончилась квота.${tail}`;
      case 503:
        return `503: сервис перегружен и временно недоступен.${tail}`;
      case 401:
        return `401: неверный или отсутствующий API-ключ.${tail}`;
      case 403:
        return `403: доступ запрещён. Для Ollama проверьте OLLAMA_ORIGINS=chrome-extension://*, для llama-server — API-ключ.${tail}`;
      case 404:
        return `404: путь ${err.url} не найден. Проверьте адрес сервера и имя модели.${tail}`;
      default:
        return `HTTP ${err.status}.${tail}`;
    }
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return err.name === 'TimeoutError' ? 'Таймаут: сервер не ответил вовремя.' : 'Запрос отменён.';
  }
  if (err instanceof TypeError) {
    return `Сервер недоступен (${err.message}). Проверьте адрес, что сервер слушает 0.0.0.0, и файрвол.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Извлекает текст и рассуждения из одного chunk'а chat.completion.chunk. */
export function parseChunkDelta(json: unknown): ChatDelta {
  if (!isRecord(json) || !Array.isArray(json.choices)) return { content: '', reasoning: '' };
  const choice: unknown = json.choices[0];
  const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
  const content = typeof delta.content === 'string' ? delta.content : '';
  // llama.cpp: reasoning_content; Ollama / vLLM: reasoning.
  const reasoning =
    typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
  return { content, reasoning };
}

/**
 * Тело запроса /chat/completions. lean — без необязательных полей (счётчик токенов,
 * переключатель рассуждений): такой запрос переживает сервер, который их не понимает.
 */
export function buildRequestBody(
  profile: LlmProfile,
  messages: ChatMessage[],
  format: StructuredFormat,
  schema?: Record<string, unknown>,
  maxTokens?: number,
  lean = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    temperature: profile.temperature,
    max_tokens: maxTokens ?? profile.maxOutputTokens,
  };
  if (!lean) body.stream_options = { include_usage: true };
  if (format === 'json_schema' && schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'agent_step', strict: true, schema } };
  } else if (format === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (!profile.thinking && !lean) {
    if (providerInfo(profile.provider).id === 'google') {
      // У Gemini рассуждения выключает reasoning_effort: none (у Pro и 3.x — не выключаются вовсе).
      body.reasoning_effort = 'none';
    } else {
      // Разные серверы понимают разные ключи; лишние они игнорируют.
      body.chat_template_kwargs = { enable_thinking: false };
      body.think = false;
    }
  }
  return { ...body, ...parseExtraBody(profile.extraBody) };
}

/** Похоже ли, что сервер отверг именно response_format (а не что-то другое). */
export function isFormatRejection(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    [400, 422, 500, 501].includes(err.status) &&
    /response_format|json_schema|schema|grammar|json/i.test(err.body)
  );
}

/** Временная неполадка на стороне сервиса: перегрузка, лимит, сбой шлюза. Повтор имеет смысл. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'TimeoutError') return false; // таймаут настраивается отдельно
  if (err instanceof TypeError) return true; // сеть моргнула
  if (!(err instanceof HttpError)) return false;
  if (isFormatRejection(err) || isOptionalFieldRejection(err)) return false;
  return [408, 429, 500, 502, 503, 504, 529].includes(err.status);
}

/** Сервер не понял необязательное поле запроса — стоит повторить без них (lean). */
export function isOptionalFieldRejection(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    [400, 422].includes(err.status) &&
    /stream_options|include_usage|chat_template_kwargs|enable_thinking|reasoning_effort|"think"/i.test(err.body)
  );
}

/** Какой формат сработал у сервера+модели — чтобы не наступать на отказ каждый шаг. */
const workingFormat = new Map<string, StructuredFormat>();
/** Серверы, которым нельзя слать необязательные поля. */
const leanServers = new Set<string>();

const cacheKey = (profile: LlmProfile) => `${profile.baseUrl}|${profile.model}`;

export function resetFormatCache(): void {
  workingFormat.clear();
  leanServers.clear();
}

function formatsToTry(profile: LlmProfile, hasSchema: boolean): StructuredFormat[] {
  if (!hasSchema) return ['none'];
  switch (profile.structuredOutput) {
    case 'json_schema':
      return ['json_schema'];
    case 'json_object':
      return ['json_object'];
    case 'off':
      return ['none'];
    case 'auto': {
      const all: StructuredFormat[] = ['json_schema', 'json_object', 'none'];
      const cached = workingFormat.get(cacheKey(profile));
      return cached ? all.slice(all.indexOf(cached)) : all;
    }
  }
}

async function streamOnce(opts: ChatOptions, format: StructuredFormat, signal: AbortSignal, lean: boolean): Promise<ChatResult> {
  const { profile } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  if (!baseUrl) throw new Error('Некорректный адрес сервера.');
  const url = apiUrl(baseUrl, '/chat/completions', providerInfo(profile.provider).apiPrefix);
  const started = performance.now();

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(profile) },
    body: JSON.stringify(buildRequestBody(profile, opts.messages, format, opts.schema, opts.maxTokens, lean)),
    signal,
  });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url, parseRetryAfter(res.headers.get('Retry-After')));
  }
  if (!res.body) throw new Error('Пустое тело ответа.');

  const result: ChatResult = { content: '', reasoning: '', format, totalMs: 0 };
  for await (const ev of readSse(res.body)) {
    if (ev.data === '[DONE]') break;
    let json: unknown;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    if (isRecord(json.error)) {
      throw new Error(typeof json.error.message === 'string' ? json.error.message : 'Ошибка сервера в потоке.');
    }
    if (isRecord(json.usage)) {
      const u = json.usage;
      result.usage = {
        promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
        completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
      };
    }
    const choice: unknown = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (isRecord(choice) && typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
    const delta = parseChunkDelta(json);
    if (!delta.content && !delta.reasoning) continue;
    result.ttftMs ??= Math.round(performance.now() - started);
    result.content += delta.content;
    result.reasoning += delta.reasoning;
    opts.onDelta?.(delta);
  }
  result.totalMs = Math.round(performance.now() - started);
  return result;
}

/** Сколько раз повторять запрос при перегрузке сервиса и сколько ждать перед повтором. */
export const TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_DELAYS_MS = [2000, 6000];

export function transientDelay(attempt: number, retryAfterMs?: number): number {
  const base = TRANSIENT_DELAYS_MS[attempt - 1] ?? TRANSIENT_DELAYS_MS.at(-1)!;
  // Указание сервера важнее, но не ждём дольше минуты внутри одного шага.
  const ms = Math.max(retryAfterMs ?? base, base);
  // Разброс, чтобы несколько вкладок не долбили сервер синхронно; в сумме не дольше минуты.
  return Math.min(Math.round(ms * (0.8 + Math.random() * 0.4)), 60_000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Один запрос с повтором без необязательных полей, если сервер их не понял. */
async function streamWithLeanRetry(opts: ChatOptions, format: StructuredFormat, signal: AbortSignal): Promise<ChatResult> {
  const key = cacheKey(opts.profile);
  const lean = leanServers.has(key);
  try {
    return await streamOnce(opts, format, signal, lean);
  } catch (err) {
    if (lean || !isOptionalFieldRejection(err)) throw err;
    leanServers.add(key);
    return streamOnce(opts, format, signal, true);
  }
}

/**
 * Повтор при перегрузке сервиса (503 «high demand», 429, сбой сети): пауза растёт,
 * Retry-After от сервера уважается. Запрос к модели побочных эффектов не имеет, повторять безопасно.
 */
async function streamWithTransientRetry(opts: ChatOptions, format: StructuredFormat, signal: AbortSignal): Promise<ChatResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await streamWithLeanRetry(opts, format, signal);
    } catch (err) {
      if (attempt >= TRANSIENT_ATTEMPTS || !isTransientError(err) || signal.aborted) throw err;
      const wait = transientDelay(attempt, err instanceof HttpError ? err.retryAfterMs : undefined);
      opts.onRetry?.({ attempt, waitMs: wait, error: describeError(err) });
      await sleep(wait, signal);
    }
  }
}

/**
 * Стриминговый запрос к /chat/completions. В режиме auto пробует json_schema →
 * json_object → без формата, если сервер отвергает response_format, и запоминает рабочий.
 */
export async function chatStream(opts: ChatOptions): Promise<ChatResult> {
  const { profile } = opts;
  const timeout = AbortSignal.timeout(profile.requestTimeoutSec * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const formats = formatsToTry(profile, !!opts.schema);

  for (const [i, format] of formats.entries()) {
    try {
      const result = await streamWithTransientRetry(opts, format, signal);
      if (opts.schema && profile.structuredOutput === 'auto') workingFormat.set(cacheKey(profile), format);
      return result;
    } catch (err) {
      if (i < formats.length - 1 && isFormatRejection(err)) continue;
      throw err;
    }
  }
  throw new Error('unreachable');
}
