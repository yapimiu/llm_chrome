import { browser, defineBackground } from '#imports';
import systemTemplate from '@/prompts/system.md?raw';
import { newBoundary, type TabInfo } from '@/lib/agent/prompt';
import { resumeTask, sameUrl, type RunCheckpoint } from '@/lib/agent/queue';
import { assessAction, sitePolicyFor } from '@/lib/agent/risk';
import { Skipper, type SkipState } from '@/lib/agent/skipper';
import { Course, type CourseState, type SolveResult } from '@/lib/agent/course';
import { remapLevel, type EscalationConfig } from '@/lib/agent/escalation';
import { handoffTask, macroFromRun, Replayer, type Macro, type ReplayState } from '@/lib/agent/macro';
import { deleteMacro, getMacro, listMacros, saveMacro } from '@/lib/agent/macro-store';
import { hiddenNamesFor, nextRulesFor, type SiteNote } from '@/lib/agent/site-notes';
import { AgentRunner, type Observation, type RunConfig } from '@/lib/agent/runner';
import type { StepEvent } from '@/lib/agent/step';
import { TERMINAL_STATUSES, type RunState } from '@/lib/agent/types';
import { ALERT_NOTIFICATION_ID, alertHuman } from '@/lib/alert';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '@/lib/checkpoint';
import { startKeepAlive } from '@/lib/keepalive';
import { chatStream, describeError } from '@/lib/llm/client';
import {
  addDeferred,
  exportRun,
  getDeferred,
  getStepDetail,
  listDeferred,
  listRuns,
  loadRun,
  pruneDeferred,
  pruneRuns,
  saveRun,
  saveStep,
  setDeferredStatus,
} from '@/lib/log/db';
import { postLog } from '@/lib/log/remote';
import { isBackgroundRequest, type BackgroundRequest, type Result, type RunInfo, type UiEvent } from '@/lib/messages';
import { DebuggerSessions } from '@/lib/exec/debugger';
import { activeTab, isRestrictedUrl, observePage, setHighlight } from '@/lib/perception';
import { captureTab } from '@/lib/screenshot';
import { discoverChatId, isConfigured, TelegramBridge, TelegramClient } from '@/lib/notify/telegram';
import { approvalText, finishText, questionText } from '@/lib/notify/format';
import { activeProfile, isExternalProfile, loadSettings, modelLevels, profileOf, type ProfileId, type Settings } from '@/lib/settings';
import { targetIndex } from '@/lib/agent/actions';
import { executeAction, normalizeNavigateUrl, waitForTabLoad, type AgentTab, type ExecContext } from '@/lib/tab-actions';

let current: { runner: AgentRunner; tab: AgentTab; finished: Promise<RunState> } | null = null;
/** Запуск, прерванный перезапуском браузера/воркера, ждёт «Продолжить» в панели. */
let interrupted: { checkpoint: RunCheckpoint; state: RunState } | null = null;

function broadcast(msg: UiEvent): void {
  // Если панель закрыта, получателя нет — это не ошибка.
  browser.runtime.sendMessage(msg).catch(() => {});
}

function runInfo(): RunInfo | null {
  if (current) return { state: current.runner.state, interrupted: false };
  if (interrupted) return { state: interrupted.state, interrupted: true };
  return null;
}

const broadcastRun = () => {
  const info = runInfo();
  if (info) broadcast({ type: 'ui:run-state', info });
};

/** Токены приходят десятками в секунду — склеиваем дельты и шлём в UI не чаще 10 раз в секунду. */
function throttledProgress(): (e: StepEvent) => void {
  let pending: Extract<StepEvent, { phase: 'delta' }> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) broadcast({ type: 'ui:step-progress', event: pending });
    pending = null;
  };
  return (e) => {
    if (e.phase !== 'delta') {
      flush();
      broadcast({ type: 'ui:step-progress', event: e });
      return;
    }
    if (pending && pending.attempt === e.attempt) {
      pending = { ...pending, content: pending.content + e.content, reasoning: pending.reasoning + e.reasoning };
    } else {
      flush();
      pending = e;
    }
    timer ??= setTimeout(flush, 100);
  };
}

