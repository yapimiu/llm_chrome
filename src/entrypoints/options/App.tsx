import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_SETTINGS,
  isExternalProfile,
  loadSettings,
  parseExtraBody,
  profileOf,
  saveSettings,
  type AgentSettings,
  type LlmProfile,
  type NotifySettings,
  type SafetySettings,
  type ProfileId,
  type Settings,
  type StructuredOutputMode,
} from '@/lib/settings';
import { checkConnection, probeGeneration, type ConnectionReport, type ProbeResult } from '@/lib/llm/connection';
import { DEFAULT_RISK_RULES, type RiskRules, type SiteRiskMode } from '@/lib/agent/risk';
import { PROVIDERS, PROVIDER_IDS, providerInfo, type ProviderId } from '@/lib/llm/providers';
import { sendToBackground } from '@/lib/messages';
import { ICONS_RULE, parseHideRules } from '@/lib/dom/hide-rules';
import { isLocalHost, normalizeBaseUrl } from '@/lib/llm/url';
import { CheckField, NumberField, TextField } from '@/ui/fields';

const RISK_MODE_LABELS: Record<SiteRiskMode, string> = {
  ask: 'спрашивать подтверждение',
  allow: 'выполнять без подтверждения',
  block: 'запрещать',
};

const RULE_FIELDS: { key: keyof RiskRules; label: string }[] = [
  { key: 'payment', label: 'Оплата — тексты кнопок' },
  { key: 'delete', label: 'Удаление — тексты кнопок' },
  { key: 'send', label: 'Отправка — тексты кнопок' },
  { key: 'paymentUrls', label: 'Страницы оплаты — части адреса' },
];

