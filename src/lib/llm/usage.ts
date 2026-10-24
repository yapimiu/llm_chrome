/** Transport accounting only: no URLs, prompts, response bodies, or error messages. */
export interface HttpAttempt {
  provider: string;
  attemptInChat?: number;
  requestedModel?: string;
  reportedModel?: string;
  format: 'json_schema' | 'json_object' | 'none';
  lean: boolean;
  status?: number;
  outcome: 'success' | 'http-error' | 'network-error' | 'stream-error' | 'aborted';
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

export interface StepUsage {
  attempts: HttpAttempt[];
  parseRetries: number;
  parseErrors?: number;
  chatCalls?: number;
  unmeasuredChatCalls?: number;
}

export function summarizeRunUsage(state: { status?: string; steps: readonly { usage?: StepUsage }[] }) {
  const attempts = state.steps.flatMap((step) => step.usage?.attempts ?? []);
  const sum = (field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens') => ({
    reported: attempts.reduce((n, a) => n + (a[field] ?? 0), 0),
    unknownAttempts: attempts.filter((a) => a[field] === null).length,
  });
  return {
    status: safeRunStatus(state.status),
    httpAttempts: attempts.length,
    chatCalls: state.steps.reduce((n, s) => n + (s.usage?.chatCalls ?? 0), 0),
    unknownChatCallSteps: state.steps.filter((s) => s.usage?.chatCalls === undefined).length,
    outcomes: {
      success: attempts.filter((a) => a.outcome === 'success').length,
      httpError: attempts.filter((a) => a.outcome === 'http-error').length,
      networkError: attempts.filter((a) => a.outcome === 'network-error').length,
      streamError: attempts.filter((a) => a.outcome === 'stream-error').length,
      aborted: attempts.filter((a) => a.outcome === 'aborted').length,
    },
    parseErrors: { reported: state.steps.reduce((n, s) => n + (s.usage?.parseErrors ?? 0), 0), unknownSteps: state.steps.filter((s) => s.usage?.parseErrors === undefined).length },
    transportRetries: attempts.filter((a) => (a.attemptInChat ?? 1) > 1).length,
    unmeasuredChatCalls: state.steps.reduce((n, s) => n + (s.usage?.unmeasuredChatCalls ?? 0), 0),
    unmeasuredSteps: state.steps.filter((s) => !s.usage).length,
    parseRetries: state.steps.reduce((n, s) => n + (s.usage?.parseRetries ?? 0), 0),
    input: sum('inputTokens'), output: sum('outputTokens'), cachedInput: sum('cachedInputTokens'),
    models: [...new Set(attempts.map((a) => a.reportedModel ?? a.requestedModel).filter((m): m is string => m !== undefined))],
    cost: { status: 'unknown' as const, reason: 'missing-rates' as const, amount: null },
  };
}

/** Explicit allowlist, independent of the heavy existing run export. */
export function exportUsage(state: { status?: string; steps: readonly { n: number; usage?: StepUsage }[] }) {
  return {
    summary: summarizeRunUsage(state),
    steps: state.steps.map((s) => ({ n: s.n, parseErrors: s.usage?.parseErrors ?? null, parseRetries: s.usage?.parseRetries ?? null, chatCalls: s.usage?.chatCalls ?? null, unmeasuredChatCalls: s.usage?.unmeasuredChatCalls ?? null, attempts: s.usage?.attempts.map((a) => ({
      provider: a.provider, attemptInChat: a.attemptInChat, requestedModel: a.requestedModel, reportedModel: a.reportedModel,
      format: a.format, lean: a.lean, status: a.status, outcome: a.outcome, elapsedMs: a.elapsedMs,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, cachedInputTokens: a.cachedInputTokens,
    })) ?? null })),
  };
}

/** Model identifiers only; reject URLs, whitespace, controls, and oversized free text. */
export function modelIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 && !value.includes('://') && /^[A-Za-z0-9_.\/:-]+$/.test(value) ? value : undefined;
}


function safeRunStatus(status: string | undefined) {
  return status && ['running', 'paused', 'awaiting_approval', 'asking_user', 'done', 'failed', 'stopped', 'deferred'].includes(status) ? status : null;
}

/** Human-readable accounting only; never interpolates task/page/error text. */
export function formatRunUsage(state: Parameters<typeof summarizeRunUsage>[0]): string {
  const s = summarizeRunUsage(state);
  const tokens = (u: { reported: number; unknownAttempts: number }) => `${u.reported} (неизвестно попыток: ${u.unknownAttempts})`;
  return `Токены сервера: вход ${tokens(s.input)}; выход ${tokens(s.output)}; кеш входа ${tokens(s.cachedInput)}. ` +
    `HTTP: ${s.httpAttempts} (успешно ${s.outcomes.success}, HTTP-ошибок ${s.outcomes.httpError}, сетевых ${s.outcomes.networkError}, потока ${s.outcomes.streamError}, отмен ${s.outcomes.aborted}); вызовов чата ${s.chatCalls}; повторы HTTP ${s.transportRetries}, разбора ${s.parseRetries}; ошибок разбора ${s.parseErrors.reported} (неизвестно шагов: ${s.parseErrors.unknownSteps}). ` +
    `Без измерений: шагов ${s.unmeasuredSteps}, вызовов ${s.unmeasuredChatCalls}; вызовы неизвестны для ${s.unknownChatCallSteps} шагов. Стоимость неизвестна: тарифы не заданы.`;
}
