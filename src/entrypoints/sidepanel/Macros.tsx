import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import type { Macro, ReplayState } from '@/lib/agent/macro';
import { formatAction } from '@/lib/agent/actions';
import type { RunState } from '@/lib/agent/types';
import { isUiEvent, sendToBackground } from '@/lib/messages';

const LABELS: Record<ReplayState['status'], string> = {
  running: 'повторяю',
  done: 'готово',
  failed: 'сбился',
  stopped: 'остановлен',
};

const windowId = async () => (await browser.windows.getCurrent()).id!;

/** «Сохранить как сценарий» под результатом запуска. */
export function SaveMacro({ run }: { run: RunState }) {
  const [name, setName] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'ok' | 'err'; text?: string }>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setState({ kind: 'idle' });
    setOpen(false);
    setName(run.task.slice(0, 60));
  }, [run.id]);

  if (state.kind === 'ok') return <div class="ok">{state.text}</div>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} title="Записать выполненные действия, чтобы повторять их без модели">
        💾 Сохранить как сценарий
      </button>
    );
  const save = async () => {
    const res = await sendToBackground({ type: 'bg:macro-save', runId: run.id, name });
    setState(res.ok ? { kind: 'ok', text: `Сценарий «${res.value.name}» сохранён: шагов ${res.value.steps.length}. Он в разделе «Сценарии».` } : { kind: 'err', text: res.error });
  };
  return (
    <div class="row">
      <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="Название сценария" style={{ flex: 1 }} />
      <button class="primary" onClick={() => void save()}>
        Сохранить
      </button>
      {state.kind === 'err' && <span class="err">{state.text}</span>}
    </div>
  );
}

/** Сценарии: повтор записанных действий без модели; сбился — можно передать задачу нейросети. */
export function Macros({ busy }: { busy: boolean }) {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    const res = await sendToBackground({ type: 'bg:macro-list' });
    if (res.ok) setMacros(res.value);
  };

  useEffect(() => {
    void load();
    void sendToBackground({ type: 'bg:macro-get' }).then((r) => r.ok && setReplay(r.value));
    const listener = (msg: unknown) => {
      if (!isUiEvent(msg)) return;
      if (msg.type === 'ui:macros-changed') void load();
      if (msg.type === 'ui:macro-state') setReplay(msg.state);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const call = async (p: ReturnType<typeof sendToBackground>) => {
    setError('');
    const res = await p;
    if (!res.ok) setError(res.error);
  };
  const running = replay?.status === 'running';
  if (macros.length === 0 && !replay) return null;

  return (
    <details class={`card macros${running ? ' warn-border' : ''}`} open={running || replay?.status === 'failed'}>
      <summary>Сценарии ({macros.length})</summary>
      {error && <div class="err">{error}</div>}

      {replay && (
        <div class={`card ${replay.status === 'failed' ? 'warn-border' : ''}`}>
          <div>
            <b>{replay.name}</b> · {LABELS[replay.status]} · шаг {replay.step} из {replay.total}
          </div>
          {replay.message && <div class={replay.status === 'failed' ? 'warn' : 'muted'}>{replay.message}</div>}
          {replay.pending?.kind === 'confirm' && (
            <div class="approval risky">
              <p class="pre">Рискованный шаг: {replay.pending.text}</p>
              <div class="row">
                <button class="primary" onClick={() => void call(sendToBackground({ type: 'bg:macro-reply', approved: true }))}>
                  Выполнить
                </button>
                <button onClick={() => void call(sendToBackground({ type: 'bg:macro-reply', approved: false }))}>Отклонить</button>
              </div>
            </div>
          )}
          {replay.pending?.kind === 'input' && (
            <div class="row">
              <input type="password" value={secret} placeholder={replay.pending.text} onInput={(e) => setSecret(e.currentTarget.value)} style={{ flex: 1 }} />
              <button
                class="primary"
                onClick={() => {
                  void call(sendToBackground({ type: 'bg:macro-reply', text: secret }));
                  setSecret('');
                }}
              >
                Ввести
              </button>
            </div>
          )}
          <div class="row">
            {running && <button onClick={() => void call(sendToBackground({ type: 'bg:macro-stop' }))}>Остановить</button>}
            {(replay.status === 'failed' || replay.status === 'stopped') && (
              <button disabled={busy} title="Запустить агента с исходной задачей сценария с текущей страницы" onClick={() => void windowId().then((w) => call(sendToBackground({ type: 'bg:macro-handoff', windowId: w })))}>
                🧠 Передать нейросети
              </button>
            )}
          </div>
        </div>
      )}

      <ul>
        {macros.map((m) => (
          <li key={m.id}>
            <div class="runlog-task">{m.name}</div>
            <div class="muted stats" title={m.steps.map((s) => formatAction(s.action) + (s.target ? ` → ${s.target}` : '')).join('\n')}>
              шагов {m.steps.length} · {new Date(m.createdAt).toLocaleDateString()} · {m.startUrl}
            </div>
            <div class="row">
              <button class="primary" disabled={busy || running} onClick={() => void windowId().then((w) => call(sendToBackground({ type: 'bg:macro-run', id: m.id, windowId: w })))}>
                ▶ Повторить
              </button>
              <button
                onClick={() => {
                  if (confirm(`Удалить сценарий «${m.name}»?`)) void call(sendToBackground({ type: 'bg:macro-delete', id: m.id }));
                }}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