const STRUCTURED_LABELS: Record<StructuredOutputMode, string> = {
  auto: 'Авто (json_schema → парсинг текста)',
  json_schema: 'response_format: json_schema',
  json_object: 'response_format: json_object',
  off: 'Выкл (только парсинг текста)',
};

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ProfileId>(DEFAULT_SETTINGS.activeProfile);
  const [saved, setSaved] = useState<'idle' | 'dirty' | 'saved'>('idle');

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setTab(s.activeProfile);
    });
  }, []);

  if (!settings) return <main class="muted">Загрузка…</main>;

  const update = (fn: (s: Settings) => Settings) => {
    setSettings(fn(settings));
    setSaved('dirty');
  };
  const setProfile = <K extends keyof LlmProfile>(key: K, value: LlmProfile[K]) =>
    update((s) => ({ ...s, profiles: { ...s.profiles, [tab]: { ...profileOf(s, tab), [key]: value } } }));

  /** Новый профиль: копия текущего или заготовка провайдера; сразу открывается на вкладке. */
  const addProfile = (template: string) => {
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const current = profileOf(settings, tab);
    const info = template === 'copy' ? null : PROVIDERS[template as ProviderId];
    const fresh: LlmProfile = info
      ? { ...DEFAULT_SETTINGS.profiles.fast!, label: `Новый (${info.id})`, provider: info.id, baseUrl: info.baseUrl, model: info.model, vision: info.cloud }
      : { ...current, label: `${current.label} (копия)` };
    update((s) => ({ ...s, profileIds: [...s.profileIds, id], profiles: { ...s.profiles, [id]: fresh } }));
    setTab(id);
  };

  /** Удаляет профиль вместе со ссылками на него (активный, цепочка автосмены); последний не удаляется. */
  const removeProfile = (id: ProfileId) => {
    if (settings.profileIds.length <= 1) return;
    const ids = settings.profileIds.filter((x) => x !== id);
    const { [id]: _gone, ...rest } = settings.profiles;
    update((s) => ({
      ...s,
      profileIds: ids,
      profiles: rest,
      activeProfile: s.activeProfile === id ? ids[0]! : s.activeProfile,
      escalation: { ...s.escalation, chain: s.escalation.chain.filter((x) => x !== id) },
    }));
    if (tab === id) setTab(ids[0]!);
  };

  /**
   * Смена провайдера подставляет его адрес и модель, но только если поле осталось
   * значением прежнего провайдера — набранное руками не затирается.
   */
  const setProvider = (id: ProviderId) =>
    update((s) => {
      const p = profileOf(s, tab);
      const from = providerInfo(p.provider);
      const to = PROVIDERS[id];
      const swap = (value: string, a: string, b: string) => (value.trim() === '' || value.trim() === a ? b : value);
      return {
        ...s,
        profiles: {
          ...s.profiles,
          [tab]: { ...p, provider: id, baseUrl: swap(p.baseUrl, from.baseUrl, to.baseUrl), model: swap(p.model, from.model, to.model) },
        },
      };
    });
  const setAgent = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) =>
    update((s) => ({ ...s, agent: { ...s.agent, [key]: value } }));
  const setSafety = <K extends keyof SafetySettings>(key: K, value: SafetySettings[K]) =>
    update((s) => ({ ...s, safety: { ...s.safety, [key]: value } }));
  const setNotify = <K extends keyof NotifySettings>(key: K, value: NotifySettings[K]) =>
    update((s) => ({ ...s, notify: { ...s.notify, [key]: value } }));
  const setRule = (key: keyof RiskRules, value: string) => setSafety('rules', { ...settings.safety.rules, [key]: value });
  const setNote = <K extends keyof Settings['siteNotes'][number]>(i: number, key: K, value: Settings['siteNotes'][number][K]) =>
    update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, [key]: value } : n)) }));

  const extraBodyError = settings.profileIds
    .map((id) => {
      const p = profileOf(settings, id);
      try {
        parseExtraBody(p.extraBody);
        return null;
      } catch (err) {
        return `${p.label}: ${err instanceof Error ? err.message : String(err)}`;
      }
    })
    .find(Boolean);

  const onSave = async () => {
    if (extraBodyError) return;
    const fixed: Settings = {
      ...settings,
      profiles: Object.fromEntries(
        settings.profileIds.map((id) => {
          const p = profileOf(settings, id);
          return [id, { ...p, baseUrl: normalizeBaseUrl(p.baseUrl) ?? p.baseUrl }];
        }),
      ),
    };
    setSettings(await saveSettings(fixed));
    setSaved('saved');
  };

  const profile = profileOf(settings, tab);
  const provider = providerInfo(profile.provider);
  const normalized = normalizeBaseUrl(profile.baseUrl);
  const remote = provider.cloud || (normalized !== null && !isLocalHost(normalized));

  return (
    <main>
      <h1>Настройки агента</h1>

      <section class="card">
        <h2>LLM-профили</h2>
        <div class="tabs" role="tablist">
          {settings.profileIds.map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {profileOf(settings, id).label}
              {settings.activeProfile === id ? ' • активный' : ''}
            </button>
          ))}
          <select
            aria-label="Добавить профиль"
            value=""
            onChange={(e) => {
              if (e.currentTarget.value) addProfile(e.currentTarget.value);
              e.currentTarget.value = '';
            }}
          >
            <option value="">+ Добавить профиль…</option>
            <option value="copy">Копия текущего</option>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                Новый: {PROVIDERS[id].label.split(' (')[0]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={settings.profileIds.length <= 1}
            title={settings.profileIds.length <= 1 ? 'Последний профиль удалить нельзя' : 'Удалить этот профиль'}
            onClick={() => removeProfile(tab)}
          >
            Удалить профиль
          </button>
        </div>

        <div class="grid">
          <label class="field">
            <span>Провайдер</span>
            <select value={profile.provider} onChange={(e) => setProvider(e.currentTarget.value as ProviderId)}>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Адрес сервера (можно вместе с /v1)"
            type="url"
            value={profile.baseUrl}
            placeholder={provider.baseUrl}
            onChange={(v) => setProfile('baseUrl', v)}
          />
          <TextField
            label="Модель"
            value={profile.model}
            list="models"
            placeholder={provider.model}
            onChange={(v) => setProfile('model', v)}
          />
          <TextField
            label={provider.keyRequired ? 'API-ключ (обязателен)' : 'API-ключ (необязательно)'}
            type="password"
            value={profile.apiKey}
            onChange={(v) => setProfile('apiKey', v)}
          />
          <TextField label="Название профиля" value={profile.label} onChange={(v) => setProfile('label', v)} />
          <NumberField label="Температура" value={profile.temperature} min={0} max={2} step={0.05} onChange={(v) => setProfile('temperature', v)} />
          <NumberField label="Бюджет контекста, токенов" value={profile.contextTokens} min={1024} step={1024} onChange={(v) => setProfile('contextTokens', v)} />
          <NumberField label="Макс. токенов ответа" value={profile.maxOutputTokens} min={64} step={256} onChange={(v) => setProfile('maxOutputTokens', v)} />
          <NumberField label="Таймаут запроса, сек" value={profile.requestTimeoutSec} min={5} onChange={(v) => setProfile('requestTimeoutSec', v)} />
          <label class="field">
            <span>Structured output</span>
            <select
              value={profile.structuredOutput}
              onChange={(e) => setProfile('structuredOutput', e.currentTarget.value as StructuredOutputMode)}
            >
              {(Object.keys(STRUCTURED_LABELS) as StructuredOutputMode[]).map((m) => (
                <option key={m} value={m}>
                  {STRUCTURED_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {remote && (
          <div class="warn">
            Внешний сервер: текст каждой страницы, по которой ходит агент, уходит на{' '}
            {normalizeBaseUrl(profile.baseUrl)?.replace(/^https?:\/\//, '') ?? provider.baseUrl}. Для личных кабинетов лучше держать модель в своей сети.
            {provider.hint ? ` ${provider.hint}` : ''}
            {provider.keyUrl && (
              <>
                {' '}
                <a href={provider.keyUrl} target="_blank" rel="noreferrer">
                  Получить ключ
                </a>
              </>
            )}
          </div>
        )}

        {!remote && provider.hint && <p class="muted" style={{ margin: 0 }}>{provider.hint}</p>}

        <label class="field">
          <span>Доп. параметры запроса (JSON-объект, вмешивается в тело /chat/completions)</span>
          <textarea
            class="mono"
            rows={2}
            spellcheck={false}
            value={profile.extraBody}
            placeholder='{"top_k": 20, "min_p": 0}'
            onInput={(e) => setProfile('extraBody', e.currentTarget.value)}
          />
        </label>

        <div class="row" style={{ gap: '16px' }}>
          <CheckField
            label="Рассуждения (thinking)"
            hint={
              provider.id === 'google'
                ? 'Выключено: reasoning_effort=none. У Gemini Pro и 3.x рассуждения не отключаются — оставьте включённым.'
                : 'Выключено: chat_template_kwargs.enable_thinking=false и think=false. gpt-oss рассуждения не отключает.'
            }
            checked={profile.thinking}
            onChange={(v) => setProfile('thinking', v)}
          />
          <CheckField
            label="Модель видит картинки"
            hint="Gemini, Qwen2.5-VL, Gemma 3, llava и т.п. Тогда агент может прикладывать скриншот с номерами элементов (см. «Скриншоты» в разделе «Агент»). У llama-server нужен --mmproj"
            checked={profile.vision}
            onChange={(v) => setProfile('vision', v)}
          />
          <CheckField
            label="Использовать этот профиль по умолчанию"
            checked={settings.activeProfile === tab}
            onChange={(v) => v && update((s) => ({ ...s, activeProfile: tab }))}
          />
        </div>

        <ConnectionTester key={tab} profile={profile} />
      </section>

      <EscalationCard settings={settings} update={update} />

      <section class="card">
        <h2>Агент</h2>
        <div class="grid">
          <NumberField label="Лимит шагов" value={settings.agent.maxSteps} min={1} onChange={(v) => setAgent('maxSteps', v)} />
          <NumberField
            label="Действий за шаг (макс.)"
            value={settings.agent.maxActionsPerStep}
            min={1}
            max={10}
            onChange={(v) => setAgent('maxActionsPerStep', v)}
          />
          <NumberField label="Таймаут шага (без LLM), сек" value={settings.agent.stepTimeoutSec} min={5} onChange={(v) => setAgent('stepTimeoutSec', v)} />
          <NumberField label="Порог зацикливания (повторов)" value={settings.agent.loopThreshold} min={2} onChange={(v) => setAgent('loopThreshold', v)} />
          <NumberField
            label="Застрял — прокрутить вниз после шагов без пользы (0 — выкл)"
            value={settings.agent.autoScrollAfter}
            min={0}
            max={20}
            onChange={(v) => setAgent('autoScrollAfter', v)}
          />
          <NumberField
            label="«Пролистать курс»: шагов нейросети на одну заминку"
            value={settings.agent.skipAgentSteps}
            min={3}
            max={200}
            onChange={(v) => setAgent('skipAgentSteps', v)}
          />
          <NumberField label="Пауза между буквами при вводе по буквам, мс" value={settings.agent.typeDelayMs} min={0} max={1000} onChange={(v) => setAgent('typeDelayMs', v)} />
          <label class="field">
            <span>Скриншоты с номерами элементов (если модель видит картинки)</span>
            <select value={settings.agent.screenshots} onChange={(e) => setAgent('screenshots', e.currentTarget.value as AgentSettings['screenshots'])}>
              <option value="off">никогда</option>
              <option value="stuck">когда агент застрял (шаг не удался или ничего не изменил)</option>
              <option value="always">на каждом шаге</option>
            </select>
          </label>
          <label>Объём наблюдения
            <select value={settings.agent.observationMode ?? 'standard'} onChange={(e) => setAgent('observationMode', e.currentTarget.value as AgentSettings['observationMode'])}>
              <option value="minimal">Минимальный</option>
              <option value="standard">Стандартный</option>
              <option value="detailed">Подробный</option>
              <option value="adaptive">Адаптивный (экспериментальный)</option>
            </select>
          </label>
          <NumberField
            label="Лимит наблюдения, символов"
            value={settings.agent.maxObservationChars}
            min={1000}
            step={1000}
            onChange={(v) => setAgent('maxObservationChars', v)}
          />
        </div>
        <div class="row" style={{ gap: '16px' }}>
          <CheckField
            label="Читать каждую страницу целиком"
            hint="Перед выбором действия страница медленно листается до конца, как у человека: лёгкий текст 10–20 с на 1000 символов, код и селекторы 60–90 с, со случайными остановками. Нужен отладчик. Каждый адрес читается один раз за запуск"
            checked={settings.agent.autoRead}
            onChange={(v) => setAgent('autoRead', v)}
          />
          <NumberField
            label="Автосброс контекста при заполнении, % (0 — выкл)"
            value={settings.agent.contextResetPercent}
            min={0}
            max={99}
            onChange={(v) => setAgent('contextResetPercent', v)}
          />
          <NumberField label="Макс. чтение одной страницы, мин" value={settings.agent.autoReadMaxMin} min={1} onChange={(v) => setAgent('autoReadMaxMin', v)} />
        </div>
        <div class="row" style={{ gap: '16px' }}>
          <CheckField
            label="Подтверждать каждый шаг (отладка)"
            hint="Ждать «Выполнить» и перед безопасными кликами, вводом и переходами. Рискованные действия подтверждаются всегда. В автономном режиме не действует"
            checked={settings.agent.approveEachStep}
            onChange={(v) => setAgent('approveEachStep', v)}
          />
          <CheckField
            label="Автономный режим"
            hint="Ночью: рискованное ждёт подтверждения (со звуком), затем уходит в очередь на утро; на ask_user модель решает сама; после перезапуска браузера задача продолжается сама"
            checked={settings.agent.autonomous}
            onChange={(v) => setAgent('autonomous', v)}
          />
          <CheckField label="Клики через chrome.debugger (CDP)" checked={settings.agent.useDebugger} onChange={(v) => setAgent('useDebugger', v)} />
          <CheckField label="Визуальный курсор" checked={settings.agent.showCursor} onChange={(v) => setAgent('showCursor', v)} />
          <CheckField
            label="Вводить текст по буквам"
            hint="Каждый символ — отдельное нажатие клавиши (keydown/input/keyup), а не вставка строки. Нужно полям с подсказками, масками и проверкой на каждую букву. Только с CDP; в редакторы кода текст всё равно вставляется целиком"
            checked={settings.agent.typeByKeys}
            onChange={(v) => setAgent('typeByKeys', v)}
          />
          <CheckField label="Debug-подсветка элементов" checked={settings.agent.debugOverlay} onChange={(v) => setAgent('debugOverlay', v)} />
        </div>
      </section>

      <section class="card">
        <h2>Безопасность</h2>
        <p class="muted" style={{ margin: 0 }}>
          Рискованным действие считает расширение, а не модель: по тексту кнопки, адресу страницы и типу поля (пароль, карта, Enter в поле сообщения).
          Слово совпадает по началу слова: «оплат» поймает «Оплатить» и «Перейти к оплате». По одному на строку.
        </p>
        <div class="grid">
          {RULE_FIELDS.map(({ key, label }) => (
            <label key={key} class="field">
              <span>{label}</span>
              <textarea rows={4} spellcheck={false} value={settings.safety.rules[key]} onInput={(e) => setRule(key, e.currentTarget.value)} />
            </label>
          ))}
        </div>
        <div class="row" style={{ gap: '16px', alignItems: 'flex-end' }}>
          <NumberField
            label="Автономно: ждать подтверждения, сек (0 — сразу в очередь)"
            value={settings.safety.approvalWindowSec}
            min={0}
            max={3600}
            onChange={(v) => setSafety('approvalWindowSec', v)}
          />
          <CheckField
            label="Звуковой сигнал"
            hint="Когда в автономном режиме агент упирается в рискованное действие. Системное уведомление показывается всегда"
            checked={settings.safety.sound}
            onChange={(v) => setSafety('sound', v)}
          />
          <AlertTester />
          <button onClick={() => setSafety('rules', DEFAULT_RISK_RULES)}>Словари по умолчанию</button>
        </div>
      </section>

      <section class="card">
        <h2>Заметки для сайтов</h2>
        <p class="muted" style={{ margin: 0 }}>
          Подсказки модели о том, как устроен сайт. Попадают в промпт, когда агент на подходящей странице. Шаблон — домен (с поддоменами) и, при желании, начало пути: <span class="mono">practicum.yandex.ru/learn</span>.
        </p>
        {settings.siteNotes.map((note, i) => (
          <div key={i} class="site-note">
            <div class="row">
              <input
                type="text"
                class="mono"
                value={note.pattern}
                placeholder="practicum.yandex.ru"
                spellcheck={false}
                onInput={(e) => {
                  const pattern = e.currentTarget.value;
                  update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, pattern } : n)) }));
                }}
              />
              <button onClick={() => update((s) => ({ ...s, siteNotes: s.siteNotes.filter((_, j) => j !== i) }))}>Удалить</button>
            </div>
            <textarea
              rows={4}
              value={note.notes}
              placeholder={'- «Узнать ответ» = проверить выбранный ответ. Сначала выбери вариант, потом нажми.\n- 👍/👎 «Оценить» у «Как вам задача?» — отзыв, не нажимать.'}
              onInput={(e) => {
                const notes = e.currentTarget.value;
                update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, notes } : n)) }));
              }}
            />
            <label class="field">
              <span>
                Скрыть от модели — по одному на строку: текст кнопки или <span class="mono">css: селектор</span> для иконок. Модель не увидит ни элемент, ни его текст. Проще всего
                добавлять кнопкой «Скрыть элемент…» в панели.
              </span>
              <textarea
                rows={2}
                value={note.hide}
                placeholder={'Оценить\ncss: button[aria-label="Избранное"]'}
                onInput={(e) => {
                  const hide = e.currentTarget.value;
                  update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, hide } : n)) }));
                }}
              />
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={!!parseHideRules(note.hide.split('\n')).icons}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  const rest = note.hide.split('\n').filter((l) => !/^@(иконки|icons)$/i.test(l.trim()));
                  const hide = (on ? [ICONS_RULE, ...rest] : rest).join('\n').replace(/^\n+|\n+$/g, '');
                  update((s) => ({ ...s, siteNotes: s.siteNotes.map((n, j) => (j === i ? { ...n, hide } : n)) }));
                }}
              />
              <span>
                Скрыть иконки без подписи на приклеенных панелях и в тренажёрах (чат, тема, «избранное», боковое меню) — их не увидят ни модель, ни «Пролистать курс».
                В списке выше это строка <span class="mono">{ICONS_RULE}</span>.
              </span>
            </label>
            <div class="grid">
              <label class="field">
                <span>Рискованные действия на этом сайте</span>
                <select value={note.risk} onChange={(e) => setNote(i, 'risk', e.currentTarget.value as SiteRiskMode)}>
                  {(Object.keys(RISK_MODE_LABELS) as SiteRiskMode[]).map((m) => (
                    <option key={m} value={m}>
                      {RISK_MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>Кнопка «Далее» — css: селектор или текст (модель увидит её с пометкой ← NEXT). Проще отметить кнопкой «Это кнопка „Далее“…» в панели</span>
                <textarea rows={2} class="mono" value={note.next} placeholder="css: button.lesson-next" onInput={(e) => setNote(i, 'next', e.currentTarget.value)} />
              </label>
              <label class="field">
                <span>Не спрашивать подтверждения для — тексты кнопок, по одному на строку (пароли всё равно спрашиваются)</span>
                <textarea rows={2} value={note.safe} placeholder="Отправить ответ" onInput={(e) => setNote(i, 'safe', e.currentTarget.value)} />
              </label>
            </div>
          </div>
        ))}
        <div class="row">
          <button onClick={() => update((s) => ({ ...s, siteNotes: [...s.siteNotes, { pattern: '', notes: '', hide: '', risk: 'ask', safe: '', next: '' }] }))}>Добавить сайт</button>
        </div>
      </section>

      <section class="card">
        <h2>Уведомления в Telegram</h2>
        <p class="muted" style={{ margin: 0 }}>
          Запросы подтверждения приходят с кнопками «Выполнить / Отклонить», на вопросы агента можно ответить реплаем — ночью не надо подходить к компьютеру.
          Бота создайте у <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> (/newbot), вставьте токен, напишите своему боту
          любое сообщение и нажмите «Найти chat id». Ответы принимаются только из этого чата.
        </p>
        <div class="grid">
          <TextField label="Токен бота" type="password" value={settings.notify.botToken} placeholder="123456:ABC-DEF…" onChange={(v) => setNotify('botToken', v)} />
          <TextField label="Chat id" value={settings.notify.chatId} placeholder="123456789" onChange={(v) => setNotify('chatId', v)} />
        </div>
        <div class="row" style={{ gap: '16px' }}>
          <CheckField label="Включить" checked={settings.notify.telegram} onChange={(v) => setNotify('telegram', v)} />
          <CheckField label="Сообщать итог задачи" checked={settings.notify.onFinish} onChange={(v) => setNotify('onFinish', v)} />
          <TelegramTester botToken={settings.notify.botToken} chatId={settings.notify.chatId} onChatId={(id) => setNotify('chatId', id)} />
        </div>
      </section>

      <section class="card">
        <h2>Логирование</h2>
        <CheckField
          label="Отправлять лог шагов POST-запросом"
          checked={settings.logging.remoteEnabled}
          onChange={(v) => update((s) => ({ ...s, logging: { ...s.logging, remoteEnabled: v } }))}
        />
        <TextField
          label="URL для логов"
          type="url"
          value={settings.logging.remoteUrl}
          placeholder="http://192.168.1.10:8080/agent-log"
          onChange={(v) => update((s) => ({ ...s, logging: { ...s.logging, remoteUrl: v } }))}
        />
      </section>

      <div class="save-bar row">
        <button class="primary" onClick={() => void onSave()} disabled={saved !== 'dirty' || !!extraBodyError}>
          Сохранить
        </button>
        <button
          onClick={() => {
            if (confirm('Сбросить все настройки к значениям по умолчанию?')) {
              setSettings(DEFAULT_SETTINGS);
              setSaved('dirty');
            }
          }}
        >
          Сбросить
        </button>
        <span class={extraBodyError ? 'err' : saved === 'dirty' ? 'warn' : 'muted'}>
          {extraBodyError ?? (saved === 'dirty' ? 'Есть несохранённые изменения' : saved === 'saved' ? 'Сохранено' : '')}
        </span>
      </div>
    </main>
  );
}

