# Автоотправка откликов FL.ru (fl-sender)

Полная документация подсистемы автоматической отправки откликов на FL.ru:
архитектура, отбор кандидатов, форма FL.ru, cookies, анти-блок дизайн,
эксплуатация, устранение неполадок и legacy-версия для Mac.

> Историческая справка: раньше отправка жила на Mac (`com.fl.autosend` +
> `autosend/auto.js`). С 14.09.2026 она перенесена на сервер в виде
> docker-сервиса `fl-sender` (скрипт `ops/fl-sender/server-sender.js`), Mac-версия
> отключена и оставлена в `ops/fl-sender/legacy/` только как справочник.

---

## 1. Что делает fl-sender

`fl-sender` — автономный контейнер, который циклично (каждые 2 минуты):

1. Берёт **advisory lock** в PostgreSQL (защита от параллельных циклов).
2. Выбирает из БД черновики-кандидаты на отправку (см. §3).
3. Для каждого кандидата открывает страницу проекта на FL.ru через
   Puppeteer (headless Chromium), заполняет форму отклика `#newoffer` и
   отправляет её.
4. Помечает черновик `sent` / `rejected` в БД, пишет activity, шлёт
   уведомление владельцу в Telegram.

Отправка идёт **без ручного подтверждения** — но только по черновикам,
прошедшим жёсткий фильтр качества (§3). Всё, что не прошло фильтр,
автоотправке не подлежит вовсе.

```
сканер (api/worker) ──► анализ (AI) ──► drafts (initial_response, fl, pending)
                                              │
                     fl-sender (docker) ◄─────┘  цикл 120 c, 1 отправка
                       │  cookies из settings.fl_cookies (расшифровка)
                       ▼
                     FL.ru  #newoffer ──► подтверждение (#my-offer / текст)
                       │
                       ▼
              drafts.status='sent' + activities.auto_sent_fl + TG ✅
```

---

## 2. Компоненты

| Компонент | Путь | Назначение |
|---|---|---|
| Сервис Compose | `docker-compose.yml` → `fl-sender` | контейнер, `restart: unless-stopped` |
| Скрипт отправки | `ops/fl-sender/server-sender.js` | вся логика: выборка, форма, маркировка |
| Установка cookies | `ops/fl-sender/legacy/install_cookies.js` | шифрует и пишет cookies в БД |
| Проверка cookies | `ops/fl-sender/legacy/verify_cookies.js` | Puppeteer-проверка логина/капчи |
| Заголовок cookies | `ops/fl-sender/legacy/dumpcookieheader.js` | экспорт браузерных cookies → `Cookie:`-строка |
| Legacy Mac-версия | `ops/fl-sender/legacy/auto.js` | прежний LaunchAgent на Mac (отключён) |

Монтируется только `./ops/fl-sender:/ops:ro` — правки скрипта подхватываются
перезапуском контейнера, пересборка образа не нужна:

```bash
docker compose restart fl-sender
```

---

## 3. Отбор кандидатов

SQL-выборка (упрощённо, из `server-sender.js`):

```sql
WHERE d.kind='initial_response' AND d.channel='fl' AND d.status='pending'
  AND (l.analysis->>'size_grade' IN ('medium','large')
       OR l.recommended_price >= :AUTOSEND_MIN_DEAL_PRICE)
  AND d.created_at > now() - ':SENDER_WINDOW_MIN minutes'::interval
  AND NOT (d.metadata#>'{review,flags}') ? 'style_check_failed'
  AND NOT COALESCE((d.metadata->>'hold_for_owner')::boolean, false)
  AND NOT EXISTS (SELECT 1 FROM drafts x
                  WHERE x.lead_id=d.lead_id AND x.kind='initial_response'
                    AND x.channel='fl' AND x.status='sent')
ORDER BY l.recommended_price DESC
LIMIT :SENDER_CANDIDATES_LIMIT
```

То есть кандидат должен быть:

- черновиком первого отклика по FL.ru в статусе `pending`;
- заказом грейда **medium/large** **или** с рекомендуемой ценой ≥
  **30 000 ₽**;