async function observeAgentTab(tab: AgentTab, maxChars: number, highlight: boolean, siteNotes: SiteNote[], screenshot = false): Promise<Observation> {
  const t = await browser.tabs.get(tab.tabId).catch(() => null);
  if (!t) throw new Error('Вкладка, в которой работал агент, закрыта.');
  const tabs: TabInfo[] = (await browser.tabs.query({ windowId: tab.windowId }))
    .filter((x) => x.id !== undefined)
    .map((x) => ({ id: x.id!, title: x.title ?? '', url: x.url ?? '', active: x.id === tab.tabId }));
  const url = t.url ?? '';
  if (!url || isRestrictedUrl(url)) {
    // Новая вкладка, chrome:// — читать нельзя, но модель должна понять, что надо перейти на сайт.
    return {
      observation: `URL: ${url || 'about:blank'}\nTitle: ${t.title ?? ''}\n\nThis page cannot be read or controlled by the extension. Use navigate to open a website.`,
      tabs,
      handle: { frames: [], owner: {}, nodes: [] },
      url,
    };
  }
  // Для скриншота рамки с номерами нужны на экране — модель сопоставит картинку с номерами из текста.
  const obs = await observePage(tab.tabId, url, { maxChars, highlight: highlight || screenshot, hide: hiddenNamesFor(url, siteNotes), next: nextRulesFor(url, siteNotes) });
  let image: string | undefined;
  if (screenshot) {
    image = (await captureTab(tab.tabId)) ?? undefined;
    if (!highlight) await setHighlight(tab.tabId, url, false).catch(() => {});
  }
  return { observation: obs.text, image, tabs, handle: obs.handle, url };
}

// ——— Telegram ———

function telegramClient(settings: Settings): TelegramClient | null {
  const n = settings.notify;
  return n.telegram && isConfigured(n) ? new TelegramClient(n) : null;
}

/** Сигнал человеку: звук и уведомление в браузере, плюс сообщение в Telegram, если он настроен. */
async function notifyHuman(settings: Settings, title: string, message: string): Promise<void> {
  const tg = telegramClient(settings);
  await Promise.all([
    alertHuman(title, message, settings.safety.sound),
    tg?.send(`🔔 ${title}\n\n${message}`).catch((err: unknown) => console.warn('telegram failed', err)),
  ]);
}

/**
 * Дублирует запросы агента в Telegram: подтверждение — кнопками, вопрос — реплаем, итог — сообщением.
 * Ответ из чата идёт в runner так же, как из панели; ответили в панели — сообщение в чате помечается.
 */
function telegramSync(settings: Settings, runner: () => AgentRunner, url: () => Promise<string>): ((state: RunState) => void) | null {
  const client = telegramClient(settings);
  if (!client) return null;
  const bridge = new TelegramBridge(client);
  const asked = new Set<string>();
  let finished = false;
  const warn = (err: unknown) => console.warn('telegram failed', err);
  return (state) => {
    const approvalKey = `${state.id.slice(0, 8)}:${state.steps.length}`;
    const questionKey = `${approvalKey}:q`;
    for (const key of [...asked]) {
      const still = (key === approvalKey && state.status === 'awaiting_approval') || (key === questionKey && state.status === 'asking_user');
      if (!still) {
        asked.delete(key);
        void bridge.cancel(key, '☑️ Отвечено в браузере').catch(warn);
      }
    }
    if (state.status === 'awaiting_approval' && state.pendingApproval && !asked.has(approvalKey)) {
      asked.add(approvalKey);
      void url()
        .then((u) => bridge.askApproval(approvalKey, approvalText(state, u), (ok) => runner().approve(ok)))
        .catch(warn);
    }
    if (state.status === 'asking_user' && state.question !== undefined && !asked.has(questionKey)) {
      asked.add(questionKey);
      void bridge.askQuestion(questionKey, questionText(state), (text) => runner().answer(text)).catch(warn);
    }
    if (TERMINAL_STATUSES.has(state.status) && !finished) {
      finished = true;
      bridge.stop();
      if (settings.notify.onFinish) void client.send(finishText(state)).catch(warn);
    }
  };
}

/** Цепочка моделей для запуска — всегда из текущих настроек (и при возобновлении: облако могли запретить). */
function escalationConfig(settings: Settings): EscalationConfig {
  return {
    levels: modelLevels(settings).map((l) => ({
      id: l.id,
      label: l.profile.label,
      model: l.profile.model,
      contextTokens: l.profile.contextTokens,
      maxOutputTokens: l.profile.maxOutputTokens,
      vision: l.profile.vision,
      external: isExternalProfile(l.profile),
    })),
    failStreak: settings.escalation.failStreak,
    returnAfter: settings.escalation.returnAfter,
  };
}

