import { formatAction, targetIndex, type AgentAction } from './actions';
import { elementName, type RiskReason } from './risk';
import type { ActionResult, ElementBrief, ObservationHandle, RunState } from './types';

/**
 * Запись и повтор: успешный запуск агента сохраняется как сценарий — действия с описаниями
 * элементов вместо номеров. Повтор находит те же элементы по описанию и жмёт их без модели.
 */

export interface MacroStep {
  /** Действие как его выполнили; номера элементов при повторе подбираются заново. */
  action: AgentAction;
  /** Строка элемента при записи: `button "Войти"`. */
  target?: string;
  /** Какой по счёту среди одинаковых элементов (0 — первый). */
  nth?: number;
  toTarget?: string;
  toNth?: number;
  /** Страница, на которой действие сделали. */
  url: string;
  /** Ввод в поле пароля/карты: значение не хранится, при повторе его спросят. */
  secret?: boolean;
}

export interface Macro {
  id: string;
  name: string;
  /** Исходная задача — для передачи нейросети, если повтор собьётся. */
  task: string;
  createdAt: number;
  startUrl: string;
  steps: MacroStep[];
}

/** Что не повторяем: финал, вопросы, заметки и переключение вкладок по номеру (номера вкладок меняются). */
const NOT_RECORDED: ReadonlySet<AgentAction['action']> = new Set(['done', 'ask_user', 'extract', 'switch_tab']);

const STATES = new Set(['disabled', 'checked', 'selected', 'expanded', 'collapsed', 'readonly', '←', 'NEXT']);

