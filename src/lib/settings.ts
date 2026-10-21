import { storage } from '#imports';
import { DEFAULT_RISK_RULES, type RiskRules, type SiteRiskMode } from './agent/risk';
import type { SiteNote } from './agent/site-notes';
import { PROVIDERS, providerInfo, type ProviderId } from './llm/providers';
import { isLocalHost, normalizeBaseUrl } from './llm/url';
import type { ScreenshotMode } from './agent/runner';

/** Идентификатор профиля: 'fast', 'slow', 'cloud' из коробки и любые свои (создаются в настройках). */
export type ProfileId = string;

/** Как просить у сервера структурированный ответ. */
export type StructuredOutputMode = 'auto' | 'json_schema' | 'json_object' | 'off';

export interface LlmProfile {
  /** Отображаемое имя профиля. */
  label: string;
  /** Свой сервер или облачный провайдер — определяет префикс пути API и детали запроса. */
  provider: ProviderId;
  /** Адрес сервера без префикса API, например http://192.168.1.10:11434 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * Бюджет контекста в токенах, под который собирается промпт.
   * Ollama через /v1 не принимает num_ctx в запросе — реальный контекст
   * задаётся на сервере (OLLAMA_CONTEXT_LENGTH), проверка связи его показывает.
   */
  contextTokens: number;
  maxOutputTokens: number;
  /** Таймаут одного запроса к LLM, секунды. Для ночного режима — минуты. */
  requestTimeoutSec: number;
  structuredOutput: StructuredOutputMode;
  /**
   * Рассуждения thinking-моделей. Выключение отправляет chat_template_kwargs.enable_thinking=false
   * (llama.cpp, vLLM) и think=false (Ollama); gpt-oss рассуждения не отключает.
   */
  thinking: boolean;
  /** JSON-объект, вмешиваемый в тело запроса (top_k, min_p, свои флаги сервера…). */
  extraBody: string;
  /** Модель понимает картинки (Gemini, Qwen-VL, Gemma 3, llava): ей можно слать скриншоты. */
  vision: boolean;
}

export interface AgentSettings {
  maxSteps: number;
  /** Сколько действий модель может вернуть за один шаг. */
  maxActionsPerStep: number;
  stepTimeoutSec: number;
  /** Сколько одинаковых действий подряд без изменения страницы считать зацикливанием. */
  loopThreshold: number;
  /** Столько шагов подряд без пользы на одном месте — и агент сам прокручивает вниз (0 — выкл). */
  autoScrollAfter: number;
  /** Сбрасывать контекст, когда промпт и ответ занимают столько % бюджета профиля (0 — не сбрасывать). */
  contextResetPercent: number;
  /** Читать каждую новую страницу целиком, как человек (медленная прокрутка до конца) — до того, как модель выберет действие. */
  autoRead: boolean;
  /** Потолок времени на чтение одной страницы, минуты. */
  autoReadMaxMin: number;
  /** Жёсткий лимит символов на наблюдение (сериализованную страницу). */
  maxObservationChars: number;
  /** Пошаговый режим: перед выполнением действий агент ждёт «Выполнить» от человека. */
  approveEachStep: boolean;
  /** Автономный режим: рискованные действия откладываются в очередь «на утро». */
  autonomous: boolean;
  useDebugger: boolean;
  showCursor: boolean;
  debugOverlay: boolean;
  /** Ввод по одной букве (события клавиатуры на каждый символ) вместо вставки строки целиком. Только с CDP. */
  typeByKeys: boolean;
  /** Пауза между символами при вводе по буквам, мс. */
  typeDelayMs: number;
  /** «Пролистать курс»: застряв, звать нейросеть, а когда она разберётся — листать дальше самому. */
  skipWithAgent: boolean;
  /** Сколько шагов даётся нейросети на одну заминку при пролистывании. */
  skipAgentSteps: number;
  /** Скриншот с номерами элементов модели со зрением: никогда / когда застрял / каждый шаг. */
  screenshots: ScreenshotMode;
}

