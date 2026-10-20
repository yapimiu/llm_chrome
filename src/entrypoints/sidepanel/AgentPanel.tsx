import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import { TERMINAL_STATUSES, type RunState, type RunStatus } from '@/lib/agent/types';
import { isUiEvent, sendToBackground, type RunInfo } from '@/lib/messages';
import { saveSettings, type Settings } from '@/lib/settings';
import { Macros, SaveMacro } from './Macros';
import { Queue } from './Queue';
import { SkipPanel } from './SkipPanel';
import { ActionLine, StepCard } from './StepCard';

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'работает',
  paused: 'на паузе',
  awaiting_approval: 'ждёт одобрения',
  asking_user: 'ждёт ответа',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлен',
  deferred: 'ждёт утра',
};

interface Live {
  phase: string;
  content: string;
  reasoningChars: number;
}

/** Текущее состояние запуска из background + живой поток токенов модели. */
function useRun(): { run: RunState | null; interrupted: boolean; live: Live } {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [live, setLive] = useState<Live>({ phase: '', content: '', reasoningChars: 0 });

  useEffect(() => {
    void sendToBackground({ type: 'bg:run-get' }).then((res) => res.ok && setInfo(res.value));
    const listener = (msg: unknown) => {
      if (!isUiEvent(msg)) return;
      if (msg.type === 'ui:run-state') return setInfo(msg.info);
      if (msg.type !== 'ui:step-progress') return;
      const e = msg.event;
      setLive((l) => {
        switch (e.phase) {
          case 'observe':
            return { phase: 'Смотрю на страницу…', content: '', reasoningChars: 0 };
          case 'llm':
            return { phase: e.attempt > 1 ? `Переспрашиваю модель (попытка ${e.attempt})…` : 'Модель думает…', content: '', reasoningChars: 0 };
          case 'delta':
            return { ...l, content: l.content + e.content, reasoningChars: l.reasoningChars + e.reasoning.length };
          case 'parse-error':
            return { ...l, phase: `Неразборчивый ответ: ${e.error}` };
          case 'service-retry':
            return { ...l, phase: `Сервис недоступен (${e.error}). Жду ${Math.round(e.waitMs / 1000)} с и пробую снова — попытка ${e.attempt}.` };
        }
      });
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  return { run: info?.state ?? null, interrupted: info?.interrupted ?? false, live };
}

/** Секунды до deadline, обновляются раз в секунду. */
function useCountdown(deadline: number | undefined): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function AgentPanel({ task, settings }: { task: string; settings: Settings }) {
  const { run, interrupted, live } = useRun();
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const active = run !== null && !interrupted && !TERMINAL_STATUSES.has(run.status);
  const secondsLeft = useCountdown(run?.status === 'awaiting_approval' ? run.pendingApproval?.deadline : undefined);
  const setAgentFlag = (key: 'approveEachStep' | 'autonomous', value: boolean) => void saveSettings({ ...settings, agent: { ...settings.agent, [key]: value } });

  const call = async (p: ReturnType<typeof sendToBackground>) => {
    setError('');
    const res = await p;
    if (!res.ok) setError(res.error);
  };

  const start = async () => {
    const win = await browser.windows.getCurrent();
    await call(sendToBackground({ type: 'bg:run-start', windowId: win.id!, task }));
  };
  const control = (command: 'pause' | 'resume' | 'stop') => void call(sendToBackground({ type: 'bg:run-control', command }));

  const sendAnswer = () => {
    void call(sendToBackground({ type: 'bg:run-answer', text: answer }));
    setAnswer('');
  };

  const steps = run ? [...run.steps].reverse() : [];

  return (
    <>
      {interrupted && run && (
        <div class="card approval">
          <b>Задача прервана перезапуском браузера или расширения</b>
          <div class="muted runlog-task">{run.task}</div>
          <p class="muted">
            Выполнено шагов: {run.steps.length}. Агент продолжит с текущей страницы и проверит, что успело выполниться.
          </p>
          <div class="row">
            <button class="primary" onClick={() => void call(sendToBackground({ type: 'bg:run-recover', command: 'resume' }))}>
              Продолжить
            </button>
            <button onClick={() => void call(sendToBackground({ type: 'bg:run-recover', command: 'discard' }))}>Отменить</button>
          </div>
        </div>
      )}

      <div class="row controls">
        {!active && !interrupted && (
          <button class="primary" onClick={() => void start()} disabled={!task.trim()}>
            Старт
          </button>
        )}
        {active && run.status === 'paused' ? (
          <button class="primary" onClick={() => control('resume')}>
            Продолжить
          </button>
        ) : (
          active && (
            <button onClick={() => control('pause')} disabled={run.pauseRequested}>
              {run.pauseRequested ? 'Пауза после шага…' : 'Пауза'}
            </button>
          )
        )}
        {active && <button onClick={() => control('stop')}>Стоп</button>}
      </div>

      <div class="row" style={{ gap: '16px' }}>
        <label class="check" title="Рискованные действия ждут подтверждения N секунд со звуком, затем уходят в очередь на утро; ask_user — модель решает сама">
          <input type="checkbox" checked={settings.agent.autonomous} disabled={active} onChange={(e) => setAgentFlag('autonomous', e.currentTarget.checked)} />
          Автономный режим
        </label>
        <label class="check" title="Отладка: подтверждать и безопасные шаги. В автономном режиме не действует">
          <input
            type="checkbox"
            checked={settings.agent.approveEachStep}
            disabled={active || settings.agent.autonomous}
            onChange={(e) => setAgentFlag('approveEachStep', e.currentTarget.checked)}
          />
          Подтверждать каждый шаг
        </label>
      </div>

      {error && <div class="err">{error}</div>}

      {run && !interrupted && (
        <div class={`card run-status status-${run.status}`}>
          <div>
            <b>{STATUS_LABELS[run.status]}</b> · шаг {run.steps.length} из {run.maxSteps} · {run.model}
            {run.autonomous ? ' · автономно' : ''}
            {run.restarts ? ` · перезапусков: ${run.restarts}` : ''}
          </div>
          <div class="muted runlog-task">{run.task}</div>
        </div>
      )}

      {!interrupted && run?.status === 'awaiting_approval' && run.pendingApproval && (
        <div class={`card approval${run.pendingApproval.actions.some((a) => a.risk) ? ' risky' : ''}`}>
          <b>{run.pendingApproval.actions.some((a) => a.risk) ? 'Рискованное действие — нужно ваше подтверждение:' : 'Агент хочет сделать:'}</b>
          {secondsLeft !== null && <p class="warn">Без ответа через {secondsLeft} с действие уйдёт в очередь на утро, агент продолжит остальное.</p>}
          {run.pendingApproval.reasoning && <p>{run.pendingApproval.reasoning}</p>}
          <ol class="actions">
            {run.pendingApproval.actions.map((a, i) => (
              <ActionLine key={i} a={a} />
            ))}
          </ol>
          <div class="row">
            <button class="primary" onClick={() => void call(sendToBackground({ type: 'bg:run-approve', approved: true }))}>
              Выполнить
            </button>
            <button onClick={() => void call(sendToBackground({ type: 'bg:run-approve', approved: false }))}>Отклонить</button>
          </div>
        </div>
      )}

      {!interrupted && run?.status === 'asking_user' && (
        <div class="card approval">
          <b>Агент спрашивает:</b>
          <p>{run.question}</p>
          <textarea rows={2} value={answer} onInput={(e) => setAnswer(e.currentTarget.value)} placeholder="Ваш ответ" />
          <div class="row">
            <button class="primary" onClick={sendAnswer} disabled={!answer.trim()}>
              Ответить
            </button>
          </div>
        </div>
      )}

      {run?.status === 'running' && live.phase && (
        <div class="card live">
          <div class="muted">
            {live.phase}
            {live.reasoningChars > 0 && ` · рассуждения ${live.reasoningChars} симв.`}
          </div>
          {live.content && <pre class="output mono">{live.content}</pre>}
        </div>
      )}

      {run?.status === 'done' && (
        <div class="card result ok-border">
          <b>Результат</b>
          <p class="pre">{run.result || '(пусто)'}</p>
          <SaveMacro run={run} />
        </div>
      )}
      {run?.status === 'deferred' && (
        <div class="card result warn-border">
          <b>Ждёт утра</b>
          <p class="pre">{run.result}</p>
        </div>
      )}
      {(run?.status === 'failed' || run?.status === 'stopped') && run.error && <div class="card err warn-border">{run.error}</div>}

      {run && run.extracted.length > 0 && (
        <details class="card" open={run.status === 'done'}>
          <summary>Сохранённые данные ({run.extracted.length})</summary>
          <ol>
            {run.extracted.map((e, i) => (
              <li key={i} class="pre">
                {e}
              </li>
            ))}
          </ol>
        </details>
      )}

      <SkipPanel busy={active || interrupted} settings={settings} />

      <Macros busy={active || interrupted} />

      <Queue busy={active || interrupted} />

      <section class="feed">
        {steps.length === 0 && <div class="empty muted card">Лента шагов появится, когда агент начнёт работать.</div>}
        {run && steps.map((s) => <StepCard key={`${run.id}-${s.n}`} step={s} runId={run.id} />)}
      </section>
    </>
  );
}
