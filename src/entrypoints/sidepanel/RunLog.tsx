import { useState } from 'preact/hooks';
import type { RunSummary } from '@/lib/agent/types';
import { sendToBackground } from '@/lib/messages';
import { STATUS_LABELS } from './AgentPanel';

function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Журнал запусков из IndexedDB с экспортом в JSON. */
export function RunLog() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState('');

  const load = async (open: boolean) => {
    if (!open) return;
    const res = await sendToBackground({ type: 'bg:runs-list' });
    if (res.ok) setRuns(res.value);
    else setError(res.error);
  };

  const exportRun = async (run: RunSummary) => {
    const res = await sendToBackground({ type: 'bg:run-export', runId: run.id });
    if (!res.ok) return setError(res.error);
    const stamp = new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(`agent-run-${stamp}.json`, res.value);
  };

  const exportTokens = async (run: RunSummary) => {
    const res = await sendToBackground({ type: 'bg:run-usage-export', runId: run.id });
    if (!res.ok) return setError(res.error);
    const stamp = new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(`agent-usage-${stamp}.json`, res.value);
  };

  return (
    <details class="card runlog" onToggle={(e) => void load(e.currentTarget.open)}>
      <summary>Журнал запусков</summary>
      {error && <div class="err">{error}</div>}
      {runs?.length === 0 && <div class="muted">Пока пусто.</div>}
      {runs && runs.length > 0 && (
        <ul>
          {runs.map((r) => (
            <li key={r.id}>
              <div class="runlog-task">{r.task}</div>
              <div class="muted stats">
                {new Date(r.startedAt).toLocaleString()} · {STATUS_LABELS[r.status]} · шагов {r.steps}
                <button class="link" onClick={() => void exportRun(r)}>
                  JSON
                </button>
                <button class="link" onClick={() => void exportTokens(r)}>Токены</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