function runConfig(settings: Settings, task: string, overrides: Partial<RunConfig> = {}): RunConfig {
  const profile = activeProfile(settings);
  return {
    task: task.trim(),
    systemTemplate,
    boundary: newBoundary(),
    maxSteps: settings.agent.maxSteps,
    maxActions: settings.agent.maxActionsPerStep,
    loopThreshold: settings.agent.loopThreshold,
    autoScrollAfter: settings.agent.autoScrollAfter,
    autoRead: settings.agent.autoRead,
    contextResetPercent: settings.agent.contextResetPercent,
    stepTimeoutSec: settings.agent.stepTimeoutSec,
    approveEachStep: settings.agent.approveEachStep,
    contextTokens: profile.contextTokens,
    maxOutputTokens: profile.maxOutputTokens,
    profileLabel: profile.label,
    model: profile.model,
    siteNotes: settings.siteNotes,
    autonomous: settings.agent.autonomous,
    riskRules: settings.safety.rules,
    approvalWindowSec: settings.safety.approvalWindowSec,
    // Картинки — по профилю каждой ступени (см. escalation.levels[].vision).
    screenshots: settings.agent.screenshots,
    escalation: escalationConfig(settings),
    // Чтение длится минутами по замыслу; потолок — лимит чтения плюс запас на зависший браузер.
    readTimeoutSec: settings.agent.autoReadMaxMin * 60 + 120,
    ...overrides,
  };
}

/**
 * Запускает цикл агента во вкладке. restore — состояние прерванного запуска из журнала:
 * тогда конфиг берётся из чекпоинта, а адрес сервера и модель — из текущего профиля.
 */
async function launch(settings: Settings, profileId: ProfileId, cfg: RunConfig, tab: AgentTab, restore?: RunState): Promise<RunState> {
  const profile = profileOf(settings, profileId);
  const progress = throttledProgress();
  const remote = settings.logging.remoteEnabled && settings.logging.remoteUrl ? settings.logging.remoteUrl : null;
  await pruneRuns().catch(() => {});
  await pruneDeferred(Date.now()).catch(() => {});
  // CDP подключается при первом клике/вводе; при отказе — DOM-события.
  const debuggers = settings.agent.useDebugger ? new DebuggerSessions() : null;
  const exec: ExecContext = {
    tab,
    cdp: debuggers ? (tabId) => debuggers.driverFor(tabId) : undefined,
    cdpUnavailable: () => debuggers?.unavailableReason ?? '',
    showCursor: settings.agent.showCursor,
    typing: { byKeys: settings.agent.typeByKeys, delayMs: settings.agent.typeDelayMs },
    readMaxMs: settings.agent.autoReadMaxMin * 60_000,
  };

  const { systemTemplate: _sys, ...cfgToSave } = cfg;
  const writeCheckpoint = async (state: RunState) => {
    if (TERMINAL_STATUSES.has(state.status)) return clearCheckpoint();
    const url = (await browser.tabs.get(tab.tabId).catch(() => null))?.url ?? '';
    await saveCheckpoint({ runId: state.id, cfg: cfgToSave, profileId, tab: { ...tab, url }, savedAt: Date.now() });
  };

  const tabUrl = async () => (await browser.tabs.get(tab.tabId).catch(() => null))?.url ?? '';
  const telegram = telegramSync(settings, () => runner, tabUrl);

  const runner: AgentRunner = new AgentRunner(
    cfg,
    {
      observe: (opts) =>
        observeAgentTab(tab, Math.min(settings.agent.maxObservationChars, opts?.maxChars ?? Infinity), settings.agent.debugOverlay, cfg.siteNotes, opts?.screenshot ?? false),
      // Профиль ступени цепочки (автосмена моделей) или профиль запуска.
      chat: (messages, schema, onDelta, onRetry, signal, levelId) =>
        chatStream({ profile: levelId ? profileOf(settings, levelId) : profile, messages, schema, onDelta, onRetry, signal }),
      execute: (action, handle, signal) => executeAction(action, handle, exec, signal),
      onState: (state) => {
        broadcast({ type: 'ui:run-state', info: { state, interrupted: false } });
        telegram?.(state);
      },
      onProgress: progress,
      persistRun: async (state) => {
        await saveRun(state);
        await writeCheckpoint(state);
        if (remote && TERMINAL_STATUSES.has(state.status)) {
          void postLog(remote, { type: 'run', runId: state.id, task: state.task, status: state.status, result: state.result, error: state.error, at: new Date().toISOString() });
        }
      },
      persistStep: async (state, step, detail) => {
        await saveStep(state.id, step, detail);
        if (remote) {
          void postLog(remote, {
            type: 'step',
            runId: state.id,
            task: state.task,
            status: state.status,
            step: { ...step, observation: detail.observation, responses: detail.responses },
            at: new Date().toISOString(),
          });
        }
      },
      checkpoint: async (state, step) => {
        await saveStep(state.id, step);
        await saveRun(state);
        await writeCheckpoint(state);
      },
      defer: async (item) => {
        await addDeferred(item);
        broadcast({ type: 'ui:queue-changed' });
      },
      // В Telegram запрос подтверждения уходит с кнопками (telegramSync) — здесь только звук и уведомление.
      alert: (message) => {
        void alertHuman('Агенту нужно подтверждение', message, settings.safety.sound);
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => crypto.randomUUID(),
    },
    restore,
  );

  interrupted = null;
  // Весь запуск (включая ожидание ответа человека) держим service worker живым.
  const stopKeepAlive = startKeepAlive();
  const finished = runner.run().finally(() => {
    stopKeepAlive();
    void debuggers?.detachAll();
    void clearCheckpoint();
  });
  current = { runner, tab, finished };
  return runner.state;
}

// ——— пролистывание курса: без модели, а на заминках — нейросеть ———

let course: { course: Course; state: CourseState; skipper: Skipper | null } | null = null;

const samePage = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return a === b;
  }
};