/** «Найти chat id» и тестовое сообщение — по настройкам на экране, ещё до сохранения. */
function TelegramTester({ botToken, chatId, onChatId }: { botToken: string; chatId: string; onChatId: (id: string) => void }) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; text?: string }>({ kind: 'idle' });
  const run = async (p: ReturnType<typeof sendToBackground>, ok: (v: unknown) => string) => {
    setState({ kind: 'busy' });
    const res = await p;
    setState(res.ok ? { kind: 'ok', text: ok(res.value) } : { kind: 'err', text: res.error });
  };
  return (
    <>
      <button
        disabled={!botToken || state.kind === 'busy'}
        onClick={() =>
          void run(sendToBackground({ type: 'bg:telegram-chat-id', botToken }), (id) => {
            onChatId(String(id));
            return `Найден chat id ${String(id)} — не забудьте сохранить`;
          })
        }
      >
        Найти chat id
      </button>
      <button disabled={!botToken || !chatId || state.kind === 'busy'} onClick={() => void run(sendToBackground({ type: 'bg:telegram-test', config: { botToken, chatId } }), () => 'Сообщение отправлено')}>
        Отправить тест
      </button>
      {state.text && <span class={state.kind === 'err' ? 'err' : 'ok'}>{state.text}</span>}
    </>
  );
}

