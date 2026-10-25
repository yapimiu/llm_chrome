# Карта проекта llm_chrome

Актуальное состояние: коммит `fff2724` (оптимизации A–I). План продолжения и ограничения: [CONTINUATION.md](CONTINUATION.md). Измерения: [token-optimization.md](token-optimization.md). Исторический `CLAUDE.md` ошибочно описывает основной журнал как chrome.storage и loop.ts как оркестратор: журнал находится в IndexedDB, оркестратор — runner.ts; loop.ts обнаруживает циклы. Источник истины для контрактов — TypeScript, а не исторические описания агентов в `.claude/agents/`.

## Назначение и точки входа

Расширение Chrome Manifest V3 на TypeScript, WXT и Preact. Модель управляет реальной вкладкой; доступны локальные и облачные OpenAI-совместимые API и Google Gemini. OpenRouter сейчас используется через общий OpenAI-совместимый профиль, отдельного OpenRouter-адаптера нет.

| Область | Файлы и ответственность |
| --- | --- |
| Сборка и разрешения | `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`. Manifest задаёт `<all_urls>`, storage, sidePanel, scripting, debugger, offscreen, notifications. |
| Фоновая оркестрация | `src/entrypoints/background.ts`: сообщения UI, запуск/восстановление агента, зависимости runner, наблюдение и исполнение, журнал, сценарии, очередь, уведомления. |
| Скрипт страницы | `src/entrypoints/content.ts`: сбор DOM, реестр элементов по snapshotId, обработчики действий, подсветка и наблюдение изменений. |
| Панель | `src/entrypoints/sidepanel/App.tsx`, `AgentPanel.tsx`, `StepCard.tsx`, `Perception.tsx`, `RunLog.tsx`, `Macros.tsx`, `Queue.tsx`, `SkipPanel.tsx`. |
| Настройки | `src/entrypoints/options/App.tsx`, `src/lib/settings.ts`: UI, defaults, sanitize/migration, профили, режимы наблюдения, политика внешних моделей. |
| Контракты сообщений | `src/lib/messages.ts`: запросы background/content, ответы и UI events. При изменении маршрута обновлять обе стороны. |
| Звуки/уведомления | `src/lib/alert.ts`, `alert-messages.ts`, `notify/*`, `src/entrypoints/offscreen/*`. Telegram — отдельный явно настроенный канал. |

## Цикл браузерного агента

1. `AgentRunner` в `src/lib/agent/runner.ts` ведёт RunState, остановку, паузы, вопросы, подтверждения, лимит шагов и восстановление. Перед шагом формирует историю и сводку.
2. `runStep` в `step.ts` вызывает свежий observe. Background передаёт работу в `src/lib/perception.ts`; content script собирает снимки. Наблюдение возвращает текст, вкладки, при необходимости изображение и **актуальный ObservationHandle**.
3. `observation-mode.ts` выбирает Standard/Minimal/Detailed/Adaptive. При неполном или сменившем URL Adaptive Minimal до LLM переснимается Standard. Используется последний handle. Неизвестная полнота не разрешает автоматический Minimal.
4. `prompt.ts` строит system/user сообщения, случайные PAGE-маркеры и нейтрализует поддельные маркеры в данных страницы. `src/prompts/system.md` содержит правила и действия; динамические markers/action limit находятся в конце.
5. `history.ts` сохраняет факты, ограничения, отложенные действия и ограниченную историю. `context.ts` оценивает контекст; `step.ts` может заменить историю сводкой и переснять страницу короче. Оценки локальные, с калибровкой по reported prompt usage.
6. `src/lib/llm/client.ts` отправляет streaming chat completions. Цепочка: structured-format fallback → transient retry → optional-field lean retry → fetch/SSE. Рабочий формат и lean-серверы запоминаются. `sse.ts`, `url.ts`, `providers.ts`, `connection.ts` отвечают за поток, адреса, провайдеров и проверку подключения.
7. `parse.ts` локально убирает thinking, нормализует и ремонтирует JSON. При неудаче `step.ts` повторяет запрос с базой и только последним ограниченным invalid excerpt/correction. `actions.ts` определяет действия и JSON Schema.
8. Runner применяет `loop.ts`, `stuck.ts`, `risk.ts`, site policy и подтверждения. Модельный `risky` только добавляет необходимость подтверждения. Действия исполняются по текущим snapshot/index; после навигации старые цели не используются как прежние.
9. `src/lib/tab-actions.ts`, `dom/act.ts`, `exec/cdp.ts`, `exec/debugger.ts` выполняют операции вкладок/DOM/CDP. `dom/reading.ts`, `stable.ts`, `cursor.ts` обеспечивают чтение, ожидания и движение курсора.
10. Runner сохраняет шаг/запуск и чекпоинты; `escalation.ts` определяет переход к более сильной модели и возврат. Сервисная ошибка отличается от плохого ответа модели.

