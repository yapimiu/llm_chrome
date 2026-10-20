import { useState } from 'preact/hooks';
import { browser } from '#imports';
import type { Diagnosis } from '@/lib/dom/diagnose';
import { errorMessage, sendToBackground, type HidePick, type ObserveResult } from '@/lib/messages';
import { activeTab, ensureContentScript, sendToContent } from '@/lib/perception';
import { addHideRule, hiddenNamesFor, sitePatternFor, type SiteNote } from '@/lib/agent/site-notes';
import { loadSettings, saveSettings } from '@/lib/settings';

async function currentWindowId(): Promise<number> {
  const win = await browser.windows.getCurrent();
  if (win.id === undefined) throw new Error('Не удалось определить окно.');
  return win.id;
}

interface Props {
  defaultHighlight: boolean;
  maxChars: number;
  siteNotes: SiteNote[];
}

/** «Что видит модель»: снимок активной вкладки ровно в том виде, в каком он уйдёт в промпт. */
export function Perception({ defaultHighlight, maxChars, siteNotes }: Props) {
  const [highlight, setHighlight] = useState(defaultHighlight);
  const [result, setResult] = useState<ObserveResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [hiding, setHiding] = useState(false);
  /** Что выбираем мышью: элемент, который надо скрыть, или кнопку «Далее». */
  const [pickMode, setPickMode] = useState<'hide' | 'next'>('hide');
  const [hidePick, setHidePick] = useState<(HidePick & { pattern: string; mode: 'hide' | 'next' }) | null>(null);
  const [hideSaved, setHideSaved] = useState('');
  const [shot, setShot] = useState<string | null>(null);

  const screenshot = async () => {
    setBusy(true);
    setError('');
    const res = await sendToBackground({ type: 'bg:screenshot', windowId: await currentWindowId() });
    setBusy(false);
    if (res.ok) setShot(res.value);
    else setError(res.error);
  };

  const observe = async (withHighlight = highlight) => {
    setBusy(true);
    setError('');
    const res = await sendToBackground({ type: 'bg:observe', windowId: await currentWindowId(), highlight: withHighlight });
    setBusy(false);
    if (res.ok) setResult(res.value);
    else setError(res.error);
  };

  const toggleHighlight = async (enabled: boolean) => {
    setHighlight(enabled);
    // Включение пересобирает снимок, чтобы номера на странице совпадали с текстом.
    if (enabled) return observe(true);
    const res = await sendToBackground({ type: 'bg:highlight', windowId: await currentWindowId(), enabled: false });
    if (!res.ok) setError(res.error);
  };

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Панель говорит с content script напрямую: ожидание клика может длиться долго,
  // а service worker держать живым ради этого незачем.
  const pick = async () => {
    setError('');
    setDiagnosis(null);
    try {
      const tab = await activeTab(await currentWindowId());
      await ensureContentScript(tab.id, tab.url);
      if (picking) {
        await sendToContent(tab.id, { type: 'content:pick-cancel' });
        return;
      }
      setPicking(true);
      const hide = tab.url ? hiddenNamesFor(tab.url, siteNotes) : [];
      setDiagnosis(await sendToContent(tab.id, { type: 'content:pick', maxChars, hide }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPicking(false);
    }
  };

  /** «Скрыть от модели»: кликнуть элемент → предложенное правило → в заметку для сайта. */
  const pickToHide = async (mode: 'hide' | 'next' = 'hide') => {
    setPickMode(mode);
    setError('');
    setHideSaved('');
    setHidePick(null);
    try {
      const tab = await activeTab(await currentWindowId());
      await ensureContentScript(tab.id, tab.url);
      if (hiding) {
        await sendToContent(tab.id, { type: 'content:pick-cancel' });
        return;
      }
      setHiding(true);
      const hide = tab.url ? hiddenNamesFor(tab.url, siteNotes) : [];
      const picked = await sendToContent(tab.id, { type: 'content:pick-rule', maxChars, hide, preferSelector: mode === 'next' });
      if (picked) setHidePick({ ...picked, pattern: sitePatternFor(picked.url), mode });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setHiding(false);
    }
  };

  const saveHideRule = async () => {
    if (!hidePick) return;
    const settings = await loadSettings();
    await saveSettings({ ...settings, siteNotes: addHideRule(settings.siteNotes, hidePick.pattern, hidePick.rule, hidePick.mode) });
    setHideSaved(
      hidePick.mode === 'next'
        ? `Готово: на ${hidePick.pattern} модель увидит эту кнопку с пометкой ← NEXT.`
        : `Добавлено в заметку для ${hidePick.pattern}. Можно выбрать следующий элемент.`,
    );
    setHidePick(null);
    if (result) void observe();
  };

  const s = result?.stats;

  return (
    <details class="card perception">
      <summary>Что видит модель</summary>
      <div class="row">
        <button onClick={() => void observe()} disabled={busy}>
          {busy ? 'Снимаю…' : result ? 'Обновить' : 'Показать'}
        </button>
        <label class="check">
          <input type="checkbox" checked={highlight} onChange={(e) => void toggleHighlight(e.currentTarget.checked)} />
          Подсветка на странице
        </label>
        <button onClick={() => void pick()} title="Кликните элемент на странице — расширение объяснит, видит ли его модель">
          {picking ? 'Отменить выбор' : 'Почему не виден?'}
        </button>
        <button onClick={() => void pickToHide('hide')} title="Кликните элемент на странице — модель перестанет его видеть на этом сайте">
          {hiding && pickMode === 'hide' ? 'Отменить выбор' : 'Скрыть элемент…'}
        </button>
        <button
          onClick={() => void pickToHide('next')}
          title="Кликните кнопку перехода к следующему уроку/странице — модель увидит её с пометкой NEXT, даже если на ней одни эмодзи"
        >
          {hiding && pickMode === 'next' ? 'Отменить выбор' : 'Это кнопка «Далее»…'}
        </button>
        <button onClick={() => void screenshot()} disabled={busy} title="Снимок экрана с номерами элементов — его получает модель со зрением">
          Скриншот
        </button>
        {result && (
          <button onClick={() => void copy()} title="Скопировать текст наблюдения">
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        )}
      </div>

      {error && <div class="err">{error}</div>}

      {(picking || hiding) && <div class="muted">Кликните элемент на странице. Esc — отмена.</div>}

      {hideSaved && <div class="ok">{hideSaved}</div>}

      {hidePick && (
        <div class="card diagnosis warn-border">
          <div class="mono">{hidePick.element}</div>
          {hidePick.alreadyHidden && <div class="ok">Этот элемент уже скрыт от модели.</div>}
          <label class="field">
            <span>{hidePick.mode === 'next' ? 'Правило кнопки «Далее» (css: селектор — текст на ней меняется)' : 'Правило «Скрыть от модели» (текст кнопки или css: селектор)'}</span>
            <input class="mono" value={hidePick.rule} spellcheck={false} onInput={(e) => setHidePick({ ...hidePick, rule: e.currentTarget.value })} />
          </label>
          <div class={hidePick.matches > 1 ? 'warn' : 'muted'}>
            Под правило попадает элементов на странице: {hidePick.matches}
            {hidePick.matches > 1 ? (hidePick.mode === 'next' ? ' — все получат пометку NEXT' : ' — все они будут скрыты') : ''}
          </div>
          <label class="field">
            <span>Для сайта</span>
            <input class="mono" value={hidePick.pattern} spellcheck={false} onInput={(e) => setHidePick({ ...hidePick, pattern: e.currentTarget.value })} />
          </label>
          <div class="row">
            <button class="primary" disabled={!hidePick.rule.trim() || !hidePick.pattern.trim()} onClick={() => void saveHideRule()}>
              {hidePick.mode === 'next' ? 'Отметить как «Далее»' : 'Скрыть'}
            </button>
            <button onClick={() => setHidePick(null)}>Отмена</button>
          </div>
        </div>
      )}

      {diagnosis && (
        <div class={`card diagnosis ${diagnosis.ok ? 'ok-border' : 'warn-border'}`}>
          <div class="mono">{diagnosis.element}</div>
          <div class={diagnosis.ok ? 'ok' : 'warn'}>{diagnosis.verdict}</div>
          {diagnosis.details.length > 0 && (
            <ul>
              {diagnosis.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {s && (
        <div class="muted stats">
          Элементов: {s.shownElements} из {s.totalElements}
          {s.omittedElements > 0 && <span class="warn"> (не влезло {s.omittedElements})</span>} · символов {s.chars} / {s.maxChars}
          {s.textTruncated && ' · текст обрезан'} · {s.durationMs} мс
          <br />
          Отброшено: перекрыто {s.covered}, невидимо {s.hidden}, вне прокрутки {s.offscreen}
          {s.userHidden > 0 && `, скрыто заметкой ${s.userHidden}`}
          {s.walkTruncated && <span class="warn"> · DOM слишком большой, обход прерван</span>}
        </div>
      )}

      {shot && (
        <a href={shot} target="_blank" rel="noreferrer" title="Открыть в полном размере">
          <img class="screenshot" src={shot} alt="Скриншот с номерами элементов" />
        </a>
      )}
      {result && <pre class="output mono observation">{result.text}</pre>}
    </details>
  );
}