/** Проверка звука и уведомления — сохранённые настройки (звук вкл/выкл) берутся из background. */
function AlertTester() {
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  const onClick = async () => {
    setState('busy');
    const res = await sendToBackground({ type: 'bg:alert-test' });
    setState(res.ok ? 'idle' : res.error);
  };
  return (
    <>
      <button onClick={() => void onClick()} disabled={state === 'busy'}>
        Проверить сигнал
      </button>
      {state !== 'idle' && state !== 'busy' && <span class="err">{state}</span>}
    </>
  );
}

function ConnectionTester({ profile }: { profile: LlmProfile }) {
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [streamText, setStreamText] = useState('');
  const [reasoningChars, setReasoningChars] = useState(0);
  const [probing, setProbing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const onCheck = async () => {
    setChecking(true);
    setReport(await checkConnection(profile));
    setChecking(false);
  };

  const onProbe = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProbe(null);
    setStreamText('');
    setReasoningChars(0);
    setProbing(true);
    const res = await probeGeneration(profile, {
      signal: ctrl.signal,
      onDelta: ({ content, reasoning }) => {
        if (content) setStreamText((t) => t + content);
        if (reasoning) setReasoningChars((n) => n + reasoning.length);
      },
    });
    abortRef.current = null;
    setProbing(false);
    setProbe(res);
  };

  return (
    <div class="card report" style={{ background: 'var(--bg)' }}>
      <div class="row">
        <button onClick={() => void onCheck()} disabled={checking}>
          {checking ? 'Проверяю…' : 'Проверить соединение'}
        </button>
        {probing ? (
          <button onClick={() => abortRef.current?.abort()}>Остановить генерацию</button>
        ) : (
          <button onClick={() => void onProbe()}>Пробная генерация</button>
        )}
      </div>

      {report && (
        <div>
          {report.ok ? (
            <div class="ok">
              Соединение есть: {report.endpoint ?? report.baseUrl}, {report.latencyMs} мс, моделей: {report.models.length}
            </div>
          ) : (
            <div class="err">{report.error}</div>
          )}
          {report.ok && (
            <div class="muted">
              Сервер: {report.server.kind}
              {report.server.version ? ` ${report.server.version}` : ''}
              {report.server.contextTokens ? `, контекст ${report.server.contextTokens}` : ''}
              {report.resolvedModel ? `, модель ${report.resolvedModel}` : ''}
            </div>
          )}
          {report.warnings.length > 0 && (
            <ul class="warn">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <datalist id="models">
            {report.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      )}

      {(probing || probe) && (
        <div style={{ marginTop: '8px' }}>
          {probing && <div class="muted">Генерация… рассуждений: {reasoningChars} симв.</div>}
          {probe &&
            (probe.ok ? (
              <div class="ok">
                Первый токен через {probe.ttftMs} мс, всего {probe.totalMs} мс
                {probe.reasoningChars > 0 ? `, рассуждений ${probe.reasoningChars} симв.` : ''}
              </div>
            ) : (
              <div class="err">{probe.error}</div>
            ))}
          {streamText && <pre class="output mono">{streamText}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * Автосмена моделей: базовая — активный профиль; когда она не справляется, шаги идут на следующей
 * из цепочки, а потом возвращаются. Внешние (облачные) профили включаются отдельным разрешением.
 */
function EscalationCard({ settings, update }: { settings: Settings; update: (fn: (s: Settings) => Settings) => void }) {
  const e = settings.escalation;
  const set = <K extends keyof Settings['escalation']>(key: K, value: Settings['escalation'][K]) => update((s) => ({ ...s, escalation: { ...s.escalation, [key]: value } }));
  const label = (id: ProfileId) => `${profileOf(settings, id).label} — ${profileOf(settings, id).model}`;
  const free = settings.profileIds.filter((id) => id !== settings.activeProfile && !e.chain.includes(id));
  const move = (i: number, d: -1 | 1) => {
    const next = [...e.chain];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    set('chain', next);
  };
  const external = e.chain.filter((id) => isExternalProfile(profileOf(settings, id)));
  return (
    <section class="card">
      <h2>Автосмена моделей</h2>
      <p class="muted" style={{ margin: 0 }}>
        Базовая модель — активный профиль. Если она не справляется (несколько неудачных шагов подряд, зацикливание, застревание, негодные ответы), шаги идут на следующей
        модели из цепочки, а когда трудность позади — снова на базовой.
      </p>
      <CheckField label="Включить автосмену моделей" checked={e.enabled} onChange={(v) => set('enabled', v)} />
      {e.enabled && (
        <>
          <div class="muted">Базовая: {label(settings.activeProfile)}</div>
          {e.chain.map((id, i) => (
            <div key={id} class="row" style={{ gap: '8px', alignItems: 'center' }}>
              <span>{i + 1}.</span>
              <span style={{ flex: 1 }}>
                {label(id)}
                {isExternalProfile(profileOf(settings, id)) ? ' ☁ внешняя' : ''}
                {id === settings.activeProfile ? ' (это базовая — будет пропущена)' : ''}
              </span>
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Выше">
                ↑
              </button>
              <button type="button" disabled={i === e.chain.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">
                ↓
              </button>
              <button type="button" onClick={() => set('chain', e.chain.filter((x) => x !== id))} aria-label="Убрать">
                ✕
              </button>
            </div>
          ))}
          <select
            aria-label="Добавить модель в цепочку"
            value=""
            disabled={free.length === 0}
            onChange={(ev) => {
              if (ev.currentTarget.value) set('chain', [...e.chain, ev.currentTarget.value]);
              ev.currentTarget.value = '';
            }}
          >
            <option value="">+ Добавить модель в цепочку…</option>
            {free.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </select>
          <div class="grid">
            <NumberField label="Неудачных шагов подряд до смены" value={e.failStreak} min={1} max={10} onChange={(v) => set('failStreak', v)} />
            <NumberField label="Удачных шагов подряд до возврата на базовую" value={e.returnAfter} min={1} max={50} onChange={(v) => set('returnAfter', v)} />
          </div>
          <CheckField
            label="Разрешить внешние (облачные) модели в цепочке"
            hint="Тогда на сложных шагах текст страницы уходит за пределы вашей сети. Без этой галочки внешние профили в цепочке пропускаются. При переходе на внешнюю модель придёт уведомление."
            checked={e.allowExternal}
            onChange={(v) => set('allowExternal', v)}
          />
          {external.length > 0 && !e.allowExternal && <div class="warn">В цепочке есть внешние модели ({external.map((id) => profileOf(settings, id).label).join(', ')}) — они не будут использоваться, пока не включено разрешение.</div>}
          {e.allowExternal && external.length > 0 && <div class="warn">Внешние модели в цепочке: текст страниц, на которых базовая модель застряла, уйдёт на их серверы.</div>}
        </>
      )}
    </section>
  );
}