- созданным не позднее **40 минут** назад;
- без проваленного style-check и без ручного удержания владельцем;
- по этому заказу ещё не было отправленного отклика.

Дополнительные фильтры уже на странице FL.ru:

- **fixed-budget gate**: если у заказа фиксированная цена, в форму можно
  подставить только `min(budget, 999999)` — иначе отправка пропускается
  (`SKIP`), чтобы не отправить некорректную сумму;
- **too old gate**: реальный возраст заказа определяется по времени
  публикации в `<title>` страницы (не по `created_at` черновика). Если
  заказу больше `AUTOSEND_MAX_AGE` (900 c) — черновик отклоняется
  (`rejected`, метка `auto_too_old`), потому что отправка уже бессмысленна.

---

## 4. Цикл отправки и pacing

- Цикл каждые `SENDER_INTERVAL_SEC` (120 c), за цикл максимум
  `SENDER_MAX_PER_CYCLE` (1) отправка.
- Дополнительный глобальный троттлинг: пауза от предыдущей отправки ≥
  `SENDER_MIN_GAP_SEC` (90 c) — считается по `max(sent_at)` отправленных
  черновиков.
- Параллельность исключена через `pg_try_advisory_lock(901251)`: второй
  экземпляр просто пропускает цикл.
- Переходы по страницам: `waitUntil: 'domcontentloaded'` + пауза 5 c.
  **Не использовать `networkidle2`** — FL.ru держит долгие long-poll
  соединения, навигация по нему стабильно падает по таймауту 60 c.
- Заполнение формы: скрытие `navigator.webdriver`, UA настольного Chrome,
  viewport 1512×900, посимвольные задержки при вводе, поля
  `#el-descr` / `#el-cost_from` / `#el-time_from`, сабмит `#el-submit`
  (в форме также требуется `input[name="hash"]` — берётся со страницы).
- Подтверждение успеха: появление `#my-offer` или служебного текста в body.
- Капча на любой странице → **FATAL**: полная остановка отправлялки +
  алерт в Telegram. До вмешательства человека отправки не возобновляются
  (это защита аккаунта).

### Итог классификации (что пишется в БД)

| Ситуация | Действие |
|---|---|
| Форма найдена, отправка подтверждена | `status='sent'`, `sent_at=now()`, activity `auto_sent_fl`, TG ✅ |
| «Вы уже откликались» | `rejected` + метка `auto_already_responded` |
| Заказ слишком старый (по `<title>`) | `rejected` + метка `auto_too_old` |
| Страница уже была открыта с этим откликом | помечается `sent` (без повторной отправки) |
| Проект закрыт (403), нет формы, лимит 24 отклика, fixed-budget gate | `SKIP` без изменения статуса — черновик остаётся в окне и стареет естественно |
| Неизвестная ошибка формы | просто `ERR` в лог, **без ретраев** по этому кандидату |
| Капча | FATAL + стоп + TG-алерт |

---

## 5. Cookies FL.ru

### Где хранятся

Таблица `settings`, ключ `fl_cookies`, значение зашифровано `CryptoService`
(`ENCRYPTION_KEY` из `.env`). Из cookies собирается заголовок для сканера и
cookie-массив для Puppeteer отправлялки.

### Требования к набору

- Обязательные auth-cookie: `id`, `name`, `pwd` (32 символа), `PHPSESSID`,
  `user_device_id`, `XSRF-TOKEN`.
- Домен должен быть `.www.fl.ru` (при экспорте из браузера значения с
  доменом `www.fl.ru` нормализуются). Неправильный домен → FL видит гостя.
- Значения не должны содержать `;` и пробелов (фильтруются при загрузке).

### Установка новых cookies

1. В браузере (обычный профиль, залогинен на fl.ru) экспортировать все
   cookies домена fl.ru (JSON, формат расширения типа EditThisCookie /
   Cookie-Editor).
2. Прогнать через `dumpcookieheader.js` — он отфильтрует fl.ru-куки,
   нормализует домены и покажет итог.
3. Установить в БД (внутри контейнера api, у него есть `DATABASE_URL`):

