# Handoff

## Цель
Завести в `.claude/agents/` набор субагентов под разработку расширения
(DOM-экстракция, выполнение действий, клиент к llama-server, цикл агента,
security-review, разбор логов) и короткий `CLAUDE.md` с архитектурой.

## Сделано
- `.claude/agents/dom-extractor.md`, `action-executor.md`, `llm-client.md`,
  `agent-loop.md` (все sonnet) — по одному .md на модуль, промпты на английском,
  до 20 строк, с frontmatter `name/description/model/tools`.
- `.claude/agents/security-reviewer.md` (opus, только Read/Grep/Glob — не правит код,
  только отчёт) и `log-reader.md` (haiku, Read/Grep/Bash — только триаж, 5-10 строк).
- `CLAUDE.md` в корне — архитектура + два раздела под интерфейсы.

## Решения и почему
- **Агенты писались до чтения `src/`.** Когда дошёл до HANDOFF, обнаружилось,
  что расширение уже реализовано (`src/lib/agent/*`, `src/lib/dom/*`,
  `src/lib/llm/*`, sidepanel с макросами/очередью/Telegram) — то есть промпты
  агентов описывают задачу «построить с нуля», хотя модули уже есть.
  Явно не стал переписывать agent-файлы под реальные пути — это отдельная
  задача, чтобы не смешивать с текущим скоупом.
- В `CLAUDE.md` раздел «Interfaces» заполнил реальными форматами
  (`ElementInfo`/`AgentAction` из `src/lib/dom/types.ts`,
  `src/lib/agent/actions.ts`) вместо придуманных TODO-примеров — иначе
  документ был бы вводящим в заблуждение.
- security-reviewer/log-reader намеренно без Edit/Write — по требованию
  задачи (только отчёт, без правок).

## Под вопросом
- Пути и названия модулей в `.claude/agents/*.md` (dom-extractor,
  action-executor, llm-client, agent-loop) **не сверены** построчно с
  реальными файлами (`src/lib/dom/collect.ts`, `serialize.ts`, `act.ts`,
  `src/lib/agent/loop.ts`, `runner.ts`, `src/lib/llm/client.ts`) — агент,
  вызванный по имени, должен сам найти нужный файл, явного маппинга нет.
- Не проверено, что `host_permissions`/CORS к llama-server в `manifest`
  реально настроены так, как предполагает `llm-client.md` — не читал
  `wxt.config`/manifest в этой сессии.

## Следующий шаг
Прогнать `security-reviewer` на текущем `manifest`/`src/lib/llm/client.ts`,
чтобы проверить реальные permissions и путь данных страницы → модель, и по
факту уточнить пути в `.claude/agents/*.md`.