export interface SafetySettings {
  /** Словари рискованных кнопок и адресов оплаты. */
  rules: RiskRules;
  /** Звук и системное уведомление, когда в автономном режиме агент упёрся в рискованное действие. */
  sound: boolean;
  /** Автономный режим: сколько ждать подтверждения, прежде чем отложить действие в очередь (0 — сразу). */
  approvalWindowSec: number;
}

/** Уведомления в Telegram: запросы подтверждения с кнопками, вопросы агента, итог задачи. */
export interface NotifySettings {
  telegram: boolean;
  /** Токен бота от @BotFather. */
  botToken: string;
  /** Чат, куда писать и откуда принимать ответы (остальные игнорируются). */
  chatId: string;
  /** Сообщать, чем кончилась задача. */
  onFinish: boolean;
}

export interface LoggingSettings {
  remoteEnabled: boolean;
  remoteUrl: string;
}

/**
 * Автосмена моделей: базовая — активный профиль; если она не справляется, шаги идут на следующей
 * из chain (по порядку), а когда трудность позади — снова на базовой.
 */
export interface EscalationSettings {
  enabled: boolean;
  /** Профили, на которые переходить по порядку, когда текущий не справляется. */
  chain: ProfileId[];
  /** Пускать в цепочку внешние (облачные) профили — текст страниц уйдёт за пределы сети. */
  allowExternal: boolean;
  /** Сколько неудачных шагов подряд — повод перейти на следующую модель. */
  failStreak: number;
  /** Сколько удачных шагов подряд на сильной модели — повод вернуться на базовую. */
  returnAfter: number;
}

export interface Settings {
  activeProfile: ProfileId;
  /** Порядок профилей (вкладки, списки). Профиль, которого нет в списке, не существует. */
  profileIds: ProfileId[];
  profiles: Record<ProfileId, LlmProfile>;
  escalation: EscalationSettings;
  agent: AgentSettings;
  safety: SafetySettings;
  logging: LoggingSettings;
  notify: NotifySettings;
  /** Подсказки для конкретных сайтов («Узнать ответ» = проверить и т.п.). */
  siteNotes: SiteNote[];
}

export const DEFAULT_SETTINGS: Settings & { profiles: Record<'fast' | 'slow' | 'cloud', LlmProfile> } = {
  activeProfile: 'fast',
  profileIds: ['fast', 'slow', 'cloud'],
  escalation: { enabled: false, chain: ['slow', 'cloud'], allowExternal: false, failStreak: 2, returnAfter: 3 },
  profiles: {
    fast: {
      label: 'Быстрый',
      provider: 'openai',
      baseUrl: 'http://192.168.1.10:11434',
      apiKey: '',
      model: 'qwen3:14b',
      temperature: 0.2,
      contextTokens: 16384,
      maxOutputTokens: 2048,
      requestTimeoutSec: 120,
      structuredOutput: 'auto',
      thinking: false,
      extraBody: '',
      vision: false,
    },
    slow: {
      label: 'Ночной',
      provider: 'openai',
      baseUrl: 'http://192.168.1.10:11434',
      apiKey: '',
      model: 'qwen3:32b',
      temperature: 0.2,
      contextTokens: 16384,
      maxOutputTokens: 4096,
      requestTimeoutSec: 1800,
      structuredOutput: 'auto',
      thinking: true,
      extraBody: '',
      vision: false,
    },
    cloud: {
      label: 'Облако',
      provider: 'google',
      baseUrl: PROVIDERS.google.baseUrl,
      apiKey: '',
      model: PROVIDERS.google.model,
      temperature: 0.4,
      contextTokens: 131_072,
      maxOutputTokens: 4096,
      requestTimeoutSec: 180,
      structuredOutput: 'auto',
      thinking: true,
      extraBody: '',
      vision: true,
    },
  },
  agent: {
    maxSteps: 40,
    maxActionsPerStep: 4,
    stepTimeoutSec: 60,
    loopThreshold: 3,
    autoScrollAfter: 2,
    contextResetPercent: 85,
    autoRead: false,
    autoReadMaxMin: 10,
    skipWithAgent: true,
    typeByKeys: false,
    typeDelayMs: 30,
    skipAgentSteps: 25,
    screenshots: 'stuck',
    approveEachStep: false,
    maxObservationChars: 12000,
    autonomous: false,
    useDebugger: true,
    showCursor: true,
    debugOverlay: false,
  },
  safety: {
    rules: DEFAULT_RISK_RULES,
    sound: true,
    approvalWindowSec: 120,
  },
  logging: {
    remoteEnabled: false,
    remoteUrl: '',
  },
  notify: {
    telegram: false,
    botToken: '',
    chatId: '',
    onFinish: true,
  },
  siteNotes: [],
};

