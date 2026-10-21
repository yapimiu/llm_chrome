import { HttpError } from '../llm/client';

/**
 * Ответ сервера «запрос не влезает в контекст»: llama.cpp («exceeds the available context size»),
 * vLLM («maximum context length»), OpenAI («context_length_exceeded»), Gemini и прокси — разными словами.
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof HttpError) || ![400, 413, 422, 500].includes(err.status)) return false;
  return /context[_ ]?(length|size|window)|exceeds?\s+(the\s+)?(available\s+)?context|maximum context|too many tokens|prompt is too long|input is too long|n_ctx|request too large/i.test(err.body);
}

/** Минимум символов страницы, который оставляем при ужимании: меньше — модель ничего не увидит. */
export const MIN_OBSERVATION_CHARS = 1500;

/** Сколько символов наблюдения влезает в tokens токенов (оценка ~3 символа на токен, поправленная реальным расходом). */
export function charsForTokens(tokens: number, tokenRatio: number): number {
  return Math.max(MIN_OBSERVATION_CHARS, Math.floor((tokens * 3) / Math.max(0.1, tokenRatio)));
}

/**
 * Поправка оценки токенов по реальному расходу сервера: токенайзер на кириллице и разметке считает
 * иначе, чем «3 символа на токен». Плавно подстраивается, значение зажато в разумные пределы.
 */
export function updateTokenRatio(current: number, actualPromptTokens: number | undefined, estimate: number | undefined): number {
  if (!actualPromptTokens || !estimate || estimate <= 0) return current;
  // estimate — сырая оценка (без поправки) ровно тех сообщений, что ушли серверу.
  const next = 0.5 * current + 0.5 * (actualPromptTokens / estimate);
  return Math.min(3, Math.max(0.4, next));
}
