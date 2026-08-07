# Тестирование без расхода откликов FL.ru

## Уровни проверки

| Уровень | Что проверяет | Внешние отправки |
|---|---|---|
| Jest | бизнес-правила TypeScript | нет |
| Python unittest | схемы и поведение broker | нет |
| Лаборатория общения | три изолированных AI-сценария чата | нет |
| Полигон | полный синтетический путь сделки | перехватываются |
| Visual smoke | desktop/mobile интерфейс | нет |
| Production health | доступность сервисов | нет |

## Сборка и модульные тесты

```bash
docker compose build api
```

Dockerfile выполняет web/API build и `npm test -w apps/api` до создания runtime
image. Для локального окружения с Node.js:

```bash
npm install
npm test
npm run build
python3 -m unittest ops/test_sales_hermes_broker.py
```

Для рекомендаций системного исследования отдельно полезен короткий набор:

```bash
npm test -w apps/api -- --runInBand \
  research-controls.spec.ts chat-policy.spec.ts autonomy.service.spec.ts
python3 -m unittest ops/test_sales_hermes_broker.py
```

Он проверяет рабочие дни/джиттер follow-up, фильтр числовых обязательств,
spotlighting, пороги классов, regex false positives, ротацию эскалаций,
неотключаемое ручное одобрение FL.ru и схему Hermes.

Проверяются анализ, качество отклика, pricing policy, чат-политика, миссии,
owner intents, stale drafts, Telegram-уведомления, sandbox, документы,
автономность и дизайн.

## «Полигон»

Страница `?page=sandbox` создаёт lead с признаком sandbox. Она позволяет отдельно
запустить:

1. анализ тестового заказа;
2. создание отклика;
3. одобрение с перехватом доставки;
4. сообщение тестового клиента FL.ru;
5. ответ агента;
6. FL → Telegram handoff;
7. Telegram-реплику в общей истории;
8. ТЗ, договорные данные, DOCX и Codex handoff;
9. тестовые PNG-концепции;
10. просмотр AI tasks, activities и delivery registry.

Sandbox delivery считается безопасной только если `external_id` имеет
изолированный префикс, error содержит sandbox marker и отчёт показывает ноль
escaped deliveries. Один только зелёный UI-индикатор не заменяет проверку
реестра.

CLI smoke:

```bash
node ops/sandbox_smoke.js
```

Он работает с API и должен использовать тестовую учётную запись/контекст.

## «Лаборатория общения»

Страница `?page=chat-lab` показывает сохранённые синтетические сценарии:

- пакет нескольких сообщений клиента;
- эскалацию цены/срока владельцу;
- продолжение Telegram-диалога с общей памятью FL.ru.

Целевой smoke:

```bash
node ops/chat_research_smoke.js
```

При оценке результата проверяйте не только наличие ответа:

- stage_before/stage_after;
- bundle входящих сообщений;
- не более одного вопроса;
- полезность до вопроса;
- stop reasons и requiresOwner;
- обновлённые требования и confidence;
- отсутствие внешней delivery.

## Проверка откликов на последних заказах

Без отправки клиентам:

1. выберите три последних `qualified` заказа;
2. создайте draft вручную;
3. убедитесь, что status — `pending`, а delivery отсутствует;
4. сравните hook и acceptance label между тремя текстами;
5. проверьте цену, срок, дату старта, один релевантный кейс/ссылку и один вопрос;
6. проверьте ограничения профиля `compact/standard/premium`;
7. отклоните или оставьте drafts на ручной проверке.

Не следует тестировать генератор на нерелевантном заказе, заставляя production
классификатор признать его подходящим. Для этого есть sandbox.

## Проверка Telegram-доставки

Есть три разных проверки:

1. unit test формирует delivery и проверяет idempotency;
2. sandbox перехватывает delivery до внешнего API;
3. живая доставка возможна только по явной команде владельца конкретному
   получателю.

В живой проверке заранее зафиксируйте recipient и текст. После команды ждите
финальный status. При обрыве сначала перечитайте delivery и реальный чат; не
повторяйте команду на другом канале автоматически.

## Visual smoke

```bash
node ops/sandbox_visual_check.js
```

Проверка открывает desktop и mobile viewport, ищет ключевые элементы, измеряет
layout и делает screenshots. Browser console errors и горизонтальное
переполнение должны рассматриваться как дефект.

## Критерии готовности релиза

- build завершился без ошибок;
- TypeScript tests и Python broker tests зелёные;
- API health отвечает после сборки;
- миграции/SQL применяются идемпотентно;
- sandbox не имеет escaped deliveries;
- нет старых `claimed` AI tasks;
- нет новых `send_unknown` без ручной проверки;
- production остаётся в strict approval/on-demand режиме;
- `.env`, runtime, документы, cookies и dumps не попали в Git diff.
