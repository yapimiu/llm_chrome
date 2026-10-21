import type { ChatDelta, ChatMessage, ChatResult, StructuredFormat } from '../llm/client';
import { agentResponseSchema, type AgentStep } from './actions';
import { parseAgentStep } from './parse';
import { charsForTokens, isContextOverflow } from './context';
import { buildStepMessages, correctionMessage, estimateTokens, type TabInfo } from './prompt';

export interface StepDeps {
  /** maxChars — при ужимании страницы под контекст: наблюдение нужно снять заново покороче. */
  observe(opts?: { maxChars?: number }): Promise<{ observation: string; tabs: TabInfo[]; url?: string; image?: string }>;
  chat(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    onDelta: (d: ChatDelta) => void,
    onRetry: (info: { attempt: number; waitMs: number; error: string }) => void,
  ): Promise<ChatResult>;
}

export interface StepInput {
  task: string;
  systemTemplate: string;
  boundary: string;
  maxActions: number;
  /** Сколько раз переспрашивать модель при неразборчивом ответе. */
  maxRetries: number;
  /** Бюджет контекста профиля — для предупреждения о переполнении. */
  contextTokens: number;
  maxOutputTokens: number;
  history?: string;
  /** Короткая сводка вместо истории при сбросе контекста (см. buildDigest). */
  digest?: string;
  /** Сбрасывать контекст, когда промпт + ответ занимают столько % бюджета (0 — не сбрасывать). */
  resetPercent?: number;
  /** Поправка оценки токенов по реальному расходу сервера. */
  tokenRatio?: number;
  /** Заметки пользователя для сайта по URL текущей страницы. */
  siteNotesFor?: (url: string) => string;
}

export interface StepAttempt {
  content: string;
  reasoning: string;
  format: StructuredFormat;
  finishReason?: string;
  ttftMs?: number;
  totalMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Сырая оценка токенов ровно тех сообщений, что ушли в этой попытке (для поправки по реальному расходу). */
  promptTokensEstimate: number;
  parseError?: string;
}

export type StepEvent =
  | { phase: 'observe' }
  | { phase: 'llm'; attempt: number }
  | { phase: 'delta'; attempt: number; content: string; reasoning: string }
  | { phase: 'parse-error'; attempt: number; error: string }
  /** Сервис перегружен: ждём waitMs и повторяем тот же запрос. */
  | { phase: 'service-retry'; attempt: number; waitMs: number; error: string };

export interface StepOutcome {
  observation: string;
  /** Заметки для сайта, попавшие в промпт. */
  siteNotes: string;
  /** Скриншот, ушедший модели (data:-адрес). */
  image?: string;
  /** Сообщения последней попытки — ровно то, что ушло модели. */
  messages: ChatMessage[];
  promptTokensEstimate: number;
  attempts: StepAttempt[];
  step?: AgentStep;
  warnings: string[];
  /** Что сделано для экономии контекста (сброс истории, ужатая страница). */
  resets: string[];
  /** История, которая реально ушла модели (после сброса — сводка). */
  history?: string;
  error?: string;
}