async function startSkip(windowId: number): Promise<void> {
  ensureIdle();
  const settings = await loadSettings();
  const active = await activeTab(windowId);
  const tab: AgentTab = { tabId: active.id, windowId };

  /** Один проход пролистывания (новый Skipper каждый раз: счётчики страницы — заново). */
  const skip = async (): Promise<SkipState> => {
    const s = await loadSettings();
    const debuggers = s.agent.useDebugger ? new DebuggerSessions() : null;
    const exec: ExecContext = {
      tab,
      cdp: debuggers ? (tabId) => debuggers.driverFor(tabId) : undefined,
      cdpUnavailable: () => debuggers?.unavailableReason ?? '',
      showCursor: s.agent.showCursor,
      typing: { byKeys: s.agent.typeByKeys, delayMs: s.agent.typeDelayMs },
      readMaxMs: s.agent.autoReadMaxMin * 60_000,
    };
    const skipper = new Skipper({
      observe: async () => {
        const obs = await observeAgentTab(tab, s.agent.maxObservationChars, false, s.siteNotes);
        return { url: obs.url, elements: obs.handle.elements ?? [], handle: obs.handle };
      },
      click: (index, handle) => executeAction({ action: 'click', index }, handle, exec),
      scrollToBottom: async (handle) => {
        for (let i = 0; i < 6; i++) {
          const r = await executeAction({ action: 'scroll', direction: 'down', amount: 10 }, handle, exec);
          if (!r.ok || /already at the bottom/.test(r.message)) break;
        }
      },
      isRisky: (line, url) =>
        assessAction({ action: { action: 'click', index: 1 }, target: line, flags: [], url, modelFlag: false, rules: s.safety.rules, policy: sitePolicyFor(url, s.siteNotes) })
          .length > 0,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onState: (state) => course?.course.skipProgress(state),
    });
    if (course) course.skipper = skipper;
    try {
      return await skipper.run();
    } finally {
      if (course) course.skipper = null;
      void debuggers?.detachAll();
    }
  };

  /** Нейросеть разбирается с заминкой; ушли со страницы — останавливаем её, курс поехал. */
  const solve = async (task: string, stuckUrl: string): Promise<SolveResult> => {
    const s = await loadSettings();
    const cfg = runConfig(s, task, { maxSteps: Math.min(s.agent.maxSteps, s.agent.skipAgentSteps) });
    await launch(s, s.activeProfile, cfg, tab);
    const run = current!;
    let movedOn = false;
    const watch = setInterval(() => {
      void browser.tabs.get(tab.tabId).then(
        (t) => {
          if (t.url && stuckUrl && !samePage(t.url, stuckUrl) && !TERMINAL_STATUSES.has(run.runner.state.status)) {
            movedOn = true;
            run.runner.stop();
          }
        },
        () => {},
      );
    }, 1500);
    try {
      const st = await run.finished;
      return { status: st.status, result: st.result, error: st.error, movedOn };
    } finally {
      clearInterval(watch);
    }
  };

  const c = new Course(
    {
      skip,
      solve,
      cancel: () => {
        course?.skipper?.stop();
        if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) current.runner.stop();
      },
      onState: (state) => {
        if (course) course.state = state;
        broadcast({ type: 'ui:skip-state', state });
      },
      alert: (message) => void notifyHuman(settings, 'Пролистывание курса остановилось', message),
    },
    { withAgent: settings.agent.skipWithAgent, maxAgentPerPage: 2 },
  );
  course = { course: c, state: c.state, skipper: null };
  const stopKeepAlive = startKeepAlive();
  void c.run().finally(stopKeepAlive);
}

