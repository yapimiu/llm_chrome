# Продолжение работы: передача другой нейросети

Репозиторий: https://github.com/yapimiu/llm_chrome. Ветка передачи: `work` (не `main`).

Сначала прочитать [PROJECT_MAP.md](PROJECT_MAP.md), затем [token-optimization.md](token-optimization.md). Эта записка актуальна после коммита `fff2724` — `Optimize browser agent token usage and add safe usage telemetry`. Не начинать реализацию заново по старому HANDOFF.md: там сохранена историческая задача о подготовке агентов.

## Что уже сделано

A–I реализованы и проверены: исходный synthetic baseline; транспортная telemetry каждого HTTP attempt; safe usage export/UI; пропуск oversized DOM-строки с сохранением следующей цели; компактная история с защищёнными фактами/ограничениями; ограниченные parse-retry prompts; Standard/Minimal/Detailed/opt-in Adaptive с conservative completeness и свежими handles; длинный static system prefix без роста общей длины; регрессия существующего zero-LLM replay. Новой автоматической последовательности кликов не добавляли.

Проверка передачи **2026-10-25** (повторно выполнена Architect): `npm run compile` и `npm test` — 38 файлов, **639 тестов passed**; `npm run build` — ранее passed, `dist/chrome-mv3`; при документационной передаче build не повторялся. При новом аудите baseline compile/test также подтверждён. Это исторически выполненные проверки указанного состояния, не обещание их результата в новой среде. Для текущей документационной передачи исходники/тесты не менялись. Временные `/tmp`-логи другой сессии не являются переносимыми артефактами; воспроизводимые fixtures и результаты находятся в репозитории.

| Синтетический сценарий | До → после |
| --- | --- |
| DOM cap600: показано/пропущено | 0/2 → 1/1 |
| История здоровых шагов: локальная оценка input tokens | 606 → 79 |
| Два invalid replies: оценки input по вызовам | [67,659,1252] → [67,297,297]; сумма1978 → 661 |
| Тот же сценарий: calls / invalid / successful tasks | 3 / 2 / 1 из1 → без изменения |
| Нерелевантный JSON HTTP400: transport attempts | 3 → 1; задача не выполнена в обоих вариантах (0 из1) |
| Общий system template / static prefix, символы | 6750/804 → 6740/6649 |

HTTP400 «до» реконструирован по исходному classifier и трём форматам; «после» — mocked fetch. Остальные токены — локальные estimateTokens, а не provider billing. **Реальная стоимость успешной задачи неизвестна; живые cache hits и экономия не измерены.** Попытки подготовки/запуска не дали успешного E2E: загрузка Chrome вернула403, системный Chromium упёрся в sandbox, wrapper запустился без service worker расширения. При проверке передачи E2E не повторяли; live-provider тесты не проводились. Перед запуском в другой среде заново проверить готовность, не считать блокировку свойством самого кода.

## Расширенное задание пользователя и оставшиеся пробелы

Полный исходный текст сохранён в переносимом файле [OPTIMIZATION_TASK.md](OPTIMIZATION_TASK.md). Наличие исходного вложения проверено, но для продолжения оно больше не требуется. Указанные в исходном ТЗ модели Architect/Coder переопределены последующим разрешением пользователя на GPT-6.1-sol для Coder. Ниже — остаток работ, не повторная постановка уже выполненных A–I. Цель — минимальная стоимость успешно выполненной браузерной задачи при сохранении надёжности, безопасности и функций; сначала аудит и измерения, затем небольшие последовательные изменения с review.

- Расширить учёт: reasoning, cache-write, provider-reported cost, оценочная цена по явным тарифам, причины повторов и полный timing. Сейчас есть input/output/cached, transport ordinal/outcomes, parseErrors/parseRetries, counters/status, elapsedMs; cost всегда unknown.
- Проверить поддержку OpenRouter caching/cache-control/session affinity по актуальной документации. Сейчас отдельного OpenRouter adapter нет. Не посылать неподтверждённые API-параметры и не угадывать billing service по общему provider=openai.
- Task-aware DOM relevance/focus/forms/modal при необходимости; режимы уже есть. Не покупать дополнительный LLM-вызов для фильтрации, не терять цели/индексы/фреймы/risk metadata ради сокращения.
- Дальнейшее разделение рабочей памяти: недавнее/факты/подзадачи/ограничения/диагностика. Extract уже дедуплицируется, но сохраняется полностью: жёсткий лимит без сохранения фактов/запретов не вводить.
- Гибридное выполнение: оценить существующие локальные ожидания/MutationObserver/скрипты/выбранные моделью action chains перед новой автоматикой. После DOM/навигации проверять применимость и актуальность handles.
- Сценарии: предложение сохранить удачный запуск, повторяющиеся задачи, безопасный подбор перед LLM, проверка сайта/состояния, handoff при несовпадении. Автоматическое сохранение/исполнение только опционально; секреты не сохранять. Существующие Replayer/Skipper/Course не дублировать.
- Исследовать компактный JSON, optional reasoning/expected_outcome, адаптивные output/reasoning limits. Согласованно менять schema/parser/prompt/tests, не снижать retry/output бюджет без доказательства сохранения успеха.
- Escalation: JSON errors, прогресс/циклы, неоднозначность/сложные формы, изображение; временная сеть не означает слабую модель. Возврат к дешёвой модели уже есть. **MiMo не использовать.**
- Бюджет: лимит стоимости/платных вызовов, предупреждения у порога/дорогой модели, остановка платных запросов с сохранением состояния. Сейчас hard monetary/call budget отсутствует; maxSteps/context/timeout не заменяют его.
- Итоговые сравнения требуют actual usage, стоимости успешной задачи, error/success rates, восстановления, safety, dynamic pages/iframe и локальных/облачных провайдеров. Не объявлять живую экономию по synthetic estimates.

