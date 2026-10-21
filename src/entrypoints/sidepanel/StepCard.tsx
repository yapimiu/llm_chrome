import { useState } from 'preact/hooks';
import { formatAction } from '@/lib/agent/actions';
import { RISK_LABELS } from '@/lib/agent/risk';
import type { ExecutedAction, StepDetail, StepRecord } from '@/lib/agent/types';
import { sendToBackground } from '@/lib/messages';

export const seconds = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} с`);

function host(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.length > 1 ? u.pathname.slice(0, 30) : ''}`;
  } catch {
    return url;
  }
}

export function ActionLine({ a }: { a: ExecutedAction }) {
  const icon = a.skipped ? '⏭' : !a.result ? '•' : a.result.ok ? '✓' : '✗';
  const cls = a.skipped ? 'muted' : !a.result ? '' : a.result.ok ? 'ok' : 'err';
  return (
    <li class={cls}>
      <span class="mono">
        {icon} {formatAction(a.action)}
      </span>
      {a.target && <span class="muted"> → {a.target}</span>}
      {a.risk?.map((r, i) => (
        <div key={i} class="risk">
          ⚠ {RISK_LABELS[r.kind]}: {r.why}
        </div>
      ))}
      {a.result && !a.result.ok && <div class="err">{a.result.message}</div>}
      {a.result?.ok && a.result.message !== 'ok' && a.result.message !== 'clicked' && <div class="muted">{a.result.message}</div>}
      {a.skipped && <div class="muted">пропущено: {a.skipped}</div>}
    </li>
  );
}

/** Шаг в ленте: что решила модель, что получилось; что она видела — по запросу из журнала. */
export function StepCard({ step, runId }: { step: StepRecord; runId: string }) {
  const [detail, setDetail] = useState<StepDetail | null | 'loading'>(null);

  const loadDetail = async (open: boolean) => {
    if (!open || detail) return;
    setDetail('loading');
    const res = await sendToBackground({ type: 'bg:run-detail', runId, n: step.n });
    setDetail(res.ok ? res.value : null);
  };

  return (
    <article class="card step-card">
      <header class="muted stats">
        Шаг {step.n} · {seconds(step.durationMs)}
        {step.llm && ` · ${step.llm.profile ? `${step.llm.profile}: ` : 'модель '}${seconds(step.llm.totalMs)}${step.llm.attempts > 1 ? ` (${step.llm.attempts} попытки)` : ''}`} · {host(step.url)}
      </header>
      {step.reasoning && <p>{step.reasoning}</p>}
      {step.actions.length > 0 && (
        <ol class="actions">
          {step.actions.map((a, i) => (
            <ActionLine key={i} a={a} />
          ))}
        </ol>
      )}
      {step.expectedOutcome && <p class="muted">Ожидание: {step.expectedOutcome}</p>}
      {step.notes.map((n) => (
        <p key={n} class="note">
          {n}
        </p>
      ))}
      {step.warnings.map((w) => (
        <p key={w} class="warn">
          {w}
        </p>
      ))}
      {step.error && <p class="err">{step.error}</p>}
      <details onToggle={(e) => void loadDetail(e.currentTarget.open)}>
        <summary>Что видела модель и что ответила</summary>
        {detail === 'loading' && <p class="muted">Загружаю…</p>}
        {detail && detail !== 'loading' && (
          <>
            {detail.siteNotes && (
              <>
                <div class="muted">Заметки для сайта:</div>
                <pre class="output mono">{detail.siteNotes}</pre>
              </>
            )}
            {detail.history && (
              <>
                <div class="muted">История в промпте:</div>
                <pre class="output mono">{detail.history}</pre>
              </>
            )}
            {detail.screenshot && (
              <>
                <div class="muted">Скриншот:</div>
                <a href={detail.screenshot} target="_blank" rel="noreferrer">
                  <img class="screenshot" src={detail.screenshot} alt="Скриншот, который видела модель" />
                </a>
              </>
            )}
            <div class="muted">Страница:</div>
            <pre class="output mono">{detail.observation}</pre>
            {detail.responses.map((r, i) => (
              <div key={i}>
                <div class="muted">
                  Ответ{detail.responses.length > 1 ? ` #${i + 1}` : ''}
                  {r.parseError ? ` — не разобран: ${r.parseError}` : ''}
                  {r.reasoning ? ` · рассуждения ${r.reasoning.length} симв.` : ''}
                </div>
                <pre class="output mono">{r.content || '(пусто)'}</pre>
              </div>
            ))}
          </>
        )}
      </details>
    </article>
  );
}