const skipRunning = () => course?.state.status === 'running';

// ——— сценарии: запись запуска и повтор без модели ———

type ReplayReply = { approved?: boolean; text?: string | null };
let replay: { replayer: Replayer; macro: Macro; state: ReplayState; waiter: ((r: ReplayReply) => void) | null; abort: AbortController } | null = null;
const replayRunning = () => replay?.state.status === 'running';

async function saveRunAsMacro(runId: string, name: string): Promise<Macro> {
  const run = await loadRun(runId);
  if (!run) throw new Error('Запуск не найден в журнале.');
  const observations = new Map<number, string>();
  for (const s of run.steps) {
    const d = await getStepDetail(runId, s.n).catch(() => undefined);
    if (d) observations.set(s.n, d.observation);
  }
  const macro = macroFromRun(run, observations, name, crypto.randomUUID(), Date.now());
  if (macro.steps.length === 0) throw new Error('В этом запуске нет выполненных действий — сохранять нечего.');
  await saveMacro(macro);
  broadcast({ type: 'ui:macros-changed' });
  return macro;
}

const sameHost = (a: string, b: string) => {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
};

async function startReplay(id: string, windowId: number): Promise<void> {
  ensureIdle();
  const macro = await getMacro(id);
  if (!macro) throw new Error('Сценарий не найден.');
  const s = await loadSettings();
  const active = await activeTab(windowId);
  const tab: AgentTab = { tabId: active.id, windowId };
  // Другой сайт — сначала открываем страницу, с которой сценарий начинался.
  const start = normalizeNavigateUrl(macro.startUrl);
  if (start && !sameHost(active.url ?? '', start)) {
    await browser.tabs.update(tab.tabId, { url: start });
    await waitForTabLoad(tab.tabId);
  }
  const debuggers = s.agent.useDebugger ? new DebuggerSessions() : null;
  const exec: ExecContext = {
    tab,
    cdp: debuggers ? (tabId) => debuggers.driverFor(tabId) : undefined,
    cdpUnavailable: () => debuggers?.unavailableReason ?? '',
    showCursor: s.agent.showCursor,
    typing: { byKeys: s.agent.typeByKeys, delayMs: s.agent.typeDelayMs },
    readMaxMs: s.agent.autoReadMaxMin * 60_000,
  };
  const waitReply = () => new Promise<ReplayReply>((resolve) => replay && (replay.waiter = resolve));
  // «Стоп» должен прерывать и долгие действия (read идёт минутами).
  const abort = new AbortController();
  const replayer = new Replayer(macro, {
    observe: async () => {
      const obs = await observeAgentTab(tab, s.agent.maxObservationChars, false, s.siteNotes);
      return { url: obs.url, elements: obs.handle.elements ?? [], handle: obs.handle };
    },
    execute: (action, handle) => executeAction(action, handle, exec, abort.signal),
    assess: (action, target, toTarget, obs) => {
      const i = targetIndex(action);
      return assessAction({
        action,
        target,
        toTarget,
        flags: i !== undefined ? (obs.handle.flags?.[i] ?? []) : [],
        formSubmit: i !== undefined ? obs.handle.formSubmit?.[i] : undefined,
        url: obs.url,
        modelFlag: false,
        rules: s.safety.rules,
        policy: sitePolicyFor(obs.url, s.siteNotes),
      });
    },
    confirm: async (text) => {
      void notifyHuman(s, 'Повтор сценария ждёт подтверждения', text);
      return (await waitReply()).approved === true;
    },
    ask: async () => (await waitReply()).text ?? null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onState: (state) => {
      if (replay) replay.state = state;
      broadcast({ type: 'ui:macro-state', state });
    },
  });
  replay = { replayer, macro, state: replayer.state, waiter: null, abort };
  const stopKeepAlive = startKeepAlive();
  void replayer.run().finally(() => {
    stopKeepAlive();
    void debuggers?.detachAll();
  });
}