const MAX_SITE_NOTES = 50;
const MAX_NOTE_CHARS = 4000;
const MAX_RULE_CHARS = 4000;
const RISK_MODES: readonly SiteRiskMode[] = ['ask', 'allow', 'block'];

const SCREENSHOT_MODES: readonly ScreenshotMode[] = ['off', 'stuck', 'always'];
const STRUCTURED_MODES: readonly StructuredOutputMode[] = ['auto', 'json_schema', 'json_object', 'off'];
const DEFAULT_PROFILE_IDS: readonly ProfileId[] = ['fast', 'slow', 'cloud'];
const MAX_PROFILES = 30;
const MAX_PROFILE_ID = 40;

type Unknown<T> = { [K in keyof T]?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number, integer = false): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

/** 0 — выключено; иначе 30–99 %: ниже половины бюджета сброс срабатывал бы постоянно. */
function resetPercent(v: unknown, fallback: number): number {
  const n = num(v, fallback, 0, 99, true);
  return n === 0 ? 0 : Math.max(30, n);
}

function sanitizeProfile(raw: unknown, def: LlmProfile): LlmProfile {
  const r: Unknown<LlmProfile> = isRecord(raw) ? raw : {};
  const mode = r.structuredOutput;
  return {
    label: str(r.label, def.label),
    provider: typeof r.provider === 'string' && r.provider in PROVIDERS ? (r.provider as ProviderId) : def.provider,
    baseUrl: str(r.baseUrl, def.baseUrl).trim(),
    apiKey: str(r.apiKey, def.apiKey).trim(),
    model: str(r.model, def.model).trim(),
    temperature: num(r.temperature, def.temperature, 0, 2),
    contextTokens: num(r.contextTokens, def.contextTokens, 1024, 1_048_576, true),
    maxOutputTokens: num(r.maxOutputTokens, def.maxOutputTokens, 64, 131_072, true),
    requestTimeoutSec: num(r.requestTimeoutSec, def.requestTimeoutSec, 5, 7200, true),
    structuredOutput: STRUCTURED_MODES.includes(mode as StructuredOutputMode)
      ? (mode as StructuredOutputMode)
      : def.structuredOutput,
    thinking: bool(r.thinking, def.thinking),
    extraBody: str(r.extraBody, def.extraBody).trim(),
    vision: bool(r.vision, def.vision),
  };
}

/**
 * Список профилей: сохранённый порядок (если есть), иначе — стандартные плюс те, что нашлись в profiles.
 * Удалённый профиль не возвращается: список — единственный источник правды.
 */
function sanitizeProfileIds(raw: unknown, rawProfiles: Record<string, unknown>, defaults: Settings): ProfileId[] {
  const valid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_PROFILE_ID;
  const wanted = Array.isArray(raw) ? raw.filter(valid) : [...DEFAULT_PROFILE_IDS, ...Object.keys(rawProfiles).filter(valid)];
  const ids = [...new Set(wanted)].slice(0, MAX_PROFILES);
  return ids.length > 0 ? ids : [...defaults.profileIds];
}

