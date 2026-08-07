export type SandboxLeadLike = {
  source?: unknown;
  client?: unknown;
};

export type SandboxStepInput = {
  analysisState: string;
  score: number | null;
  confidence: number | null;
  initialDrafts: Array<{ status?: string; content?: string }>;
  flDrafts: Array<{ status?: string; content?: string }>;
  telegramDrafts: Array<{ status?: string; content?: string }>;
  messages: Array<{ channel?: string; direction?: string }>;
  handoffs: Array<{ status?: string; from_channel?: string; to_channel?: string }>;
  requirements: Array<{ status?: string }>;
  documents: Array<{ kind?: string }>;
  designCount: number;
  deliveries: Array<{ status?: string; external_id?: string | null; error?: string | null }>;
};

export function buildSandboxSteps(input: SandboxStepInput) {
  const inboundFl = input.messages.filter((message) => message.channel === 'fl' && message.direction === 'inbound').length;
  const inboundTelegram = input.messages.filter((message) => message.channel === 'telegram' && message.direction === 'inbound').length;
  const initialSent = input.initialDrafts.filter((draft) => draft.status === 'sent').length;
  const flSent = input.flDrafts.filter((draft) => draft.status === 'sent').length;
  const telegramSent = input.telegramDrafts.filter((draft) => draft.status === 'sent').length;
  const confirmed = input.requirements.filter((item) => item.status === 'confirmed').length;
  const open = input.requirements.filter((item) => item.status === 'open').length;
  const documentKinds = new Set(input.documents.map((document) => document.kind));
  const documentsReady = ['specification', 'contract_data', 'contract', 'codex_handoff']
    .every((kind) => documentKinds.has(kind));
  const escapedDeliveries = input.deliveries.filter((delivery) => !(
    delivery.status === 'sent'
    && String(delivery.external_id || '').startsWith('sandbox:')
    && String(delivery.error || '').startsWith('[sandbox]')
  ));
  const capturedDeliveries = input.deliveries.length - escapedDeliveries.length;

  return [
    {
      key: 'created', label: 'Тестовый заказ создан', done: true,
      description: 'Создан отдельный заказ с source=sandbox; он исключён из боевой статистики и очередей владельца.',
      evidence: 'Изолированная тестовая сделка существует в базе.',
    },
    {
      key: 'analyzed', label: 'Codex оценил заказ', done: input.analysisState === 'completed', failed: input.analysisState === 'failed',
      description: 'Запущен тот же анализ релевантности, рисков, цены и срока, который используется для заказов FL.ru.',
      evidence: input.analysisState === 'completed'
        ? `Оценка ${input.score ?? '—'}/100, уверенность ${input.confidence ?? '—'}%.`
        : `Состояние анализа: ${input.analysisState || 'не запускался'}.`,
    },
    {
      key: 'initial_draft', label: 'Первичный отклик подготовлен', done: input.initialDrafts.length > 0,
      description: 'ИИ сформировал отклик с портфолио, рамкой объёма, ценой, сроком и первым уточняющим вопросом.',
      evidence: input.initialDrafts.length ? `${input.initialDrafts.length} вариант(а), ${input.initialDrafts[0]?.content?.length || 0} знаков.` : 'Черновика ещё нет.',
    },
    {
      key: 'initial_send', label: 'Отклик одобрен и безопасно отправлен', done: initialSent > 0,
      description: 'Использованы обычное ручное одобрение, реестр доставки и идемпотентность; внешний вызов FL.ru заменён захватом в полигоне.',
      evidence: initialSent ? `Захвачено отправок отклика: ${initialSent}.` : 'Отклик ещё не одобрен.',
    },
    {
      key: 'fl_client_reply', label: 'Получено сообщение клиента в FL-чате', done: inboundFl > 0,
      description: 'Тестовое входящее сообщение прошло через ту же память сделки, что сообщение из синхронизации FL.ru.',
      evidence: inboundFl ? `Входящих сообщений FL: ${inboundFl}.` : 'Сообщение тестового клиента ещё не введено.',
    },
    {
      key: 'fl_agent_reply', label: 'Агент ответил в FL-чате', done: flSent > 0,
      description: 'Агент выделил факты и открытые вопросы, подготовил ответ, после ручного одобрения доставка была перехвачена.',
      evidence: flSent ? `Безопасно отправлено ответов FL: ${flSent}.` : `${input.flDrafts.length} черновик(а), отправлено: ${flSent}.`,
    },
    {
      key: 'handoff', label: 'Сделка связана FL → Telegram', done: input.handoffs.some((handoff) => handoff.status === 'used' && handoff.from_channel === 'fl' && handoff.to_channel === 'telegram'),
      description: 'Одноразовый код связал новый Telegram-чат с той же сделкой: история, требования и клиент не раздвоились.',
      evidence: input.handoffs.some((handoff) => handoff.status === 'used') ? 'Код перехода использован, Telegram-канал привязан.' : 'Переход ещё не выполнен.',
    },
    {
      key: 'telegram_client_reply', label: 'Получено сообщение клиента в Telegram', done: inboundTelegram > 0,
      description: 'Сообщение прошло через боевой Telegram-ingest, но с искусственным chat id и без обращения к Telegram.',
      evidence: inboundTelegram ? `Входящих сообщений Telegram: ${inboundTelegram}.` : 'Telegram-сообщение ещё не смоделировано.',
    },
    {
      key: 'telegram_agent_reply', label: 'Агент ответил в Telegram', done: telegramSent > 0,
      description: 'Ответ построен по общей истории FL + Telegram, одобрен и перехвачен перед внешней отправкой.',
      evidence: telegramSent ? `Безопасно отправлено ответов Telegram: ${telegramSent}.` : `${input.telegramDrafts.length} черновик(а), отправлено: ${telegramSent}.`,
    },
    {
      key: 'requirements', label: 'Требования извлечены и классифицированы', done: input.requirements.length > 0,
      description: 'Каждый факт хранится отдельно со статусом, уверенностью и ссылкой на исходное сообщение.',
      evidence: input.requirements.length ? `Всего ${input.requirements.length}: подтверждено ${confirmed}, открыто ${open}.` : 'Требования ещё не извлечены.',
    },
    {
      key: 'documents', label: 'ТЗ, договор и пакет Codex созданы', done: documentsReady,
      description: 'На одной версии контекста собраны полное ТЗ, подтверждённые поля договора и handoff-пакет для реализации.',
      evidence: input.documents.length ? `Документы: ${Array.from(documentKinds).join(', ')}.` : 'Документов ещё нет.',
    },
    {
      key: 'design', label: 'PNG-концепции созданы', done: input.designCount > 0,
      description: 'Codex через Hermes подготовил HTML/CSS-варианты, Chromium безопасно отрендерил их в PNG 1536×1024.',
      evidence: input.designCount ? `Готовых PNG: ${input.designCount}.` : 'Концепции ещё не создавались.',
    },
    {
      key: 'isolation', label: 'Ни одна отправка не вышла наружу', done: input.deliveries.length > 0 && escapedDeliveries.length === 0, failed: escapedDeliveries.length > 0,
      description: 'Финальный предохранитель проверяет реестр доставок: допустимы только sandbox-id и отметка блокировки внешней записи.',
      evidence: input.deliveries.length
        ? `Перехвачено ${capturedDeliveries}; подозрительных внешних доставок ${escapedDeliveries.length}.`
        : 'Доставок пока не было — предохранитель ещё не проверен действием.',
    },
  ];
}