function stopReplay(): void {
  if (!replay) return;
  replay.replayer.stop();
  replay.abort.abort();
  replay.waiter?.({ approved: false, text: null });
  replay.waiter = null;
}

function ensureIdle(): void {
  if (replayRunning()) throw new Error('Идёт повтор сценария — сначала остановите его.');
  if (skipRunning()) throw new Error('Идёт пролистывание — сначала остановите его.');
  if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) throw new Error('Агент уже работает — остановите текущую задачу.');
  if (interrupted) throw new Error('Есть прерванная задача — продолжите или отмените её в панели.');
}

async function startRun(windowId: number, task: string, overrides: Partial<RunConfig> = {}): Promise<RunState> {
  ensureIdle();
  if (!task.trim()) throw new Error('Введите задачу.');
  const settings = await loadSettings();
  const active = await activeTab(windowId);
  return launch(settings, settings.activeProfile, runConfig(settings, task, overrides), { tabId: active.id, windowId });
}

// ——— продолжение после перезапуска ———

/** Вкладка прерванного запуска: по id (если там та же страница), по адресу, иначе открываем заново. */
async function findAgentTab(saved: RunCheckpoint['tab']): Promise<AgentTab> {
  const byId = await browser.tabs.get(saved.tabId).catch(() => null);
  if (byId?.id !== undefined && sameUrl(byId.url, saved.url)) return { tabId: byId.id, windowId: byId.windowId };
  const all = await browser.tabs.query({});
  const byUrl = all.find((t) => t.id !== undefined && sameUrl(t.url, saved.url));
  if (byUrl?.id !== undefined) return { tabId: byUrl.id, windowId: byUrl.windowId };

  const url = normalizeNavigateUrl(saved.url) ?? undefined;
  const win = await browser.windows.getLastFocused().catch(() => null);
  if (win?.id !== undefined) {
    const created = await browser.tabs.create({ windowId: win.id, url, active: true });
    if (created.id !== undefined) {
      await waitForTabLoad(created.id);
      return { tabId: created.id, windowId: win.id };
    }
  }
  const w = await browser.windows.create({ url, focused: true });
  const t = w?.tabs?.[0];
  if (w?.id === undefined || t?.id === undefined) throw new Error('Не удалось открыть вкладку для продолжения задачи.');
  await waitForTabLoad(t.id);
  return { tabId: t.id, windowId: w.id };
}

async function resumeInterrupted(): Promise<RunState> {
  if (!interrupted) throw new Error('Нет прерванной задачи.');
  if (current && !TERMINAL_STATUSES.has(current.runner.state.status)) throw new Error('Агент уже работает.');
  const { checkpoint, state } = interrupted;
  const settings = await loadSettings();
  const profileId: ProfileId = checkpoint.profileId in settings.profiles ? checkpoint.profileId : settings.activeProfile;
  const tab = await findAgentTab(checkpoint.tab);
  await browser.tabs.update(tab.tabId, { active: true }).catch(() => {});
  // Цепочку моделей и потолок чтения — из текущих настроек, а не из чекпоинта: за ночь могли запретить облако.
  const escalation = escalationConfig(settings);
  state.escalation = remapLevel(state.escalation, checkpoint.cfg.escalation?.levels, escalation.levels);
  const level = escalation.levels[state.escalation?.level ?? 0];
  if (level) Object.assign(state, { profileLabel: level.label, model: level.model });
  const cfg: RunConfig = { ...checkpoint.cfg, systemTemplate, escalation, readTimeoutSec: settings.agent.autoReadMaxMin * 60 + 120 };
  return launch(settings, profileId, cfg, tab, state);
}