function sanitizeEscalation(raw: unknown, def: EscalationSettings, ids: readonly ProfileId[]): EscalationSettings {
  const r: Unknown<EscalationSettings> = isRecord(raw) ? raw : {};
  const chain = Array.isArray(r.chain) ? r.chain.filter((id): id is string => typeof id === 'string' && ids.includes(id)) : def.chain.filter((id) => ids.includes(id));
  return {
    enabled: bool(r.enabled, def.enabled),
    chain: [...new Set(chain)],
    allowExternal: bool(r.allowExternal, def.allowExternal),
    failStreak: num(r.failStreak, def.failStreak, 1, 10, true),
    returnAfter: num(r.returnAfter, def.returnAfter, 1, 50, true),
  };
}

/** Данные страниц уходят за пределы своей сети: облачный провайдер или адрес не из домашней сети. */
export function isExternalProfile(p: LlmProfile): boolean {
  if (providerInfo(p.provider).cloud) return true;
  const url = normalizeBaseUrl(p.baseUrl);
  return url === null || !isLocalHost(url);
}

/** Разбирает extraBody; пустая строка — пустой объект. Бросает понятную ошибку. */
export function parseExtraBody(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Доп. параметры запроса — не JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(v)) throw new Error('Доп. параметры запроса должны быть JSON-объектом: {"top_k": 20}');
  return v;
}

function sanitizeAgent(raw: unknown, def: AgentSettings): AgentSettings {
  const r: Unknown<AgentSettings> = isRecord(raw) ? raw : {};
  return {
    maxSteps: num(r.maxSteps, def.maxSteps, 1, 1000, true),
    maxActionsPerStep: num(r.maxActionsPerStep, def.maxActionsPerStep, 1, 10, true),
    stepTimeoutSec: num(r.stepTimeoutSec, def.stepTimeoutSec, 5, 3600, true),
    loopThreshold: num(r.loopThreshold, def.loopThreshold, 2, 20, true),
    autoScrollAfter: num(r.autoScrollAfter, def.autoScrollAfter, 0, 20, true),
    contextResetPercent: resetPercent(r.contextResetPercent, def.contextResetPercent),
    autoRead: bool(r.autoRead, def.autoRead),
    autoReadMaxMin: num(r.autoReadMaxMin, def.autoReadMaxMin, 1, 120, true),
    maxObservationChars: num(r.maxObservationChars, def.maxObservationChars, 1000, 500_000, true),
    approveEachStep: bool(r.approveEachStep, def.approveEachStep),
    autonomous: bool(r.autonomous, def.autonomous),
    useDebugger: bool(r.useDebugger, def.useDebugger),
    showCursor: bool(r.showCursor, def.showCursor),
    debugOverlay: bool(r.debugOverlay, def.debugOverlay),
    skipWithAgent: bool(r.skipWithAgent, def.skipWithAgent),
    typeByKeys: bool(r.typeByKeys, def.typeByKeys),
    typeDelayMs: num(r.typeDelayMs, def.typeDelayMs, 0, 1000, true),
    skipAgentSteps: num(r.skipAgentSteps, def.skipAgentSteps, 3, 200, true),
    screenshots: SCREENSHOT_MODES.includes(r.screenshots as ScreenshotMode) ? (r.screenshots as ScreenshotMode) : def.screenshots,
  };
}

function sanitizeSafety(raw: unknown, def: SafetySettings): SafetySettings {
  const r: Unknown<SafetySettings> = isRecord(raw) ? raw : {};
  const rules: Unknown<RiskRules> = isRecord(r.rules) ? r.rules : {};
  const rule = (k: keyof RiskRules) => str(rules[k], def.rules[k]).slice(0, MAX_RULE_CHARS);
  return {
    rules: { payment: rule('payment'), delete: rule('delete'), send: rule('send'), paymentUrls: rule('paymentUrls') },
    sound: bool(r.sound, def.sound),
    approvalWindowSec: num(r.approvalWindowSec, def.approvalWindowSec, 0, 3600, true),
  };
}

/**
 * Приводит произвольные данные (старая версия настроек, ручная правка, мусор)
 * к валидным Settings: недостающие поля берутся из дефолтов, числа зажимаются в диапазоны.
 */
