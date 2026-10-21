import { advance, INITIAL_ESCALATION, isEscalationEnabled, judgeStep, type EscalationConfig, type ModelLevel } from './escalation';
import type { ChatDelta, ChatMessage, ChatResult } from '../llm/client';
import { describeError, isTransientError } from '../llm/client';
import { formatAction, targetIndex, type AgentAction } from './actions';
import { updateTokenRatio } from './context';
import { buildDigest, buildHistory } from './history';
import { actionSignature, fingerprint, LoopDetector, pageSignature } from './loop';
import { elementLine, type TabInfo } from './prompt';
import { assessAction, describeRisks, sitePolicyFor, type RiskRules } from './risk';
import { siteNotesFor, type SiteNote } from './site-notes';
import { atBottom, autoScrollNote, stuckAtBottomNote, updateStuck } from './stuck';
import { runStep, type StepEvent, type StepOutcome } from './step';
import {
  TERMINAL_STATUSES,
  type ActionResult,
  type DeferredItem,
  type ExecutedAction,
  type ObservationHandle,
  type RunState,
  type RunStatus,
  type StepDetail,
  type StepRecord,
} from './types';

export interface RunConfig {
  task: string;
  systemTemplate: string;
  boundary: string;
  maxSteps: number;
  maxActions: number;
  loopThreshold: number;
  stepTimeoutSec: number;
  approveEachStep: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  profileLabel: string;
  model: string;
  siteNotes: SiteNote[];
  /** Автономный (ночной) режим: рискованное — в очередь на утро, ask_user — модель решает сама. */
  autonomous: boolean;
  riskRules: RiskRules;
  /** Автономный режим: сколько ждать подтверждения после сигнала, прежде чем отложить (0 — сразу). */
  approvalWindowSec: number;
  /** Столько шагов подряд без пользы на одном месте — и агент сам прокручивает вниз (0 — выкл). */
  autoScrollAfter: number;
  /** Читать каждую новую страницу целиком (медленная прокрутка, как человек) до выбора действия. */
  autoRead?: boolean;
  /** Скриншот с номерами элементов: никогда, когда агент застрял, или на каждом шаге (только для моделей со зрением). */
  screenshots?: ScreenshotMode;
  /** Потолок одного чтения (read, авточтение), секунды: зависший браузер не должен остановить ночной запуск. */
  readTimeoutSec?: number;
  /** Сбрасывать контекст при заполнении бюджета на столько % (0/не задано — не сбрасывать). */
  contextResetPercent?: number;
  /** Автосмена моделей: ступени [базовая, …сильнее] и пороги; не задано — одна модель. */
  escalation?: EscalationConfig;
}

export type ScreenshotMode = 'off' | 'stuck' | 'always';

/** Прошлый шаг ничего не дал — пора показать модели картинку: текста ей не хватило. */
export function needsScreenshot(mode: ScreenshotMode | undefined, prev: StepRecord | undefined): boolean {
  if (mode === 'always') return true;
  if (mode !== 'stuck' || !prev) return false;
  if (prev.error || prev.warnings.some((w) => w.startsWith('LOOP'))) return true;
  if (prev.notes.some((n) => /^(AUTO-SCROLL|STUCK|The user rejected)/.test(n))) return true;
  return prev.actions.some((a) => (a.result && !a.result.ok) || /nothing on the page changed/.test(a.result?.message ?? ''));
}

export interface Observation {
  observation: string;
  /** Скриншот с номерами элементов (data:-адрес), если просили. */
  image?: string;
  tabs: TabInfo[];
  /** Где искать элементы по номерам (фреймы и снимки) — чтобы исполнитель не перепутал номера. */
  handle: ObservationHandle;
  url: string;
}