/** Описание элемента без изменчивых частей: значение поля, состояния, число строк редактора. */
export function elementKey(line: string): string {
  const noAttrs = line.replace(/\s(value|lines)="(?:[^"\\]|\\.)*"/g, '');
  const words = noAttrs.split(' ');
  while (words.length > 1 && STATES.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

/** Совсем грубый ключ: тег/роль и имя. */
const looseKey = (line: string) => `${line.split(' ')[0]} ${elementName(line).toLowerCase()}`;

/** Строки наблюдения `[N] …` → номер и строка. */
export function observationLines(observation: string): { index: number; line: string }[] {
  const out: { index: number; line: string }[] = [];
  for (const l of observation.split('\n')) {
    const m = /^\[(\d+)\] (.+)$/.exec(l);
    if (m) out.push({ index: Number(m[1]), line: m[2]! });
  }
  return out;
}

/** Какой по счёту среди элементов с тем же описанием элемент index (по возрастанию номеров). */
export function nthOf(items: readonly { index: number; line: string }[], index: number, line: string): number {
  const key = elementKey(line);
  return items.filter((e) => e.index < index && elementKey(e.line) === key).length;
}

/**
 * Сценарий из запуска: только выполненные успешно действия. observations — что видела модель
 * на каждом шаге (номер шага → текст), из него — порядковые номера одинаковых элементов.
 */
export function macroFromRun(run: RunState, observations: ReadonlyMap<number, string>, name: string, id: string, now: number): Macro {
  const steps: MacroStep[] = [];
  for (const s of run.steps) {
    const lines = observationLines(observations.get(s.n) ?? '');
    for (const ex of s.actions) {
      if (ex.skipped || !ex.result?.ok || NOT_RECORDED.has(ex.action.action)) continue;
      const step: MacroStep = { action: structuredClone(ex.action), url: s.url };
      const i = targetIndex(ex.action);
      if (i !== undefined && ex.target) {
        step.target = ex.target;
        step.nth = nthOf(lines, i, ex.target);
      }
      if (ex.action.action === 'drag' && ex.toTarget) {
        step.toTarget = ex.toTarget;
        step.toNth = nthOf(lines, ex.action.to_index, ex.toTarget);
      }
      const secret = ex.action.action === 'type' && (/\[type=password\]/.test(ex.target ?? '') || (ex.risk ?? []).some((r) => r.kind === 'secret' && /ввод/.test(r.why)));
      if (secret && ex.action.action === 'type') {
        step.secret = true;
        step.action = { ...ex.action, text: '' };
      }
      steps.push(step);
    }
  }
  return { id, name: name.trim() || run.task.slice(0, 60), task: run.task, createdAt: now, startUrl: run.steps[0]?.url ?? '', steps };
}

/** Тот же элемент на текущей странице: точная строка → без изменчивых частей → тег и имя; среди одинаковых — nth-й. */
export function findElement(elements: readonly ElementBrief[], target: string, nth = 0): ElementBrief | null {
  const sorted = [...elements].sort((a, b) => a.index - b.index);
  for (const same of [(l: string) => l === target, (l: string) => elementKey(l) === elementKey(target), (l: string) => looseKey(l) === looseKey(target)]) {
    const found = sorted.filter((e) => same(e.line));
    if (found.length) return found[Math.min(nth, found.length - 1)]!;
  }
  return null;
}

/** Действие с номерами элементов текущей страницы. */
export function rebind(action: AgentAction, index: number | undefined, toIndex: number | undefined): AgentAction {
  const a = structuredClone(action);
  if (index !== undefined && 'index' in a) (a as { index: number }).index = index;
  if (toIndex !== undefined && a.action === 'drag') a.to_index = toIndex;
  return a;
}

// ——— повтор ———

export interface ReplayObservation {
  url: string;
  elements: ElementBrief[];
  handle: ObservationHandle;
}

export interface ReplayDeps {
  observe(): Promise<ReplayObservation>;
  execute(action: AgentAction, handle: ObservationHandle): Promise<ActionResult>;
  /** Риск действия по тем же правилам, что у агента. */
  assess(action: AgentAction, target: string | undefined, toTarget: string | undefined, obs: ReplayObservation): RiskReason[];
  /** Спросить человека «выполнить?» — для рискованных шагов. */
  confirm(text: string): Promise<boolean>;
  /** Спросить значение (пароль не хранится в сценарии); null — отказ. */
  ask(question: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  onState(state: ReplayState): void;
}

export interface ReplayConfig {
  /** Сколько раз заново смотреть на страницу, если элемент ещё не появился. */
  findAttempts: number;
  findDelayMs: number;
  /** Пауза после действия: страница успевает отреагировать. */
  settleMs: number;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = { findAttempts: 10, findDelayMs: 500, settleMs: 300 };

export interface ReplayState {
  status: 'running' | 'done' | 'failed' | 'stopped';
  macroId: string;
  name: string;
  /** Номер текущего шага (с 1). */
  step: number;
  total: number;
  /** Последнее, что сделали или почему остановились. */
  message?: string;
  /** Ждём человека: подтвердить или ввести значение. */
  pending?: { kind: 'confirm' | 'input'; text: string };
}

export class Replayer {
  readonly state: ReplayState;
  private stopped = false;

  constructor(
    private readonly macro: Macro,
    private readonly deps: ReplayDeps,
    private readonly cfg: ReplayConfig = DEFAULT_REPLAY_CONFIG,
  ) {
    this.state = { status: 'running', macroId: macro.id, name: macro.name, step: 0, total: macro.steps.length };
  }

  stop(): void {
    this.stopped = true;
  }

  private emit(): void {
    this.deps.onState({ ...this.state, pending: this.state.pending ? { ...this.state.pending } : undefined });
  }

  private finish(status: ReplayState['status'], message: string): ReplayState {
    Object.assign(this.state, { status, message, pending: undefined });
    this.emit();
    return this.state;
  }

  /** Ждёт, пока на странице появятся нужные элементы; null — так и не появились. */
  private async locate(step: MacroStep): Promise<{ obs: ReplayObservation; index?: number; toIndex?: number } | null> {
    for (let attempt = 0; attempt < this.cfg.findAttempts && !this.stopped; attempt++) {
      if (attempt > 0) await this.deps.sleep(this.cfg.findDelayMs);
      const obs = await this.deps.observe();
      const el = step.target ? findElement(obs.elements, step.target, step.nth) : null;
      const to = step.toTarget ? findElement(obs.elements, step.toTarget, step.toNth) : null;
      if ((!step.target || el) && (!step.toTarget || to)) return { obs, index: el?.index, toIndex: to?.index };
    }
    return null;
  }

  async run(): Promise<ReplayState> {
    this.emit();
    try {
      for (const [i, step] of this.macro.steps.entries()) {
        if (this.stopped) return this.finish('stopped', 'Остановлено.');
        this.state.step = i + 1;
        this.state.message = formatAction(step.action) + (step.target ? ` → ${step.target}` : '');
        this.emit();

        const found = await this.locate(step);
        if (this.stopped) return this.finish('stopped', 'Остановлено.');
        if (!found) return this.finish('failed', `Шаг ${i + 1}: на странице нет элемента ${step.target ?? ''}${step.toTarget ? ` / ${step.toTarget}` : ''}. Страница изменилась — можно передать задачу нейросети.`);

        let action = rebind(step.action, found.index, found.toIndex);
        if (step.secret && action.action === 'type') {
          this.state.pending = { kind: 'input', text: `Значение для поля ${step.target ?? ''} (в сценарии не хранится)` };
          this.emit();
          const value = await this.deps.ask(this.state.pending.text);
          this.state.pending = undefined;
          if (value === null || this.stopped) return this.finish('stopped', 'Значение не введено — повтор остановлен.');
          action = { ...action, text: value };
        }

        const risk = this.deps.assess(action, step.target, step.toTarget, found.obs);
        if (risk.length) {
          this.state.pending = { kind: 'confirm', text: `${formatAction(step.secret ? { ...action, text: '•••' } as AgentAction : action)}${step.target ? ` → ${step.target}` : ''}\n${risk.map((r) => r.why).join('; ')}` };
          this.emit();
          const ok = await this.deps.confirm(this.state.pending.text);
          this.state.pending = undefined;
          if (!ok || this.stopped) return this.finish('stopped', `Шаг ${i + 1} отклонён — повтор остановлен.`);
        }

        const res = await this.deps.execute(action, found.obs.handle);
        if (!res.ok) return this.finish('failed', `Шаг ${i + 1} не удался: ${res.message}`);
        await this.deps.sleep(this.cfg.settleMs);
      }
      return this.finish('done', `Готово: выполнено шагов ${this.macro.steps.length}.`);
    } catch (err) {
      return this.finish('failed', err instanceof Error ? err.message : String(err));
    }
  }
}

/** Задача для нейросети, когда повтор сбился: продолжить с того места. */
export function handoffTask(macro: Macro, state: ReplayState): string {
  return `${macro.task}\n\n(Это задача уже выполнялась по записанному сценарию «${macro.name}». Повтор дошёл до шага ${state.step} из ${state.total} и остановился: ${state.message ?? ''} Посмотри на текущую страницу и доведи задачу до конца.)`;
}