async function discardInterrupted(): Promise<void> {
  if (!interrupted) return;
  const { state } = interrupted;
  interrupted = null;
  Object.assign(state, { status: 'stopped', finishedAt: Date.now(), error: 'Прервано перезапуском; продолжение отменено.' });
  delete state.pendingApproval;
  delete state.question;
  delete state.inFlight;
  await saveRun(state).catch(() => {});
  await clearCheckpoint();
  broadcast({ type: 'ui:run-state', info: { state, interrupted: false } });
}

let recovering: Promise<void> | null = null;

/** Проверка один раз на запуск воркера, сколько бы событий его ни разбудило. */
function recoverOnce(): Promise<void> {
  recovering ??= recoverOnStartup().catch((err: unknown) => console.error('recover failed', err));
  return recovering;
}

/** После старта воркера: нашёлся незавершённый запуск — ночью продолжаем сами, днём ждём кнопку. */
async function recoverOnStartup(): Promise<void> {
  if (current) return;
  const checkpoint = await loadCheckpoint();
  if (!checkpoint) return;
  const state = await loadRun(checkpoint.runId).catch(() => null);
  if (!state || TERMINAL_STATUSES.has(state.status)) {
    await clearCheckpoint();
    return;
  }
  interrupted = { checkpoint, state };
  broadcastRun();
  if (!checkpoint.cfg.autonomous) return;
  // Браузер мог только что запуститься — даём ему восстановить вкладки.
  await new Promise((r) => setTimeout(r, 5000));
  if (!interrupted || current) return;
  await resumeInterrupted().catch((err: unknown) => console.error('auto-resume failed', err));
}

// ——— очередь на утро ———

async function resumeFromQueue(id: string, windowId: number): Promise<RunState> {
  ensureIdle();
  const item = await getDeferred(id);
  if (!item) throw new Error('Этого элемента очереди уже нет.');
  const url = normalizeNavigateUrl(item.url);
  const active = await activeTab(windowId);
  if (url) {
    await browser.tabs.update(active.id, { url });
    await waitForTabLoad(active.id);
  }
  const settings = await loadSettings();
  // Утром человек рядом: обычный режим, рискованное подтверждается в панели.
  const state = await launch(settings, settings.activeProfile, runConfig(settings, resumeTask(item), { autonomous: false }), { tabId: active.id, windowId });
  await setDeferredStatus(id, 'resumed');
  broadcast({ type: 'ui:queue-changed' });
  return state;
}

function requireRun(): AgentRunner {
  if (!current) throw new Error('Нет активной задачи.');
  return current.runner;
}