export interface RunDeps {
  observe(opts?: { screenshot: boolean; maxChars?: number }): Promise<Observation>;
  chat(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    onDelta: (d: ChatDelta) => void,
    onRetry: (info: { attempt: number; waitMs: number; error: string }) => void,
    signal: AbortSignal,
    /** Профиль модели этой ступени (при автосмене); не задан — профиль запуска. */
    profileId?: string,
  ): Promise<ChatResult>;
  /** Действия, меняющие страницу/вкладку (кроме done/ask_user/extract — их ведёт сам цикл). */
  execute(action: AgentAction, handle: ObservationHandle, signal?: AbortSignal): Promise<ActionResult>;
  onState(state: RunState): void;
  onProgress(e: StepEvent): void;
  persistRun(state: RunState): Promise<void>;
  persistStep(state: RunState, step: StepRecord, detail: StepDetail): Promise<void>;
  /** Чекпоинт перед действием: шаг и состояние без тяжёлых данных (без отправки на сервер логов). */
  checkpoint(state: RunState, step: StepRecord): Promise<void>;
  /** Положить действие в очередь на утро. */
  defer(item: DeferredItem): Promise<void>;
  /** Звук + системное уведомление: агент упёрся в рискованное действие в автономном режиме. */
  alert(message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
}

/** После стольких подряд негодных ответов модели запуск останавливается. */
export const MAX_CONSECUTIVE_ERRORS = 3;
const ERROR_BACKOFF_MS = 3000;

/**
 * Перегрузка сервиса (503 «high demand», 429, сбой сети) — не вина модели: ждём дольше
 * и пробуем больше раз, иначе ночная задача умирает от десятиминутного всплеска нагрузки.
 */
export const MAX_SERVICE_ERRORS = 8;

export function serviceBackoffMs(n: number): number {
  return Math.min(5000 * 3 ** (n - 1), 120_000);
}

/** Чем кончился шаг: порядок, негодный ответ модели или временная неполадка сервиса. */
type StepResult = 'ok' | 'model-error' | 'service-error';

/** Безопасные действия, которые не требуют одобрения даже в пошаговом режиме. */
const NO_APPROVAL: ReadonlySet<AgentAction['action']> = new Set(['done', 'ask_user', 'extract', 'wait', 'wait_for', 'scroll', 'hover', 'read']);

/** Столько шагов подряд, упёршихся в отложенное или запрещённое, — и запуск завершается. */
export const MAX_DEFER_STREAK = 3;

type Approval = 'approved' | 'rejected' | 'timeout';

const RESTART_NOTE =
  'The agent was restarted (browser or extension reload) at this point. The last action may or may not have happened — check the current page state before continuing.';
const NIGHT_NOTE =
  'The user is asleep (autonomous night mode) and cannot answer. Decide yourself using the most reasonable assumption, or skip that part. Mention your assumptions in done.result.';

function postponedNote(ex: ExecutedAction): string {
  return `POSTPONED: ${formatAction(ex.action)}${ex.target ? ` (${ex.target})` : ''} needs the user's confirmation and was NOT performed; it is queued for the morning. Do not retry it or look for another way to do it. Continue with the parts of the task that do not depend on it; if nothing is left, use done and say what is waiting for confirmation.`;
}

function blockedNote(ex: ExecutedAction): string {
  return `BLOCKED: the user does not allow such actions on this website (${describeRisks(ex.risk ?? [])}). ${formatAction(ex.action)} was NOT performed. Do not try it again or another way to do it; finish what you can and use done.`;
}

/** Отпечаток действия для очереди: что сделать и на какой странице (без query и hash). */
function deferKey(ex: ExecutedAction, url: string): string {
  let page = url;
  try {
    const u = new URL(url);
    page = `${u.origin}${u.pathname}`;
  } catch {
    // оставляем как есть
  }
  return `${page} ${actionSignature([ex])}`;
}

function titleOf(observation: string): string {
  return /^Title: (.*)$/m.exec(observation)?.[1]?.trim() ?? '';
}

class StoppedError extends Error {
  constructor() {
    super('stopped');
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/**
 * Цикл агента: наблюдение → модель → (одобрение) → выполнение → следующий шаг.
 * Зависимости внедряются, поэтому цикл тестируется без браузера и сервера.
 */
export class AgentRunner {
  readonly state: RunState;
  private readonly abort = new AbortController();
  private readonly loop: LoopDetector;
  private resumeWaiter: (() => void) | null = null;
  private approvalWaiter: ((approved: boolean) => void) | null = null;
  private answerWaiter: ((text: string) => void) | null = null;
  /** Запуск восстановлен из чекпоинта — перед циклом нужно разобраться с прерванным. */
  private readonly restored: boolean;

  /**
   * @param restore состояние из чекпоинта (со всеми шагами), чтобы продолжить прерванный запуск.
   */
  constructor(
    private readonly cfg: RunConfig,
    private readonly deps: RunDeps,
    restore?: RunState,
  ) {
    this.restored = !!restore;
    this.loop = new LoopDetector(cfg.loopThreshold, restore?.loop);
    this.state = restore ?? {
      id: deps.newId(),
      task: cfg.task,
      profileLabel: cfg.profileLabel,
      model: cfg.model,
      status: 'running',
      startedAt: deps.now(),
      maxSteps: cfg.maxSteps,
      steps: [],
      extracted: [],
    };
    this.state.autonomous = cfg.autonomous;
    this.state.maxSteps = cfg.maxSteps;
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private emit(): void {
    this.deps.onState(this.state);
  }

  private async finish(status: RunStatus, fields: Partial<Pick<RunState, 'result' | 'error'>> = {}): Promise<void> {
    if (TERMINAL_STATUSES.has(this.state.status)) return;
    Object.assign(this.state, fields, { status, finishedAt: this.deps.now(), pauseRequested: false });
    delete this.state.pendingApproval;
    delete this.state.question;
    delete this.state.inFlight;
    this.emit();
    await this.deps.persistRun(this.state).catch(() => {});
  }

  // ——— управление извне ———

  pause(): void {
    if (this.state.status === 'running') {
      this.state.pauseRequested = true;
      this.emit();
    }
  }

  resume(): void {
    this.state.pauseRequested = false;
    if (this.state.status === 'paused') {
      this.state.status = 'running';
      this.emit();
    }
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  stop(): void {
    if (TERMINAL_STATUSES.has(this.state.status)) return;
    this.abort.abort();
    this.resumeWaiter?.();
    this.approvalWaiter?.(false);
    this.answerWaiter?.('');
    void this.finish('stopped');
  }

  approve(approved: boolean): void {
    this.approvalWaiter?.(approved);
    this.approvalWaiter = null;
  }

  answer(text: string): void {
    this.answerWaiter?.(text);
    this.answerWaiter = null;
  }

  /** Точка, где вступает в силу пауза или стоп. */
  private async checkpoint(): Promise<void> {
    if (this.state.pauseRequested && !this.stopped) {
      this.state.status = 'paused';
      this.state.pauseRequested = false;
      this.emit();
      await new Promise<void>((resolve) => (this.resumeWaiter = resolve));
    }
    if (this.stopped) throw new StoppedError();
  }

  // ——— основной цикл ———

  async run(): Promise<RunState> {
    if (this.restored) this.recover();
    this.emit();
    await this.deps.persistRun(this.state).catch(() => {});
    let modelErrors = 0;
    let serviceErrors = 0;
    try {
      // Прерванный вопрос ask_user — ждём ответ дальше.
      if (this.state.question !== undefined) {
        const answer = await this.askUser(this.state.question);
        this.state.steps.at(-1)?.notes.push(`User answered: ${answer || '(no answer)'}`);
      }
      while (!TERMINAL_STATUSES.has(this.state.status)) {
        await this.checkpoint();
        if (this.state.steps.length >= this.cfg.maxSteps) {
          await this.finish('failed', { error: `Достигнут лимит шагов (${this.cfg.maxSteps}).` });
          break;
        }
        const result = await this.step();
        this.escalate(result);
        const lastError = () => this.state.steps.at(-1)?.error ?? '';
        if (result === 'ok') {
          modelErrors = 0;
          serviceErrors = 0;
        } else if (result === 'service-error') {
          if (++serviceErrors >= MAX_SERVICE_ERRORS) {
            await this.finish('failed', { error: `Сервис модели недоступен ${MAX_SERVICE_ERRORS} раз подряд: ${lastError()}` });
          } else {
            const wait = serviceBackoffMs(serviceErrors);
            this.deps.onProgress({ phase: 'service-retry', attempt: serviceErrors, waitMs: wait, error: lastError() });
            await this.deps.sleep(wait);
          }
        } else if (++modelErrors >= MAX_CONSECUTIVE_ERRORS) {
          await this.finish('failed', { error: `Модель ${MAX_CONSECUTIVE_ERRORS} раза подряд не дала годного ответа: ${lastError()}` });
        } else {
          await this.deps.sleep(ERROR_BACKOFF_MS);
        }
      }
    } catch (err) {
      if (err instanceof StoppedError || this.stopped) await this.finish('stopped');
      else await this.finish('failed', { error: describeError(err) });
    }
    return this.state;
  }

  /**
   * Разбор чекпоинта после перезапуска: действие, которое выполнялось, могло и не случиться;
   * одобрение по старым номерам элементов недействительно — шаг перепланируется.
   */
  private recover(): void {
    const s = this.state;
    s.restarts = (s.restarts ?? 0) + 1;
    for (const step of s.steps) {
      for (const [i, ex] of step.actions.entries()) {
        if (ex.result || ex.skipped) continue;
        if (s.inFlight?.step === step.n && s.inFlight.action === i) {
          ex.result = { ok: false, message: 'interrupted by a restart — it may or may not have happened' };
        } else {
          ex.skipped = 'not executed: the agent was restarted';
        }
      }
    }
    s.steps.at(-1)?.notes.push(RESTART_NOTE);
    delete s.inFlight;
    delete s.pendingApproval;
    if (s.status === 'paused') s.pauseRequested = true;
    if (this.cfg.autonomous && s.question !== undefined) {
      s.steps.at(-1)?.notes.push(NIGHT_NOTE);
      delete s.question;
    }
    s.status = 'running';
  }

  /** Текущая ступень цепочки моделей; без автосмены — undefined (работает модель запуска). */
  private currentLevel(): ModelLevel | undefined {
    const cfg = this.cfg.escalation;
    if (!cfg || cfg.levels.length === 0) return undefined;
    return cfg.levels[Math.min(this.state.escalation?.level ?? 0, cfg.levels.length - 1)];
  }

  /** Заметка о смене модели: попадает в следующий шаг (его запись сохраняется вместе с ней). */
  private switchNote: string | null = null;

  /** После каждого шага: удача или неудача двигают запуск по цепочке моделей (см. escalation.ts). */
  private escalate(result: StepResult): void {
    const cfg = this.cfg.escalation;
    const record = this.state.steps.at(-1);
    if (!isEscalationEnabled(cfg) || !record) return;
    const { state, change } = advance(this.state.escalation ?? INITIAL_ESCALATION, cfg, judgeStep(record, result));
    this.state.escalation = state;
    if (!change) return;
    const to = cfg.levels[change.to]!;
    const from = cfg.levels[change.from]!;
    this.state.profileLabel = to.label;
    this.state.model = to.model;
    this.loop.reset();
    const direction = change.to > change.from ? 'harder' : 'back';
    this.switchNote = `MODEL SWITCH: ${from.label} → ${to.label} (${change.reason}). ${direction === 'harder' ? 'A previous model was struggling here — look at the page and the history with fresh eyes.' : 'Continue the task.'}`;
    if (to.external && !from.external) this.deps.alert(`Переход на внешнюю модель «${to.label}»: текст страниц уходит за пределы вашей сети (${change.reason}).`);
    this.emit();
  }

  /**
   * Чтение с потолком времени. Таймаут сам по себе прокрутку не остановит, поэтому у чтения свой
   * сигнал отмены: его взводят «Стоп», истёкший потолок и конец чтения.
   */
  private async readBounded(action: AgentAction, handle: ObservationHandle): Promise<ActionResult> {
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    this.abort.signal.addEventListener('abort', onStop);
    try {
      return await withTimeout(this.deps.execute(action, handle, ctl.signal), (this.cfg.readTimeoutSec ?? 3600) * 1000, 'read');
    } finally {
      ctl.abort();
      this.abort.signal.removeEventListener('abort', onStop);
    }
  }

  /** Поправка оценки токенов по реальному расходу сервера (см. updateTokenRatio). */
  private tokenRatio = 1;

  /** Адреса, которые уже прочитаны в этом запуске (без #якоря): каждую страницу читаем один раз. */
  private readonly readPages = new Set<string>();

  /** Читает страницу целиком, если включено и этот адрес ещё не читали; true — страница прокручена. */
  private async autoRead(obs: Observation, record: StepRecord): Promise<boolean> {
    if (!this.cfg.autoRead) return false;
    const key = obs.url.split('#')[0] ?? obs.url;
    if (!obs.url || this.readPages.has(key)) return false;
    this.readPages.add(key);
    const result = await this.readBounded({ action: 'read' }, obs.handle).catch((err: unknown) => {
      if (this.stopped) throw new StoppedError();
      return { ok: false, message: describeError(err) };
    });
    record.notes.push(result.ok ? `AUTO-READ: the page was read from here to the end like a human (${result.message}). You are now at the bottom.` : `AUTO-READ skipped: ${result.message}`);
    return result.ok;
  }

  /** Один шаг цикла. */
  private async step(): Promise<StepResult> {
    const level = this.currentLevel();
    const n = this.state.steps.length + 1;
    const record: StepRecord = { n, startedAt: this.deps.now(), url: '', reasoning: '', expectedOutcome: '', actions: [], warnings: [], notes: [] };
    const history = buildHistory(this.state.steps, this.state.extracted);
    let obs: Observation | null = null;
    let outcome: StepOutcome;

    try {
      outcome = await runStep(
        {
          task: this.cfg.task,
          systemTemplate: this.cfg.systemTemplate,
          boundary: this.cfg.boundary,
          maxActions: this.cfg.maxActions,
          maxRetries: 2,
          contextTokens: level?.contextTokens ?? this.cfg.contextTokens,
          maxOutputTokens: level?.maxOutputTokens ?? this.cfg.maxOutputTokens,
          history,
          digest: buildDigest(this.state.steps, this.state.extracted),
          resetPercent: this.cfg.contextResetPercent,
          tokenRatio: this.tokenRatio,
          siteNotesFor: (url) => siteNotesFor(url, this.cfg.siteNotes),
        },
        {
          observe: async (o) => {
            // Картинки — только если модель текущей ступени их понимает.
            const shot = (level?.vision ?? true) && needsScreenshot(this.cfg.screenshots, this.state.steps.at(-1));
            obs = await this.deps.observe({ screenshot: shot, maxChars: o?.maxChars });
            // Новая страница: сначала «читаем» её, потом смотрим на неё заново — модель увидит, где мы оказались.
            if (await this.autoRead(obs, record)) obs = await this.deps.observe({ screenshot: shot, maxChars: o?.maxChars });
            return { observation: obs.observation, tabs: obs.tabs, url: obs.url, image: obs.image };
          },
          chat: (messages, schema, onDelta, onRetry) => this.deps.chat(messages, schema, onDelta, onRetry, this.abort.signal, level?.id),
        },
        (e) => this.deps.onProgress(e),
      );
    } catch (err) {
      if (this.stopped) throw new StoppedError();
      record.error = describeError(err);
      record.url = (obs as Observation | null)?.url ?? '';
      await this.saveStep(record, obs, history, null);
      return isTransientError(err) ? 'service-error' : 'model-error';
    }

    const seen = obs as unknown as Observation;
    record.url = seen.url;
    if (this.switchNote) record.notes.push(this.switchNote);
    this.switchNote = null;
    record.warnings.push(...outcome.warnings);
    for (const r of outcome.resets) record.notes.push(`CONTEXT RESET: ${r}`);
    if (outcome.resets.length) this.state.contextResets = (this.state.contextResets ?? 0) + outcome.resets.length;
    const last = outcome.attempts.at(-1);
    this.tokenRatio = updateTokenRatio(this.tokenRatio, last?.promptTokens, last?.promptTokensEstimate);
    if (last) {
      record.llm = {
        attempts: outcome.attempts.length,
        format: last.format,
        ttftMs: last.ttftMs,
        totalMs: outcome.attempts.reduce((s, a) => s + a.totalMs, 0),
        promptTokens: last.promptTokens,
        completionTokens: last.completionTokens,
        promptTokensEstimate: outcome.promptTokensEstimate,
        ...(level ? { model: level.model, profile: level.label } : {}),
      };
    }
    if (!outcome.step) {
      record.error = outcome.error;
      await this.saveStep(record, seen, history, outcome);
      return 'model-error';
    }

    record.reasoning = outcome.step.reasoning;
    record.expectedOutcome = outcome.step.expected_outcome;
    record.actions = outcome.step.actions.map((action) => {
      const i = targetIndex(action);
      const ex: ExecutedAction = { action, target: i !== undefined ? elementLine(seen.observation, i) : undefined };
      if (action.action === 'drag') ex.toTarget = elementLine(seen.observation, action.to_index);
      if (action.action === 'read' && action.to_index !== undefined) ex.toTarget = elementLine(seen.observation, action.to_index);
      return ex;
    });

    const verdict = this.loop.record(actionSignature(record.actions), fingerprint(pageSignature(seen.observation)));
    if (verdict === 'warn') {
      record.warnings.push(
        `LOOP: these exact actions were already chosen ${this.loop.repeats} times on the same page and did not get you closer to the goal. Do something different (another element, scroll, navigate) or ask_user.`,
      );
    }
    this.state.steps.push(record);
    this.emit();

    if (verdict === 'stop') {
      for (const a of record.actions) a.skipped = 'loop detected';
      await this.saveStep(record, seen, history, outcome);
      await this.finish('failed', { error: `Зацикливание: одно и то же действие ${this.loop.repeats} раз подряд без изменения страницы.` });
      return 'ok';
    }

    // ——— риск: решает расширение по элементам и адресу; флаг модели только добавляет ———
    const policy = sitePolicyFor(seen.url, this.cfg.siteNotes);
    const flags = seen.handle.flags ?? {};
    for (const ex of record.actions) {
      const i = targetIndex(ex.action);
      const risk = assessAction({
        action: ex.action,
        target: ex.target,
        toTarget: ex.toTarget,
        flags: i !== undefined ? (flags[i] ?? []) : [],
        formSubmit: i !== undefined ? seen.handle.formSubmit?.[i] : undefined,
        url: seen.url,
        modelFlag: outcome.step.risky === true,
        rules: this.cfg.riskRules,
        policy,
      });
      if (risk.length) ex.risk = risk;
    }
    const risky = record.actions.findIndex((a) => a.risk);
    this.emit();

    if (risky === -1) {
      this.state.deferStreak = 0;
      // Пошаговый (отладочный) режим; ночью некому нажимать «Выполнить» — там он не действует.
      if (this.cfg.approveEachStep && !this.cfg.autonomous && record.actions.some((a) => !NO_APPROVAL.has(a.action.action))) {
        if ((await this.requestApproval(record)) !== 'approved') return this.rejected(record, seen, history, outcome);
      }
      await this.executeAll(record, seen.handle);
    } else if (policy.mode === 'block') {
      await this.holdBack(record, seen, risky, 'blocked');
    } else if (!this.cfg.autonomous) {
      const answer = await this.requestApproval(record);
      if (answer !== 'approved') return this.rejected(record, seen, history, outcome);
      this.state.deferStreak = 0;
      await this.executeAll(record, seen.handle);
    } else if (this.state.deferredKeys?.includes(deferKey(record.actions[risky]!, seen.url))) {
      await this.holdBack(record, seen, risky, 'duplicate');
    } else {
      const ex = record.actions[risky]!;
      this.deps.alert(`${formatAction(ex.action)}${ex.target ? ` → ${ex.target}` : ''}\n${describeRisks(ex.risk ?? [])}`);
      const window = this.cfg.approvalWindowSec * 1000;
      const answer = window > 0 ? await this.requestApproval(record, window) : 'timeout';
      if (answer === 'approved') {
        this.state.deferStreak = 0;
        await this.executeAll(record, seen.handle);
      } else if (answer === 'rejected') {
        return this.rejected(record, seen, history, outcome);
      } else {
        await this.holdBack(record, seen, risky, 'deferred');
      }
    }

    await this.unstick(record, seen);
    await this.saveStep(record, seen, history, outcome);
    if ((this.state.deferStreak ?? 0) >= MAX_DEFER_STREAK && !TERMINAL_STATUSES.has(this.state.status)) {
      await this.finish('deferred', {
        result: `Агент ${MAX_DEFER_STREAK} шага подряд упирался в действия, которые нельзя выполнить без вас. Ждут подтверждения в очереди: ${this.state.deferredKeys?.length ?? 0}.`,
      });
    }
    return 'ok';
  }

  /** Модель топчется на месте — прокручиваем вниз за неё (или, если ниже некуда, говорим прямо). */
  private async unstick(record: StepRecord, seen: Observation): Promise<void> {
    const after = this.cfg.autoScrollAfter;
    if (after <= 0 || TERMINAL_STATUSES.has(this.state.status) || record.actions.some((a) => a.action.action === 'ask_user')) return;
    const page = fingerprint(pageSignature(seen.observation));
    const { state, unproductive } = updateStuck(this.state.stuck, page, record.actions);
    this.state.stuck = state;
    if (!unproductive || state.streak < after) return;
    state.streak = 0;
    if (atBottom(seen.observation)) {
      record.notes.push(stuckAtBottomNote(after));
      return;
    }
    await this.checkpoint();
    let ok = false;
    try {
      ok = (await withTimeout(this.deps.execute({ action: 'scroll', direction: 'down', amount: 1 }, seen.handle), this.cfg.stepTimeoutSec * 1000, 'scroll')).ok;
    } catch (err) {
      if (this.stopped) throw new StoppedError();
    }
    record.notes.push(ok ? autoScrollNote(after) : stuckAtBottomNote(after));
    this.emit();
  }

  private async rejected(record: StepRecord, seen: Observation, history: string, outcome: StepOutcome): Promise<StepResult> {
    for (const a of record.actions) a.skipped = 'rejected by the user';
    record.notes.push('The user rejected these actions. Choose a different approach or use ask_user.');
    await this.saveStep(record, seen, history, outcome);
    return 'ok';
  }

  /**
   * Рискованное действие не выполняется: безопасная часть цепочки до него выполняется,
   * само оно и всё после — нет. deferred — ещё и кладётся в очередь на утро.
   */
  private async holdBack(record: StepRecord, seen: Observation, risky: number, why: 'deferred' | 'duplicate' | 'blocked'): Promise<void> {
    await this.executeAll(record, seen.handle, risky);
    const prefixOk = record.actions.slice(0, risky).every((a) => a.result?.ok && !a.result.navigated);
    if (!prefixOk) return; // цепочка оборвалась раньше — до рискованного действия дело не дошло

    const ex = record.actions[risky]!;
    const rest = record.actions.slice(risky + 1);
    this.state.deferStreak = (this.state.deferStreak ?? 0) + 1;
    if (why === 'blocked') {
      ex.result = { ok: false, message: 'blocked by the user\'s settings for this website' };
      for (const a of rest) a.skipped = 'previous action was blocked';
      record.notes.push(blockedNote(ex));
      return;
    }
    if (why === 'duplicate') {
      ex.skipped = 'already postponed for the user\'s confirmation';
      for (const a of rest) a.skipped = 'previous action is waiting for confirmation';
      record.notes.push(`${postponedNote(ex)} It was already queued earlier — do not choose it again.`);
      return;
    }
    ex.skipped = 'postponed until the user confirms (morning queue)';
    for (const a of rest) a.skipped = 'postponed together with the previous action';
    record.notes.push(postponedNote(ex));
    (this.state.deferredKeys ??= []).push(deferKey(ex, seen.url));
    await this.deps
      .defer({
        id: this.deps.newId(),
        runId: this.state.id,
        task: this.state.task,
        createdAt: this.deps.now(),
        step: record.n,
        url: seen.url,
        title: titleOf(seen.observation),
        actions: structuredClone(record.actions.slice(risky)),
        reasoning: record.reasoning,
        expectedOutcome: record.expectedOutcome,
        extracted: [...this.state.extracted],
        status: 'pending',
      })
      .catch(() => {});
  }

  /** Ждёт «Выполнить / Отклонить»; с timeoutMs — не дольше (автономный режим). */
  private async requestApproval(record: StepRecord, timeoutMs?: number): Promise<Approval> {
    this.state.status = 'awaiting_approval';
    this.state.pendingApproval = { actions: record.actions, reasoning: record.reasoning };
    if (timeoutMs !== undefined) this.state.pendingApproval.deadline = this.deps.now() + timeoutMs;
    this.emit();
    // Ждать можно часами — шаг должен быть в журнале, чтобы после перезапуска модель о нём знала.
    this.state.loop = this.loop.snapshot();
    await this.deps.checkpoint(this.state, record).catch(() => {});
    const decision = new Promise<Approval>((resolve) => (this.approvalWaiter = (ok) => resolve(ok ? 'approved' : 'rejected')));
    const answer = await (timeoutMs === undefined ? decision : Promise.race([decision, this.deps.sleep(timeoutMs).then((): Approval => 'timeout')]));
    this.approvalWaiter = null;
    if (this.stopped) throw new StoppedError();
    delete this.state.pendingApproval;
    this.state.status = 'running';
    this.emit();
    return answer;
  }

  private async askUser(question: string, record?: StepRecord): Promise<string> {
    this.state.status = 'asking_user';
    this.state.question = question;
    this.emit();
    if (record) await this.deps.checkpoint(this.state, record).catch(() => {});
    else await this.deps.persistRun(this.state).catch(() => {});
    const answer = await new Promise<string>((resolve) => (this.answerWaiter = resolve));
    if (this.stopped) throw new StoppedError();
    delete this.state.question;
    this.state.status = 'running';
    this.emit();
    return answer;
  }

  /** Выполняет действия шага по порядку; limit — только первые limit (остальное решает вызывающий). */
  private async executeAll(record: StepRecord, handle: ObservationHandle, limit = record.actions.length): Promise<void> {
    const skipRest = (from: number, why: string) => {
      for (const a of record.actions.slice(from)) a.skipped = why;
    };

    for (const [i, ex] of record.actions.slice(0, limit).entries()) {
      await this.checkpoint();
      const a = ex.action;

      if (a.action === 'done') {
        ex.result = { ok: true, message: 'task finished' };
        const queued = this.state.deferredKeys?.length ?? 0;
        await this.finish('done', { result: queued ? `${a.result}\n\n⏸ Ждут вашего подтверждения в очереди: ${queued}.` : a.result });
        return;
      }
      if (a.action === 'ask_user') {
        if (this.cfg.autonomous) {
          ex.result = { ok: true, message: 'the user is not available (autonomous mode)' };
          record.notes.push(NIGHT_NOTE);
          return;
        }
        ex.result = { ok: true, message: 'question shown to the user' };
        const answer = await this.askUser(a.question, record);
        record.notes.push(`User answered: ${answer || '(no answer)'}`);
        return;
      }
      if (a.action === 'extract') {
        this.state.extracted.push(a.note);
        ex.result = { ok: true, message: 'saved' };
        this.emit();
        continue;
      }

      // Чекпоинт до действия: после перезапуска будет видно, что оно могло случиться.
      this.state.inFlight = { step: record.n, action: i };
      this.state.loop = this.loop.snapshot();
      await this.deps.checkpoint(this.state, record).catch(() => {});
      try {
        // Чтение длится минутами по замыслу — у него свой потолок вместо шагового таймаута.
        ex.result = a.action === 'read' ? await this.readBounded(a, handle) : await withTimeout(this.deps.execute(a, handle, this.abort.signal), this.cfg.stepTimeoutSec * 1000, a.action);
      } catch (err) {
        if (this.stopped) throw new StoppedError();
        ex.result = { ok: false, message: describeError(err) };
      } finally {
        delete this.state.inFlight;
      }
      this.emit();

      if (!ex.result.ok) {
        skipRest(i + 1, 'previous action failed');
        return;
      }
      if (ex.result.navigated && i < record.actions.length - 1) {
        skipRest(i + 1, 'page changed — element numbers are no longer valid');
        return;
      }
    }
  }

  private async saveStep(record: StepRecord, obs: Observation | null, history: string, outcome: StepOutcome | null): Promise<void> {
    record.durationMs = this.deps.now() - record.startedAt;
    this.state.loop = this.loop.snapshot();
    if (!this.state.steps.includes(record)) this.state.steps.push(record);
    this.emit();
    const detail: StepDetail = {
      runId: this.state.id,
      n: record.n,
      observation: obs?.observation ?? '',
      // После сброса контекста модель получила сводку, а не полную историю — в журнал пишем то, что ушло.
      history: outcome?.history ?? history,
      siteNotes: outcome?.siteNotes || undefined,
      screenshot: outcome?.image,
      responses: outcome?.attempts.map((a) => ({ content: a.content, reasoning: a.reasoning, parseError: a.parseError })) ?? [],
    };
    await this.deps.persistStep(this.state, record, detail).catch(() => {});
    await this.deps.persistRun(this.state).catch(() => {});
  }
}