/** Один шаг: наблюдение → запрос к модели → разбор, с переспрашиванием при ошибке формата. */
export async function runStep(input: StepInput, deps: StepDeps, onEvent: (e: StepEvent) => void = () => {}): Promise<StepOutcome> {
  onEvent({ phase: 'observe' });
  let seen = await deps.observe();
  let { observation, tabs, url, image } = seen;
  const siteNotes = url && input.siteNotesFor ? input.siteNotesFor(url) : '';
  let history = input.history;
  const ratio = input.tokenRatio ?? 1;
  const build = () => buildStepMessages({ ...input, history, observation, tabs, siteNotes, image });
  const used = (m: ChatMessage[]) => Math.ceil(estimateTokens(m) * ratio) + input.maxOutputTokens;
  const schema = agentResponseSchema(input.maxActions);
  let messages = build();

  const outcome: StepOutcome = { observation, siteNotes, image, messages, promptTokensEstimate: estimateTokens(messages), attempts: [], warnings: [], resets: [], history };
  const sync = () => {
    outcome.history = history;
    outcome.messages = messages;
    outcome.observation = observation;
    outcome.image = image;
    outcome.promptTokensEstimate = estimateTokens(messages);
  };

  /**
   * Сброс контекста: когда промпт + ответ не умещаются в limit токенов — сначала история заменяется
   * короткой сводкой, затем страница снимается заново покороче. Возвращает true, если что-то изменилось.
   */
  const reset = async (limit: number): Promise<boolean> => {
    if (used(messages) <= limit) return false;
    const before = used(messages);
    let changed = false;
    // Сводка — только если она короче истории: иначе сброс раздувал бы промпт.
    if (input.digest !== undefined && history !== input.digest && input.digest.length < (history ?? '').length) {
      history = input.digest;
      messages = build();
      outcome.resets.push(`history replaced with a short digest (~${before} → ~${used(messages)} tokens of ${input.contextTokens})`);
      changed = true;
    }
    if (used(messages) > limit) {
      const pageTokens = Math.ceil(estimateTokens([{ role: 'user', content: observation }]) * ratio);
      const maxChars = charsForTokens(limit - (used(messages) - pageTokens), ratio);
      if (maxChars < observation.length) {
        const shorter = await deps.observe({ maxChars });
        if (shorter.observation.length < observation.length) {
          ({ observation, tabs, image } = shorter);
          url = shorter.url ?? url;
          messages = build();
          outcome.resets.push(`page text shortened to ~${maxChars} characters to fit the context (~${used(messages)} tokens of ${input.contextTokens})`);
          changed = true;
        }
      }
    }
    if (changed) sync();
    return changed;
  };

  const percent = input.resetPercent ?? 0;
  if (percent > 0) await reset(Math.floor((input.contextTokens * percent) / 100));
  if (estimateTokens(messages) + input.maxOutputTokens > input.contextTokens) {
    outcome.warnings.push(
      `Промпт ~${estimateTokens(messages)} токенов + ответ ${input.maxOutputTokens} больше бюджета контекста ${input.contextTokens} — уменьшите лимит наблюдения или увеличьте контекст.`,
    );
  }

  let overflowRetried = false;
  for (let attempt = 1; attempt <= input.maxRetries + 1; attempt++) {
    onEvent({ phase: 'llm', attempt });
    const sentEstimate = estimateTokens(messages);
    let res: ChatResult;
    try {
      res = await deps.chat(
        messages,
        schema,
        (d) => onEvent({ phase: 'delta', attempt, ...d }),
        (info) => onEvent({ phase: 'service-retry', ...info }),
      );
    } catch (err) {
      // Сервер отказал: запрос не влезает в контекст. Один раз сбрасываем контекст жёстче и повторяем.
      if (!isContextOverflow(err) || overflowRetried) throw err;
      overflowRetried = true;
      if (!(await reset(Math.floor(input.contextTokens * 0.6)))) throw err;
      outcome.resets.push('the server rejected the request as too large — retrying with a reset context');
      attempt--;
      continue;
    }
    const record: StepAttempt = {
      content: res.content,
      reasoning: res.reasoning,
      format: res.format,
      finishReason: res.finishReason,
      ttftMs: res.ttftMs,
      totalMs: res.totalMs,
      promptTokens: res.usage?.promptTokens,
      completionTokens: res.usage?.completionTokens,
      promptTokensEstimate: sentEstimate,
    };
    outcome.attempts.push(record);

    const parsed = parseAgentStep(res.content, input.maxActions);
    if (parsed.ok) {
      outcome.step = parsed.step;
      outcome.warnings.push(...parsed.warnings);
      return outcome;
    }

    record.parseError = parsed.error;
    onEvent({ phase: 'parse-error', attempt, error: parsed.error });
    messages.push({ role: 'assistant', content: res.content || '(empty)' }, correctionMessage(parsed.error, res.finishReason === 'length'));
  }

  outcome.error = `Модель не дала корректный ответ за ${input.maxRetries + 1} попыток: ${outcome.attempts.at(-1)?.parseError ?? ''}`;
  return outcome;
}