```bash
docker cp install_cookies.js freelance-sales-v2-api-1:/tmp/
docker exec freelance-sales-v2-api-1 node /tmp/install_cookies.js /tmp/cookies.json
```

4. Проверить:

```bash
docker cp verify_cookies.js freelance-sales-v2-api-1:/tmp/
docker exec freelance-sales-v2-api-1 node /tmp/verify_cookies.js
# ожидаем: uid=…, captcha=false, homepage 200
```

После установки cookies сбросить сигнализацию коннектора, если она сработала:

```sql
UPDATE connector_state SET healthy=true, status_text='Cookies FL.ru действительны · мониторинг и отправка работают'
WHERE connector='fl';
```

### Ротация

Cookies живут долго (у актуального набора экспиры 2027), но при выходе из
аккаунта/смене пароля на FL.ru их нужно переустановить. Признак протухших
cookies: `verify_cookies.js` показывает гостя или капчу; отправлялка при
этом уйдёт в FATAL и перестанет слать — это нормально, чинится
переустановкой.

---

## 6. Анти-блок дизайн

Отправка с сервера безопасна по следующим причинам:

1. **Тот же IP и та же сессия, что и мониторинг.** Сканер уже месяц ходит
   на FL.ru с сервера с этими cookies — «обычный» профиль поведения
   сложился. Отправка не добавляет нового источника трафика.
2. **Медленный темп.** 1 отклик за цикл 120 c + минимум 90 c между
   откликами → физически не больше ~30 откликов в час, на практике —
   единицы в день (только qualifying-заказы свежее 40 минут).
3. **Человекообразная механика.** Реальный UA, viewport, задержки при
   вводе, скрытие `webdriver`, обычная последовательность страница →
   форма → сабмит → подтверждение.
4. **Никаких ретраев и повторных сабмитов.** Неизвестная ошибка → лог и
   переход к следующему циклу. Повторный сабмит той же формы — главный
   риск бана, поэтому его нет.
5. **Избирательность.** Отправляются только свежие заказы с высоким
   грейдом/ценой — профиль «разборчивого фрилансера», а не спам-бота.
6. **Капча = немедленная остановка**, а не «продавить через капчу».
7. **Закрытые/ограниченные проекты не долбятся**: 403 или отсутствие
   формы → skip, без повторных попыток в этом цикле.

---

## 7. Эксплуатация

### Статус и логи

```bash
docker ps | grep fl-sender
docker logs -f freelance-sales-v2-fl-sender-1
```

Полезные строки лога: `candidates: …` (кого нашёл), `SENT …` (отправка),
`SKIP/ERR/TOO OLD/ALREADY RESPONDED` (пропуски), `done, sent=N` (итог цикла).

### Что в БД

```sql
-- статусы откликов
SELECT status, count(*) FROM drafts WHERE kind='initial_response' AND channel='fl' GROUP BY status;
-- последние отправки
SELECT d.id, d.sent_at, l.url FROM drafts d JOIN leads l ON l.id=d.lead_id
WHERE d.kind='initial_response' AND d.status='sent' ORDER BY d.sent_at DESC LIMIT 10;
```

### Отключить автоотправку (не удаляя сервис)

```bash
ssh codex-mesh "cd /opt/vds-console/workspaces/default/freelance-sales-v2 && docker compose stop fl-sender"
```

Черновики при этом копятся в `pending` и стареют в окне 40 минут. Обратный
запуск — `docker compose start fl-sender`.

### Тестовые режимы

Реальная отправка **запрещена** в тестах. Доступны:

- `AUTOSEND_DRY=1` — не открывать браузер, только выборка и логи;
- `AUTOSEND_REHEARSE=1` — открыть страницу, заполнить форму, **не** нажимать
  сабмит;
- `SENDER_ONCE=1` — один цикл и выход.

**Важно:** переменные передаются только флагом `-e`, shell-префикс перед
`docker compose run` в контейнер **не попадает**:

```bash
# правильно:
docker compose run --rm --no-deps -e AUTOSEND_REHEARSE=1 -e SENDER_ONCE=1 fl-sender
# НЕПРАВИЛЬНО (env не применится, пойдёт реальная отправка!):
AUTOSEND_REHEARSE=1 SENDER_ONCE=1 docker compose run …
```

