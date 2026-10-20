import type { ChatDelta, ChatMessage, ChatResult, StructuredFormat } from '../llm/client';
import { agentResponseSchema, type AgentStep } from './actions';
import { parseAgentStep } from './parse';
import { buildStepMessages, correctionMessage, estimateTokens, type TabInfo } from './prompt';

export interface StepDeps {
  observe(): Promise<{ observation: string; tabs: TabInfo[]; url?: string; image?: string }>;
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
  error?: string;
}

/** Один шаг: наблюдение → запрос к модели → разбор, с переспрашиванием при ошибке формата. */
export async function runStep(input: StepInput, deps: StepDeps, onEvent: (e: StepEvent) => void = () => {}): Promise<StepOutcome> {
  onEvent({ phase: 'observe' });
  const { observation, tabs, url, image } = await deps.observe();
  const siteNotes = url && input.siteNotesFor ? input.siteNotesFor(url) : '';
  const messages = buildStepMessages({ ...input, observation, tabs, siteNotes, image });
  const schema = agentResponseSchema(input.maxActions);
  const promptTokensEstimate = estimateTokens(messages);

  const outcome: StepOutcome = { observation, siteNotes, image, messages, promptTokensEstimate, attempts: [], warnings: [] };
  if (promptTokensEstimate + input.maxOutputTokens > input.contextTokens) {
    outcome.warnings.push(
      `Промпт ~${promptTokensEstimate} токенов + ответ ${input.maxOutputTokens} больше бюджета контекста ${input.contextTokens} — уменьшите лимит наблюдения или увеличьте контекст.`,
    );
  }

  for (let attempt = 1; attempt <= input.maxRetries + 1; attempt++) {
    onEvent({ phase: 'llm', attempt });
    const res = await deps.chat(
      messages,
      schema,
      (d) => onEvent({ phase: 'delta', attempt, ...d }),
      (info) => onEvent({ phase: 'service-retry', ...info }),
    );
    const record: StepAttempt = {
      content: res.content,
      reasoning: res.reasoning,
      format: res.format,
      finishReason: res.finishReason,
      ttftMs: res.ttftMs,
      totalMs: res.totalMs,
      promptTokens: res.usage?.promptTokens,
      completionTokens: res.usage?.completionTokens,
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