export function isSandboxLead(lead: SandboxLeadLike | null | undefined): boolean {
  if (!lead) return false;
  const client = lead.client && typeof lead.client === 'object'
    ? lead.client as Record<string, unknown>
    : {};
  return lead.source === 'sandbox' && client.sandbox === true;
}

export const SANDBOX_SCENARIOS = {
  web_service: {
    title: 'SaaS-сервис для отдела продаж',
    description: 'Нужен личный кабинет для менеджеров: заявки из формы и Telegram, статусы сделок, роли, уведомления, отчёт по конверсии и экспорт в Excel. Есть текущий сайт и PostgreSQL. Нужны понятные этапы, оценка срока и предложение по архитектуре.',
    budgetText: '250 000–400 000 ₽',
  },
  ecommerce: {
    title: 'Интернет-магазин с интеграцией 1С',
    description: 'Нужно спроектировать и разработать интернет-магазин на 3 000 товаров. Обязательны фильтры, поиск, корзина, онлайн-оплата, синхронизация остатков с 1С и адаптивная версия. Дизайн требуется с нуля. Хотим запуск по этапам.',
    budgetText: '300 000 ₽',
  },
  vague: {
    title: 'Нужно сделать современный сайт',
    description: 'Нужен красивый современный сайт для компании. Деталей пока мало, хотим обсудить варианты, сроки и стоимость.',
    budgetText: 'По договорённости',
  },
} as const;

export type SandboxScenario = keyof typeof SANDBOX_SCENARIOS;