### Параметры окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `SENDER_INTERVAL_SEC` | `120` | период цикла, c |
| `SENDER_MAX_PER_CYCLE` | `1` | максимум отправок за цикл |
| `SENDER_MIN_GAP_SEC` | `90` | минимальная пауза между отправками |
| `AUTOSEND_MAX_AGE` | `900` | максимальный возраст заказа, c (too old gate) |
| `AUTOSEND_MIN_DEAL_PRICE` | `30000` | минимальная цена qualifying-заказа, ₽ |
| `SENDER_WINDOW_MIN` | `40` | окно жизни черновика, мин |
| `SENDER_CANDIDATES_LIMIT` | `5` | сколько кандидатов тянуть за раз |
| `SENDER_ONCE` | — | `1` = один цикл и выход |
| `AUTOSEND_DRY` | — | `1` = без браузера |
| `AUTOSEND_REHEARSE` | — | `1` = заполнить форму без сабмита |
| `SENDER_TG_CHAT` | `677822370` | chat_id для уведомлений владельца |

---

## 8. Legacy: отправка с Mac (отключено)

Прежняя схема: LaunchAgent `com.fl.autosend` на Mac запускал
`~/Desktop/freelance/autosend/auto.js` — тот же алгоритм, но Chrome был
реальный, пользовательский. Отключена 14.09.2026:

- `launchctl disable gui/501/com.fl.autosend`
- plist переименован: `~/Library/LaunchAgents/com.fl.autosend.plist.disabled`

Вернуть, если понадобится:

```bash
mv ~/Library/LaunchAgents/com.fl.autosend.plist.disabled ~/Library/LaunchAgents/com.fl.autosend.plist
launchctl enable gui/501/com.fl.autosend
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.fl.autosend.plist
```

⚠️ Mac-версию и серверную **нельзя включать одновременно** — двойные
отправки. Advisory lock разруливает только серверные экземпляры, между
Mac и сервером синхронизации нет.

---

## 9. Известные грабли (реальный опыт эксплуатации)

| Симптом | Причина | Решение |
|---|---|---|
| `Navigation timeout … networkidle2` | FL.ru long-poll держит соединения | `domcontentloaded` + пауза 5 c (уже сделано) |
| `Waiting for selector #newoffer failed` | проект закрыт (403), лимит откликов (напр. «Откликнулись: 24»), или fixed-budget gate | норма, `SKIP`; не ошибка блокировки |
| Внезапно «гость» на FL.ru | куки с доменом `www.fl.ru` вместо `.www.fl.ru` | нормализовать домены, переустановить |
| `password authentication failed for user "freelance"` при работе с БД в контейнере | в контейнере нет `PGPASSWORD` | использовать `DATABASE_URL` (`new Pool({connectionString: process.env.DATABASE_URL})`) |
| `EACCES /ops/server-sender.js` | файл/каталоги не читаемы uid 1000 (node) | `chmod 755 ops/fl-sender; chmod 711 ops; chmod 644 файл` |
| Отправка пошла в боевом режиме из «теста» | env передан shell-префиксом перед `docker compose run` | передавать через `-e` (см. §7) |
| В настройках горит «Коннектор … требует внимания» | watchdog по строкам `connector_state`; фантомные строки `openai`/`images` были выпилены из `schema.sql` | проверить `connector_state`, убеждиться что лишних строк нет |
| Время публикации «уехало» на 3 часа | сервер в UTC, FL.ru пишет московское время в `<title>` | парсится как UTC+3 явно (`parsePublishSec`) |

---

## 10. Схема ответственности за отправку (итог)

| Слой | Отвечает |
|---|---|
| Сканер + AI-анализ (api/worker) | находит заказы, считает грейд/цену, создаёт черновики |
| `fl-sender` | отправка qualifying-черновиков в FL.ru, маркировка, TG-уведомления |
| Владелец (Telegram) | алерты, ручные доработки, всё что не auto (follow-up, сообщения клиентам) |
| Watchdog (processor) | здоровье коннекторов, алерт «требует внимания» |