## Приоритетный следующий маленький этап — только спроектирован, не реализован

1. **Stage1a: расширенная measurement telemetry.** Optional reasoning/cache-write/reported cost/transport TTFT и enum reasons (initial/format fallback/lean/transient); chat-level parse/context retry отдельно. Сверить documented response paths и валюту провайдера до реализации. Missing/legacy/malformed остаются unknown; partial/cumulative SSE merge без double count. Проверить, что legacy ChatResult.usage не теряет promptTokens при output-only usage chunk.
2. **Stage1b: явные optional тарифы.** Привязать scope/model/currency и rates к фактической модели, snapshot тарифов на момент запроса. Нет defaults0, тарифных догадок и скрытого пересчёта старых задач. Reported cost отдельно от estimate; reasoning обычно subset output, cache subset input, cache-write semantics требуют подтверждения. Partial subtotal не называть полной ценой.
3. **Stage1c: сводка/export/UI и тесты.** Per-field unknown coverage, mixed models/currencies/rates, partial abort, retry reasons, zero vs unknown, privacy, legacy migration. Отдельный review после каждой части; compile/full unit suite после изменения кода.
4. Затем **budget gate до каждого фактического fetch**, включая transport retries: текущий onAttempt приходит после запроса и сам по себе не может обеспечить hard limit. Отдельно определить paid/local classification, unknown-cost policy, checkpoint/resume и предупреждения. Не смешивать это с measurement-патчем.

План Stage1 передан Architect для согласования; production/tests по нему ещё не изменялись. Следующий агент сначала сверяет текущее состояние и объём задачи, а не считает этот список разрешением на весь рефакторинг.

## Организация и ограничения

Architect задаёт архитектуру, небольшие задачи и проверяет diff/результат; Coder — единственный автор production-кода/тестов. В этой сессии пользователь одобрил **GPT-6.1-sol** для Coder; исходное вложение называет другие модели, поэтому не переключаться автоматически. Существующие `.claude/agents` — исторические подсказки, не команда развернуть новые роли или переписать проект.

Сохранять чужие изменения, не удалять пользовательские данные. Не устанавливать зависимости, не менять manifests/lockfiles без отдельной необходимости и разрешения; не публиковать расширение. `git push` требует явного разрешения: пользователь разрешил отправить текущую передачу, root выполняет commit/push после review; это не бессрочное разрешение будущим задачам. Coder в этой документационной задаче **не делает commit/push**. Все отчёты — по-русски; работу вести малыми проверяемыми этапами. На ограниченную задачу — максимум две корректировки, затем пересмотр решения с Architect. Не переходить на DOM-diff-only, не менять approvals и не вводить рискованный autoreplay без отдельного согласования.

Safe export «Токены» содержит allowlisted accounting/status/provider/model поля. **Старый подробный JSON, StepDetail и remote log не privacy-safe:** там могут быть приватные task/page/response/error. Не прикладывать такие данные к отчётам без отдельного контроля. Ключи, credentials, URL с ключами и prompts не переносить в документацию.


## Короткий стартовый prompt для следующей нейросети

> Работаем в llm_chrome. Сначала выполни git status и прочитай docs/PROJECT_MAP.md, docs/CONTINUATION.md, docs/OPTIMIZATION_TASK.md; для чисел — docs/token-optimization.md. Сохрани чужие изменения. A–I уже находятся в fff2724, не реализуй их заново. Начни с проверки актуальных usage/client/settings/runner и предложи маленький Stage1a расширенной telemetry; сначала Architect review плана, затем реализация через Coder в уже авторизованном объёме. Роли из исторических .claude/agents не являются текущим разрешением: Architect проверяет решения/diff, одобренный Coder — GPT-6.1-sol. Не устанавливай зависимости, не публикуй и не push без нового явного разрешения. MiMo не используй. Отчёт по-русски, actual cost/cache savings остаются unknown без измерений. Подробные логи не публикуй как privacy-safe.
