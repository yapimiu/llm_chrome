import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import { activeProfile, loadSettings, profileOf, saveSettings, watchSettings, type ProfileId, type Settings } from '@/lib/settings';
import { checkConnection, type ConnectionReport } from '@/lib/llm/connection';
import { AgentPanel } from './AgentPanel';
import { Perception } from './Perception';
import { RunLog } from './RunLog';

type Status = { state: 'checking' } | { state: 'done'; report: ConnectionReport };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'checking' });
  const [task, setTask] = useState('');

  useEffect(() => {
    void loadSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);

  const profile = settings ? activeProfile(settings) : null;

  // Перепроверяем связь при смене профиля или его адреса/модели/ключа.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    setStatus({ state: 'checking' });
    void checkConnection(profile).then((report) => {
      if (!cancelled) setStatus({ state: 'done', report });
    });
    return () => {
      cancelled = true;
    };
  }, [profile?.baseUrl, profile?.model, profile?.apiKey]);

  if (!settings || !profile) return <main class="muted">Загрузка…</main>;

  const switchProfile = (id: ProfileId) => void saveSettings({ ...settings, activeProfile: id });

  return (
    <main>
      <header>
        <select value={settings.activeProfile} onChange={(e) => switchProfile(e.currentTarget.value as ProfileId)}>
          {settings.profileIds.map((id) => (
            <option key={id} value={id}>
              {profileOf(settings, id).label} — {profileOf(settings, id).model}
            </option>
          ))}
        </select>
        <button onClick={() => void browser.runtime.openOptionsPage()}>Настройки</button>
      </header>

      <ConnectionPill status={status} />

      <label class="field">
        <span>Задача</span>
        <textarea
          rows={4}
          value={task}
          placeholder="Например: найди на hh.ru вакансии Python-разработчика в Казани и выпиши три с самой высокой зарплатой"
          onInput={(e) => setTask(e.currentTarget.value)}
        />
      </label>

      {settings.agent.autonomous && (
        <div class="warn">
          Автономный режим: рискованные действия ждут подтверждения {settings.safety.approvalWindowSec} с{settings.safety.sound ? ' со звуком' : ''}, затем уходят в очередь на утро.
        </div>
      )}

      <AgentPanel task={task} settings={settings} />

      <Perception defaultHighlight={settings.agent.debugOverlay} maxChars={settings.agent.maxObservationChars} siteNotes={settings.siteNotes} />
      <RunLog />
    </main>
  );
}

function ConnectionPill({ status }: { status: Status }) {
  if (status.state === 'checking') return <span class="pill muted">Проверяю связь с сервером…</span>;
  const { report } = status;
  if (!report.ok) {
    return (
      <span class="pill err" title={report.error}>
        Нет связи: {report.error}
      </span>
    );
  }
  const cls = report.warnings.length > 0 ? 'warn' : 'ok';
  return (
    <span class={`pill ${cls}`} title={report.warnings.join('\n')}>
      {report.server.kind} · {report.resolvedModel ?? '—'} · {report.latencyMs} мс
      {report.warnings.length > 0 ? ` · предупреждений: ${report.warnings.length}` : ''}
    </span>
  );
}