export function sanitizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const r: Unknown<Settings> = isRecord(raw) ? raw : {};
  const rawProfiles = isRecord(r.profiles) ? r.profiles : {};
  const logging: Unknown<LoggingSettings> = isRecord(r.logging) ? r.logging : {};
  const notify: Unknown<NotifySettings> = isRecord(r.notify) ? r.notify : {};
  const profileIds = sanitizeProfileIds(r.profileIds, rawProfiles, defaults);
  const base = defaults.profiles.fast ?? Object.values(defaults.profiles)[0]!;
  const active = profileIds.includes(r.activeProfile as ProfileId) ? (r.activeProfile as ProfileId) : profileIds.includes(defaults.activeProfile) ? defaults.activeProfile : profileIds[0]!;
  return {
    activeProfile: active,
    profileIds,
    profiles: Object.fromEntries(profileIds.map((id) => [id, sanitizeProfile(rawProfiles[id], defaults.profiles[id] ?? base)])),
    escalation: sanitizeEscalation(r.escalation, defaults.escalation, profileIds),
    agent: sanitizeAgent(r.agent, defaults.agent),
    safety: sanitizeSafety(r.safety, defaults.safety),
    logging: {
      remoteEnabled: bool(logging.remoteEnabled, defaults.logging.remoteEnabled),
      remoteUrl: str(logging.remoteUrl, defaults.logging.remoteUrl).trim(),
    },
    notify: {
      telegram: bool(notify.telegram, defaults.notify.telegram),
      botToken: str(notify.botToken, defaults.notify.botToken).trim(),
      chatId: str(notify.chatId, defaults.notify.chatId).trim(),
      onFinish: bool(notify.onFinish, defaults.notify.onFinish),
    },
    siteNotes: Array.isArray(r.siteNotes)
      ? r.siteNotes
          .filter(isRecord)
          .map((n) => ({
            pattern: str(n.pattern, '').trim(),
            notes: str(n.notes, '').slice(0, MAX_NOTE_CHARS),
            hide: str(n.hide, '').slice(0, MAX_NOTE_CHARS),
            risk: RISK_MODES.includes(n.risk as SiteRiskMode) ? (n.risk as SiteRiskMode) : 'ask',
            safe: str(n.safe, '').slice(0, MAX_NOTE_CHARS),
            next: str(n.next, '').slice(0, MAX_NOTE_CHARS),
          }))
          .slice(0, MAX_SITE_NOTES)
      : defaults.siteNotes,
  };
}

/** Профиль по id; неизвестный id (профиль удалён) заменяется активным, чтобы запуск не падал. */
export function profileOf(s: Settings, id: ProfileId): LlmProfile {
  return s.profiles[id] ?? s.profiles[s.activeProfile] ?? Object.values(s.profiles)[0]!;
}

export function activeProfile(s: Settings): LlmProfile {
  return profileOf(s, s.activeProfile);
}

/**
 * Модели для запуска по порядку: активная — базовая, дальше цепочка эскалации. Внешние профили
 * (облако) попадают в неё только с разрешением allowExternal. Без автосмены — только базовая.
 */
export function modelLevels(s: Settings): { id: ProfileId; profile: LlmProfile }[] {
  const base = { id: s.activeProfile, profile: activeProfile(s) };
  if (!s.escalation.enabled) return [base];
  const rest = s.escalation.chain
    .filter((id) => id !== s.activeProfile && s.profiles[id])
    .map((id) => ({ id, profile: s.profiles[id]! }))
    .filter((l) => s.escalation.allowExternal || !isExternalProfile(l.profile));
  return [base, ...rest];
}

// storage.local, а не sync: API-ключ не должен уезжать в облако Google.
const settingsItem = storage.defineItem<unknown>('local:settings', { fallback: null });

export async function loadSettings(): Promise<Settings> {
  return sanitizeSettings(await settingsItem.getValue());
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const clean = sanitizeSettings(s);
  await settingsItem.setValue(clean);
  return clean;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return settingsItem.watch((v) => cb(sanitizeSettings(v)));
}