async function handle(msg: BackgroundRequest): Promise<Result<unknown>> {
  switch (msg.type) {
    case 'bg:observe': {
      const tab = await activeTab(msg.windowId);
      const settings = await loadSettings();
      const hide = tab.url ? hiddenNamesFor(tab.url, settings.siteNotes) : [];
      const next = tab.url ? nextRulesFor(tab.url, settings.siteNotes) : [];
      const page = await observePage(tab.id, tab.url, { maxChars: settings.agent.maxObservationChars, highlight: msg.highlight, hide, next });
      return { ok: true, value: { text: page.text, stats: page.stats } };
    }
    case 'bg:screenshot': {
      const tab = await activeTab(msg.windowId);
      const settings = await loadSettings();
      const obs = await observeAgentTab({ tabId: tab.id, windowId: msg.windowId }, settings.agent.maxObservationChars, settings.agent.debugOverlay, settings.siteNotes, true);
      if (!obs.image) throw new Error('Не удалось снять экран: вкладка не активна или страница закрыта для расширений.');
      return { ok: true, value: obs.image };
    }
    case 'bg:highlight': {
      const tab = await activeTab(msg.windowId);
      await setHighlight(tab.id, tab.url, msg.enabled);
      return { ok: true, value: null };
    }
    case 'bg:run-start':
      return { ok: true, value: await startRun(msg.windowId, msg.task) };
    case 'bg:run-control': {
      const runner = requireRun();
      if (msg.command === 'pause') runner.pause();
      else if (msg.command === 'resume') runner.resume();
      else runner.stop();
      return { ok: true, value: null };
    }
    case 'bg:run-approve':
      requireRun().approve(msg.approved);
      return { ok: true, value: null };
    case 'bg:run-answer':
      requireRun().answer(msg.text);
      return { ok: true, value: null };
    case 'bg:run-get':
      return { ok: true, value: runInfo() };
    case 'bg:run-detail':
      return { ok: true, value: (await getStepDetail(msg.runId, msg.n)) ?? null };
    case 'bg:runs-list':
      return { ok: true, value: await listRuns() };
    case 'bg:run-export':
      return { ok: true, value: await exportRun(msg.runId) };
    case 'bg:run-recover':
      if (msg.command === 'resume') await resumeInterrupted();
      else await discardInterrupted();
      return { ok: true, value: null };
    case 'bg:queue-list':
      return { ok: true, value: await listDeferred() };
    case 'bg:queue-resume':
      return { ok: true, value: await resumeFromQueue(msg.id, msg.windowId) };
    case 'bg:queue-dismiss':
      await setDeferredStatus(msg.id, 'dismissed');
      broadcast({ type: 'ui:queue-changed' });
      return { ok: true, value: null };
    case 'bg:skip-start':
      await startSkip(msg.windowId);
      return { ok: true, value: null };
    case 'bg:skip-stop':
      course?.course.stop();
      return { ok: true, value: null };
    case 'bg:skip-get':
      return { ok: true, value: course?.state ?? null };
    case 'bg:macro-save':
      return { ok: true, value: await saveRunAsMacro(msg.runId, msg.name) };
    case 'bg:macro-list':
      return { ok: true, value: await listMacros() };
    case 'bg:macro-delete':
      await deleteMacro(msg.id);
      broadcast({ type: 'ui:macros-changed' });
      return { ok: true, value: null };
    case 'bg:macro-run':
      await startReplay(msg.id, msg.windowId);
      return { ok: true, value: null };
    case 'bg:macro-stop':
      stopReplay();
      return { ok: true, value: null };
    case 'bg:macro-get':
      return { ok: true, value: replay?.state ?? null };
    case 'bg:macro-reply': {
      const w = replay?.waiter;
      if (!w) throw new Error('Повтор ничего не ждёт.');
      replay!.waiter = null;
      w({ approved: msg.approved, text: msg.text });
      return { ok: true, value: null };
    }
    case 'bg:macro-handoff': {
      if (!replay || replay.state.status === 'running') throw new Error('Нет остановившегося повтора.');
      const task = handoffTask(replay.macro, replay.state);
      return { ok: true, value: await startRun(msg.windowId, task) };
    }
    case 'bg:telegram-test': {
      const client = new TelegramClient(msg.config);
      await client.send('✅ Связь с агентом есть. Сюда будут приходить запросы подтверждения и вопросы.');
      return { ok: true, value: null };
    }
    case 'bg:telegram-chat-id': {
      const id = await discoverChatId(new TelegramClient({ botToken: msg.botToken, chatId: '' }));
      if (!id) throw new Error('Боту ещё никто не писал: откройте бота в Telegram, нажмите «Start» или отправьте любое сообщение и повторите.');
      return { ok: true, value: id };
    }
    case 'bg:alert-test': {
      const settings = await loadSettings();
      await alertHuman('Проверка сигнала', 'Так агент позовёт вас, когда ночью упрётся в рискованное действие.', settings.safety.sound);
      return { ok: true, value: null };
    }
  }
}

export default defineBackground(() => {
  // Клик по иконке расширения открывает side panel.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel.setPanelBehavior failed', err));

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      void browser.runtime.openOptionsPage();
    }
    void recoverOnce(); // обновление/перезагрузка расширения посреди задачи
  });
  // Без этой подписки Chrome не будит воркер при запуске браузера, и ночная задача
  // не продолжилась бы сама, пока кто-нибудь не откроет панель.
  browser.runtime.onStartup.addListener(() => void recoverOnce());

  // Клик по уведомлению — показать вкладку, где агент ждёт подтверждения.
  browser.notifications.onClicked.addListener((id) => {
    if (id !== ALERT_NOTIFICATION_ID) return;
    void browser.notifications.clear(id);
    if (!current) return;
    const { tabId, windowId } = current.tab;
    void browser.windows.update(windowId, { focused: true }).catch(() => {});
    void browser.tabs.update(tabId, { active: true }).catch(() => {});
    void browser.sidePanel.open({ windowId }).catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isBackgroundRequest(msg)) return;
    handle(msg).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // ответ асинхронный
  });

  // Воркер мог быть выгружен и разбужен чем угодно (панель, уведомление) — тоже проверяем.
  void recoverOnce();
});