## DOM и восприятие

| Файл | Что искать |
| --- | --- |
| `src/lib/dom/types.ts` | ElementInfo, PageSnapshot, CollectStats, flags, зоны видимости. |
| `dom/collect.ts` | Сбор интерактивных элементов/текста, shadow DOM, доступные iframe, маскирование секретов, hide rules, реестр целей; metadata о лимитах обхода/текста. |
| `dom/serialize.ts` | Бюджет символов, секции visible/above/below, precision имени/атрибутов, shownIndices. Невместившийся элемент пропускается, поиск следующих продолжается. |
| `src/lib/frames.ts`, `perception.ts` | Дерево и объединение фреймов, глобальные номера и owner/frame/snapshot, показ подсветки, консервативная single-frame completeness. |
| `dom/geometry.ts`, `paint.ts`, `stable.ts` | Геометрия/отрисовка/ожидание анимаций. |
| `dom/hide-rules.ts`, `picker.ts`, `diagnose.ts`, `overlay.ts` | Скрытие, выбор элемента, диагностика, рамки. |
| `src/lib/screenshot.ts` | Захват изображения; политика screenshots задаётся настройками и runner. |

Полнота означает полноту представления, которое умеет собирать collector, а не всего содержимого сайта. Multi-frame и неизвестные metadata консервативно не дают auto-Minimal. Текстовый бюджет не должен менять risk flags или фильтровать цели по предполагаемой безопасности.

## Сценарии, память и хранение

- `agent/macro.ts`: macroFromRun, поиск подходящей цели, rebind, Replayer, передача задачи обратно LLM. Replay делает новый observe и assess перед каждым шагом; секреты требуют отдельного ввода. `macro-store.ts` хранит сценарии в extension storage.
- `agent/skipper.ts`, `course.ts`: существующее локальное пролистывание/чтение и подключение агента на заминках. Нового автоматического подбора и запуска сценариев A–I не добавляли.
- `agent/site-notes.ts`: пользовательские заметки/правила сайта. `history.ts`: рабочая память; extract дедуплицируется полностью. Защищённые ограничения могут превысить мягкий бюджет с явной пометкой.
- `agent/types.ts`: RunState, StepRecord, StepDetail, RunSummary и очередь. `log/db.ts`: IndexedDB `agent-log`, stores runs/steps/details/queue, load/save/export/prune.
- `settings.ts`: `local:settings`, включая ключи API; `checkpoint.ts`: `local:activeRun`, указатель/конфигурация восстановления. Основной RunState со шагами — в IndexedDB. `agent/queue.ts` задаёт формат продолжения отложенной задачи.
- `llm/usage.ts`: HttpAttempt/StepUsage, summarizeRunUsage, exportUsage, форматтер UI. `bg:run-usage-export` загружает light run и использует отдельный allowlist. Кнопка «Токены» и раздел «Расход LLM» показывают эти данные.
- **Подробный журнал не обезличен:** StepDetail, старый JSON export и `log/remote.ts` могут включать наблюдения, task, ответы и ошибки. Не публиковать их как безопасную telemetry. Safe usage export не заменяет контроль доступа к этим данным.

