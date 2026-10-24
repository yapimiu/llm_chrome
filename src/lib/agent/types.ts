import type { StepUsage } from '../llm/usage';
import type { EscalationState } from './escalation';
import type { ElementFlag } from '../dom/types';
import type { FrameNode } from '../frames';
import type { StructuredFormat } from '../llm/client';
import type { AgentAction } from './actions';
import type { LoopSnapshot } from './loop';
import type { RiskReason } from './risk';
import type { StuckState } from './stuck';

export type RunStatus =
  | 'running'
  | 'paused'
  /** Ждёт «Выполнить/Отклонить» по запланированным действиям. */
  | 'awaiting_approval'
  /** Модель задала вопрос через ask_user. */
  | 'asking_user'
  | 'done'
  | 'failed'
  | 'stopped'
  /** Автономный режим: всё, что осталось, ждёт подтверждения в очереди на утро. */
  | 'deferred';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'stopped', 'deferred']);

/** Как найти элемент по номеру из наблюдения: в каком фрейме и в каком снимке он живёт. */
export interface ObservationHandle {
  frames: { frameId: number; snapshotId: number }[];
  /** Номер элемента → frameId. */
  owner: Record<number, number>;
  /** Дерево фреймов — для пересчёта координат iframe перед кликом. */
  nodes: FrameNode[];
  /** Признаки элементов для оценки риска (номер → флаги). */
  flags?: Record<number, ElementFlag[]>;
  /** Поле формы → текст кнопки, которую нажмёт Enter в нём. */
  formSubmit?: Record<number, string>;
  /** Сводка элементов для режима пролистывания: где на странице, можно ли нажать. */
  elements?: ElementBrief[];
}

/** Элемент страницы без подробностей — для пролистывания курса без модели. */
export interface ElementBrief {
  index: number;
  /** Строка как в наблюдении, без номера: `button "Проверить" disabled`. */
  line: string;
  /** Верх элемента от начала страницы, px. */
  y: number;
  disabled: boolean;
  /** Отмечен пользователем как кнопка «Далее». */
  next: boolean;
  /** Кнопка/ссылка/переключатель — то, что жмут; поля ввода и редакторы — нет. */
  clickable: boolean;
  /** Приклеен к экрану (боковая панель, плавающая кнопка чата) — не содержимое урока. */
  pinned?: boolean;
  /** Внутри iframe (тренажёр, виджет). */
  inFrame?: boolean;
}

export interface ActionResult {
  ok: boolean;
  /** Коротко для истории и ленты: «ok», «page navigated to …», «element [12] is gone». */
  message: string;
  /** Страница ушла на другой URL / перезагрузилась — номера элементов недействительны. */
  navigated?: boolean;
}

export interface ExecutedAction {
  action: AgentAction;
  /** Строка элемента из наблюдения: `button "Войти"` — для ленты и истории. */
  target?: string;
  /** drag: строка элемента, на который перетаскиваем. */
  toTarget?: string;
  result?: ActionResult;
  skipped?: string;
  /** Почему действие сочтено рискованным (см. lib/agent/risk.ts). */
  risk?: RiskReason[];
}

export interface StepLlmInfo {
  attempts: number;
  format: StructuredFormat;
  ttftMs?: number;
  totalMs: number;
  promptTokens?: number;
  completionTokens?: number;
  promptTokensEstimate: number;
  /** Какая модель отвечала на этом шаге (важно при автосмене моделей). */
  model?: string;
  profile?: string;
}

/** Шаг в ленте (лёгкий — без наблюдения и сырых ответов). */
export interface StepRecord {
  n: number;
  startedAt: number;
  durationMs?: number;
  url: string;
  reasoning: string;
  expectedOutcome: string;
  actions: ExecutedAction[];
  llm?: StepLlmInfo;
  usage?: StepUsage;
  /** Предупреждения парсера, детектора зацикливания, бюджета контекста. */
  warnings: string[];
  /** Ответ пользователя, отказ в одобрении и т.п. — попадает в историю для модели. */
  notes: string[];
  error?: string;
}

/** Тяжёлые данные шага — только в журнале, подгружаются по запросу. */
export interface StepDetail {
  runId: string;
  n: number;
  observation: string;
  history: string;
  /** Заметки для сайта, попавшие в промпт этого шага. */
  siteNotes?: string;
  /** Скриншот, который видела модель (data:-адрес JPEG). */
  screenshot?: string;
  responses: { content: string; reasoning: string; parseError?: string }[];
}

export interface PendingApproval {
  actions: ExecutedAction[];
  reasoning: string;
  /** Автономный режим: если до этого момента (ms) никто не ответит, рискованное уйдёт в очередь. */
  deadline?: number;
}

export interface RunState {
  id: string;
  task: string;
  profileLabel: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  maxSteps: number;
  steps: StepRecord[];
  /** Сохранённое через extract — всегда целиком попадает в промпт. */
  extracted: string[];
  pendingApproval?: PendingApproval;
  question?: string;
  result?: string;
  error?: string;
  /** Пауза запрошена, но вступит в силу после текущей операции. */
  pauseRequested?: boolean;
  /** Автономный (ночной) режим этого запуска. */
  autonomous?: boolean;
  // ——— чекпоинт: всё, что нужно, чтобы продолжить после перезапуска ———
  /** Какое действие выполняется прямо сейчас (пишется до выполнения). */
  inFlight?: { step: number; action: number };
  loop?: LoopSnapshot;
  /** Отпечатки отложенных в очередь действий — чтобы не откладывать одно и то же дважды. */
  deferredKeys?: string[];
  /** Шагов подряд, упёршихся в отложенное/запрещённое действие. */
  deferStreak?: number;
  /** Сколько раз запуск продолжали после перезапуска браузера/воркера. */
  restarts?: number;
  /** Детектор застревания (см. stuck.ts). */
  stuck?: StuckState;
  /** Автосмена моделей: на какой ступени цепочки идёт запуск (см. escalation.ts). */
  escalation?: EscalationState;
  /** Сколько раз контекст сбрасывали при заполнении бюджета (см. context.ts). */
  contextResets?: number;
}

/** Действие, отложенное в автономном режиме до подтверждения человеком («очередь на утро»). */
export interface DeferredItem {
  id: string;
  runId: string;
  task: string;
  createdAt: number;
  step: number;
  url: string;
  title: string;
  /** Отложенные действия (рискованное и всё после него в цепочке). */
  actions: ExecutedAction[];
  reasoning: string;
  expectedOutcome: string;
  /** Что агент успел сохранить через extract к этому моменту. */
  extracted: string[];
  status: 'pending' | 'resumed' | 'dismissed';
}

/** Строка журнала запусков. */
export interface RunSummary {
  id: string;
  task: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  steps: number;
  result?: string;
  error?: string;
}