## Инварианты безопасности

- PAGE STATE и screenshots — недоверенные данные. Не ослаблять разделение инструкций/страницы, random boundary и neutralizeMarkers ради кеширования.
- Номера действительны только в своём снимке/фрейме. Новое наблюдение требует нового handle; после reobserve нельзя исполнять старый.
- Risk assessment и site policy применяются независимо от уверенности модели. `risky: false` не отменяет детектирование риска.
- BLOCKED/POSTPONED, отказ пользователя и факты о невыполненных действиях не исчезают при компрессии как обычная успешная история.
- Replay тоже проверяет риск; не добавлять автоматические платежи/удаление/отправку/ввод секретов.
- Unknown usage/cost не равен нулю. Cached input — часть input; reasoning нельзя автоматически прибавлять к output как отдельный счёт.
- Не добавлять URL, ключи, raw prompts, страницу или error body в safe telemetry. Политика внешних профилей и screenshot policy сохраняются.

## Где менять типовую функцию

| Задача | Начать с | Обязательная проверка рядом |
| --- | --- | --- |
| Новое действие | `agent/actions.ts`, `parse.ts`, `system.md`, `dom/act.ts` / `tab-actions.ts`, `messages.ts` | schema/parser, risk, runner и content/executor; snapshot validity |
| Новый провайдер/usage | `llm/providers.ts`, `client.ts`, `usage.ts`, `settings.ts` | фактические supported fields, partial SSE, unknown/zero, отсутствие утечки |
| Новый параметр | `settings.ts` defaults/sanitize, options UI, RunConfig/background если нужен | migration, старые checkpoint/config |
| Меньше контекста | `serialize.ts`, `history.ts`, `prompt.ts`, `context.ts`, `observation-mode.ts` | protected facts, текущие индексы, caps, unknown completeness |
| Условия остановки/эскалации | `runner.ts`, `escalation.ts`, `loop.ts`, `stuck.ts` | transient errors отдельно от model errors, persist/restore |
| Учёт/экспорт | `usage.ts`, runner hooks, background handler, RunLog/AgentPanel | allowlist/privacy, legacy missing counters |
| Сохранённые сценарии | `macro.ts`, `macro-store.ts`, `Macros.tsx`, background | fresh observe/rebind/assess и подтверждение риска |

## Команды и тесты

Команды ниже взяты из `package.json`; перечисление не является разрешением устанавливать зависимости или запускать браузерные тесты без готовой среды.

| Команда | Назначение |
| --- | --- |
| `npm run compile` | `tsc --noEmit` |
| `npm test` / `npm run test:watch` | Vitest run / watch |
| `npm run build` / `npm run dev` | WXT build / dev; build в `dist/chrome-mv3` |
| `npm run zip` | WXT zip |
| `npm run e2e` | WXT build и `node e2e/run.mjs` |
| `npm run mock-llm` | `node e2e/server.mjs` |
| `npm run chrome:install` | Установка chrome@stable через @puppeteer/browsers в `.cache/chrome`; требует разрешения |
| `postinstall` | `wxt prepare`, запускается lifecycle установки |

`tests/*.test.ts` покрывают runner/step/context/history, prompt/schema/parser, client/SSE/usage/connection, DOM/frames/paint/actions, risk/queue/escalation, macros/skipper/course, настройки/сообщения/журнал. DOM-тесты используют jsdom/заданную геометрию; IndexedDB — fake-indexeddb. `token-baseline.test.ts` — синтетические measurement fixtures, не измерение billable usage. `e2e/run.mjs` и `e2e/server.mjs` — отдельный браузерный mock-LLM путь; успешные unit-тесты не заменяют E2E и реальных провайдеров.

E2E runner читает `CHROME_PATH` (путь к Chrome), `HEADLESS=1` (headless) и `PORT` (по умолчанию18080); mock server также использует `PORT`. Их наличие не доказывает готовность браузерной среды. Не обходить ограничения sandbox как готовое решение.
