import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const BASE = '/sales';
let mermaidReady: Promise<any> | null = null;

function loadMermaid() {
  if (!mermaidReady) mermaidReady = import('mermaid').then(({ default: engine }) => {
    engine.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: true },
      themeVariables: {
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: '14px',
        lineColor: '#98a2b3',
        primaryTextColor: '#344054',
      },
    });
    return engine;
  });
  return mermaidReady;
}

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(`${BASE}/api${path}`, {
    credentials: 'include',
    ...options,
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body as T;
}

type Page = 'dashboard' | 'sandbox' | 'chat-lab' | 'leads' | 'chats' | 'approvals' | 'settings';
const validPage = (value: string | null): Page => ['dashboard', 'sandbox', 'chat-lab', 'leads', 'chats', 'approvals', 'settings'].includes(value || '') ? value as Page : 'dashboard';

function App() {
  const params = new URLSearchParams(location.search);
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ok'>('loading');
  const [page, setPage] = useState<Page>(validPage(params.get('page')));
  const [selectedLead, setSelectedLead] = useState<string | null>(params.get('lead') || params.get('chat'));
  const [selectedView, setSelectedView] = useState<'lead' | 'chat'>(params.get('chat') ? 'chat' : 'lead');
  const [toast, setToast] = useState('');

  const refreshAuth = async () => {
    try { await api('/auth/me'); setAuth('ok'); }
    catch {
      const status = await api<{ required: boolean }>('/auth/setup-status');
      setAuth(status.required ? 'setup' : 'login');
    }
  };
  useEffect(() => { void refreshAuth(); }, []);
  useEffect(() => {
    if (auth === 'ok' && 'serviceWorker' in navigator) void navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
  }, [auth]);

  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 3500); };
  const navigate = (next: Page) => { setPage(next); history.replaceState({}, '', `${BASE}/?page=${next}`); window.scrollTo({ top: 0 }); };
  const openLead = (id: string) => { setSelectedView('lead'); setSelectedLead(id); history.replaceState({}, '', `${BASE}/?lead=${id}`); window.scrollTo({ top: 0 }); };
  const openChat = (id: string) => { setSelectedView('chat'); setSelectedLead(id); history.replaceState({}, '', `${BASE}/?chat=${id}`); window.scrollTo({ top: 0 }); };
  const closeLead = () => { setSelectedLead(null); history.replaceState({}, '', `${BASE}/?page=${page}`); window.scrollTo({ top: 0 }); };

  if (auth === 'loading') return <div className="center"><div className="spinner" /></div>;
  if (auth !== 'ok') return <Auth mode={auth} onDone={() => setAuth('ok')} />;

  return <div className={`shell ${selectedLead ? 'focus' : ''} ${page === 'chat-lab' ? 'chatLabShell' : ''}`}>
    <header>
      <div className="brand"><span className="logo">S</span><div><strong>Sales Control</strong><small>Заказы под контролем</small></div></div>
      <span className="approvalLock"><i /> Отправка только после одобрения</span>
    </header>
    <main>
      {selectedLead ? selectedView === 'chat' ? <ChatDetail id={selectedLead} back={closeLead} notify={notify} /> : <LeadDetail id={selectedLead} back={closeLead} notify={notify} /> : <>
        {page === 'dashboard' && <Dashboard openLead={openLead} notify={notify} openApprovals={() => navigate('approvals')} openChats={() => navigate('chats')} />}
        {page === 'sandbox' && <Sandbox openLead={openLead} notify={notify} />}
        {page === 'chat-lab' && <ChatLab back={() => navigate('dashboard')} />}
        {page === 'leads' && <Leads openLead={openLead} notify={notify} />}
        {page === 'chats' && <Chats openChat={openChat} />}
        {page === 'approvals' && <Approvals notify={notify} />}
        {page === 'settings' && <Settings notify={notify} />}
      </>}
    </main>
    {!selectedLead && page !== 'chat-lab' && <nav>
      <Nav active={page === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌂" text="Главная" />
      <Nav active={page === 'sandbox'} onClick={() => navigate('sandbox')} icon="◇" text="Полигон" />
      <Nav active={page === 'leads'} onClick={() => navigate('leads')} icon="▣" text="Заказы" />
      <Nav active={page === 'chats'} onClick={() => navigate('chats')} icon="◌" text="Чаты" />
      <Nav active={page === 'approvals'} onClick={() => navigate('approvals')} icon="✓" text="На проверку" />
      <Nav active={page === 'settings'} onClick={() => navigate('settings')} icon="⚙" text="Система" />
    </nav>}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function Auth({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const token = new URLSearchParams(location.search).get('token') || '';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try {
      await api(mode === 'setup' ? '/auth/setup' : '/auth/login', { method: 'POST', body: JSON.stringify({ password, token }) });
      history.replaceState({}, '', `${BASE}/`); onDone();
    } catch (error) { setError((error as Error).message); }
  };
  return <div className="auth"><form onSubmit={submit}>
    <span className="logo big">S</span><h1>{mode === 'setup' ? 'Первичная настройка' : 'Вход'}</h1>
    <p>{mode === 'setup' ? 'Задайте пароль администратора от 12 символов.' : 'Введите пароль администратора.'}</p>
    <input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Пароль" />
    {error && <div className="error">{error}</div>}<button className="primary">Продолжить</button>
  </form></div>;
}

function Nav({ active, onClick, icon, text }: { active: boolean; onClick: () => void; icon: string; text: string }) {
  return <button className={active ? 'active' : ''} onClick={onClick}><span>{icon}</span>{text}</button>;
}

const chatLabStages = [
  ['S1', 'Первый ответ', 'Ответить по существу и задать один лёгкий вопрос'],
  ['S2', 'Discovery', 'Цель, текущее состояние, боль и ограничения'],
  ['S3', 'Квалификация', 'Рамка, ЛПР, причина дедлайна и критерий успеха'],
  ['S4', 'Ценность', 'Диагноз, короткий подход и одно доказательство'],
  ['S5', 'Канал', 'Созвон или Telegram только после предметного интереса'],
  ['S6', 'Фиксация ТЗ', 'Резюме на письменное подтверждение клиента'],
  ['S7', 'Условия', 'Цена, срок и договор — только через владельца'],
  ['S8', 'В работу', 'Подтверждённый пакет передаётся в разработку'],
];

const chatLabScenarios = [
  {
    title: 'FL.ru · три сообщения подряд',
    stage: 'S2 · Discovery',
    confidence: '94%',
    decision: 'Один ответ на весь пакет · 1 вопрос · владелец не нужен',
    requirements: ['Каталог уже существует', 'Остатки приходят из МойСклад', 'Оплата через ЮKassa'],
    messages: [
      ['client', 'Каталог уже есть.'],
      ['client', 'Остатки приходят из МойСклад.'],
      ['client', 'Оплата — ЮKassa.'],
      ['agent', 'Тогда каталог не нужно собирать с нуля: основной контур — связать его с остатками из МойСклад и оплатой через ЮKassa. Что именно требуется реализовать поверх уже готового каталога?'],
    ],
  },
  {
    title: 'FL.ru · вопрос о цене и сроке',
    stage: 'S7 · Решение владельца',
    confidence: '97% + стоп-триггер',
    decision: 'Черновик безопасной паузы · владельцу передан бриф · цифры не обещаны',
    requirements: ['Клиент запросил цену', 'Клиент запросил срок', 'Нужно решение владельца'],
    messages: [
      ['client', 'Сколько будет стоить и успеете до конца месяца?'],
      ['agent', 'По деньгам, срокам и условиям решаю лично. Проверю объём и вернусь с конкретикой сегодня до 18:00 по Москве.'],
    ],
  },
  {
    title: 'Telegram · продолжение той же сделки',
    stage: 'S4 · Ценностная рамка',
    confidence: '96%',
    decision: 'Контекст FL.ru сохранён · агент не перескочил к ТЗ, пока открыто действие по push',
    requirements: ['iOS и Android', 'Каталог из действующей системы', 'Тестовая оплата', 'Открыт вопрос действия по push'],
    messages: [
      ['client', 'Да, пуш нужен только когда заказ собран и когда передан в доставку.'],
      ['agent', 'Тогда в первом этапе оставляем ровно два push-триггера: заказ собран и передан в доставку — без промежуточных статусов. По нажатию на уведомление нужно открывать карточку соответствующего заказа?'],
    ],
  },
];

function ChatLab({ back }: { back: () => void }) {
  return <section className="chatLabPage">
    <button className="back" onClick={back}>← Вернуться на Dashboard</button>
    <div className="chatLabHero">
      <div><span className="eyebrow">Изолированная лаборатория</span><h1>Как теперь работает общение</h1><p>Наглядная проверка только чат-контура по исследованию. Здесь нет доступа к FL.ru, Telegram и реальным клиентам.</p></div>
      <div className="chatLabSafety"><b>19 целевых проверок</b><span>0 внешних отправок</span><small>Ещё 14 проверок схемы Hermes</small></div>
    </div>

    <div className="chatLabStageGrid">{chatLabStages.map(([code, title, text]) => <article key={code}><i>{code}</i><div><b>{title}</b><p>{text}</p></div></article>)}</div>

    <div className="chatLabHeading"><div><span className="eyebrow">Три точечных сценария</span><h2>Что увидел агент и почему ответил именно так</h2></div><span>Все реплики тестовые</span></div>
    <div className="chatLabScenarios">{chatLabScenarios.map((scenario) => <article className="chatLabScenario" key={scenario.title}>
      <div className="chatLabScenarioHead"><div><small>{scenario.stage}</small><h3>{scenario.title}</h3></div><b>{scenario.confidence}</b></div>
      <div className="chatLabDecision"><span>Решение системы</span><p>{scenario.decision}</p></div>
      <div className="chatLabThread">{scenario.messages.map(([role, message], index) => <div className={role} key={`${scenario.title}-${index}`}><small>{role === 'client' ? 'Клиент' : 'Черновик агента'}</small><p>{message}</p></div>)}</div>
      <div className="chatLabFacts"><b>Память сделки</b>{scenario.requirements.map((item) => <span key={item}>✓ {item}</span>)}</div>
    </article>)}</div>

    <div className="chatLabChecks">
      <article><b>Программные предохранители</b><p>До сохранения черновика код проверяет: не более 500 знаков, не более одного вопроса, ценность перед вопросом и общий бюджет до семи discovery-вопросов.</p></article>
      <article><b>Безусловная передача владельцу</b><p>Цена, срок, договор, гарантии, доступы, негатив, созвон, вопрос об ИИ и подозрительные условия больше не остаются на усмотрение модели.</p></article>
      <article><b>Разные каналы — одна память</b><p>FL.ru деловитее, Telegram разговорнее. Код FS связывает каналы, а подтверждённые условия должны фиксироваться обратно в FL.ru.</p></article>
      <article className="pending"><b>Пока не включено в бою</b><p>Автоотправка и follow-up +1/+3/+7 не активированы: сначала собираем метрики на черновиках и одобрении владельца.</p></article>
    </div>
  </section>;
}

function Dashboard({ openLead, notify, openApprovals, openChats }: { openLead: (id: string) => void; notify: (text: string) => void; openApprovals: () => void; openChats: () => void }) {
  const [data, setData] = useState<any>();
  const [busy, setBusy] = useState(false);
  const load = () => api('/dashboard').then(setData);
  useEffect(() => { void load(); const timer = window.setInterval(load, 20_000); return () => clearInterval(timer); }, []);
  if (!data) return <Loading />;
  const fl = data.connectors.find((item: any) => item.connector === 'fl') || {};
  const scan = data.scan || {};
  const manualScan = async () => {
    setBusy(true);
    try {
      const result = await api<any>('/connectors/fl/scan', { method: 'POST' });
      notify(`FL проверен: новых ${result.projects?.created || 0}, повторов ${result.projects?.skippedKnown || 0}`);
      await load();
    } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  const toggle = async () => {
    setBusy(true);
    try {
      await api('/settings/fl', { method: 'POST', body: JSON.stringify({ enabled: !fl.enabled }) });
      notify(fl.enabled ? 'Автопроверка остановлена' : 'Автопроверка включена: каждые 5 минут');
      await load();
    } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  const new24 = Number(data.metrics.new24 || 0);
  const analyzed24 = Number(data.metrics.analyzed24 || 0);
  const qualified = Number(data.metrics.qualified || 0);
  const qualified24 = Number(data.metrics.qualified24 || 0);
  return <section>
    <div className="pageTitle"><div><span className="eyebrow">Сегодня</span><h1>Что сделать сейчас</h1><p>Сначала ваши решения. Остальное система делает сама.</p></div><PushControl notify={notify} compact /></div>

    <div className="metrics actionMetrics">
      <button className="metric amber actionable primaryAction" onClick={openApprovals}><b>{data.metrics.pending || 0}</b><span>Ответов ждут проверки</span><small>Проверить и отправить →</small></button>
      <button className="metric green actionable" onClick={openChats}><b>{fl.cursor?.chat_list_count || 0}</b><span>Диалогов с клиентами</span><small>Открыть переписку →</small></button>
      <Metric label="Подходящих заказов" value={qualified} tone="violet" hint="Система уже отобрала их для вас" />
    </div>

    <div className={`systemBar ${fl.enabled ? 'online' : 'paused'}`}><span className={fl.enabled ? 'dot ok' : 'dot'} /><div><b>{fl.enabled ? 'Автопоиск работает' : 'Автопоиск на паузе'}</b><small>{fl.status_text || 'Нет данных'}{fl.last_success_at ? ` · ${relativeTime(fl.last_success_at)}` : ''}</small></div><button onClick={manualScan} disabled={busy}>{busy ? 'Проверяю…' : 'Проверить'}</button><button className={fl.enabled ? 'danger soft' : 'primary'} onClick={toggle} disabled={busy}>{fl.enabled ? 'Пауза' : 'Включить'}</button></div>

    <div className="grid two dashboardGrid dashboardTech">
      <Card title="Воронка за 24 часа" subtitle="Показывает, куда ушли новые проекты">
        <FunnelRow label="Найдено новых" value={new24} max={Math.max(1, new24)} />
        <FunnelRow label="Оценено Codex" value={analyzed24} max={Math.max(1, new24)} />
        <FunnelRow label="Прошли отбор" value={qualified24} max={Math.max(1, new24)} accent />
        <div className="saving"><span>⚡</span><div><b>{scan.skipped24 || 0} повторов не отправлено в ИИ</b><small>Заказы сверяются по ID до запуска Codex</small></div></div>
      </Card>
      <Card title="Состояние системы" subtitle="Живые данные сервисов">
        {data.connectors.filter((item: any) => item.connector !== 'openai').map((connector: any) => <Connector key={connector.connector} connector={connector} />)}
        <div className="scanFacts"><span>Средний скан <b>{scan.avg_duration_ms ? `${scan.avg_duration_ms} мс` : '—'}</b></span><span>Последний <b>{scan.last_scan_at ? relativeTime(scan.last_scan_at) : '—'}</b></span></div>
      </Card>
    </div>
    <Card title="Заказы, на которые стоит посмотреть" subtitle={`${new24} новых за сутки · ${analyzed24} уже оценены`}><LeadRows leads={data.recent.slice(0, 5)} openLead={openLead} /></Card>
    <ResearchDashboard data={data.research} />
    <ArchitectureDashboard data={data} />
  </section>;
}

function ResearchDashboard({ data }: { data: any }) {
  if (!data) return null;
  const funnel = data.funnel || {};
  const followups = data.followups || {};
  const evals = data.evals || {};
  const proposals = numberOf(funnel.proposals);
  const replied = numberOf(funnel.replied);
  const replyRate = proposals > 0 ? Math.round((replied / proposals) * 100) : 0;
  const evalTotal = numberOf(evals.total);
  const evalRate = evalTotal > 0 ? Math.round((numberOf(evals.passed) / evalTotal) * 100) : 100;
  const humanity = data.proposalHumanity || {};
  const measuredHumanity = numberOf(humanity.measured);
  const humanityRate = measuredHumanity > 0
    ? Math.round((numberOf(humanity.human_pass) / measuredHumanity) * 100)
    : 0;
  return <section className="researchDashboard">
    <div className="researchHead"><div><span className="eyebrow">Контур доказуемой автономности</span><h2>Воронка, follow-up и качество агента</h2><p>Автоматические классы открываются только после нужного числа одобрений без правок. FL.ru всегда остаётся ручным.</p></div><span className="researchSafety">L1–L2 · сбор доказательств для L3</span></div>
    <div className="researchMetrics">
      <article><small>Отклики отправлены</small><b>{proposals}</b><span>Reply rate: {replyRate}% · живые: {humanityRate}%</span></article>
      <article><small>Ответили / диалог</small><b>{replied} / {funnel.engaged || 0}</b><span>Discovery: {funnel.discovery_complete || 0}</span></article>
      <article><small>Follow-up готовы</small><b>{followups.drafted || 0}</b><span>Запланировано: {followups.pending || 0}</span></article>
      <article><small>Бинарные evals</small><b>{evalRate}%</b><span>{evals.failed || 0} провалов за 30 дней</span></article>
    </div>
    <div className="researchGrid">
      <article className="researchFunnel"><b>Полная воронка</b>{[
        ['Отклики', funnel.proposals], ['Ответы', funnel.replied], ['Диалоги ≥3 сообщений', funnel.engaged],
        ['Discovery завершён', funnel.discovery_complete], ['FL → Telegram', funnel.handoff],
        ['ТЗ', funnel.specification], ['Сделки', funnel.won],
      ].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value || 0}</strong></div>)}</article>
      <article className="researchClasses"><b>Классы Telegram</b>{(data.autonomyClasses || []).length
        ? data.autonomyClasses.map((item: any) => <div key={item.class}><span><i className={item.auto_enabled ? 'on' : ''} />{item.class}</span><strong>{item.approved_asis}/{item.shown}</strong><small>{item.auto_enabled ? 'авто открыт' : 'ручной сбор доказательств'}</small></div>)
        : <p>Статистика начнёт заполняться с новых черновиков. До порогов всё остаётся ручным.</p>}</article>
      <article className="researchRules"><b>Что уже действует</b><span>✓ Follow-up +1/+3/+7 — только черновики</span><span>✓ Новое входящее отменяет всю серию</span><span>✓ Деньги, проценты и сроки блокируются в безопасных автоответах</span><span>✓ Ошибка владельца становится regression-кейсом</span><span>✓ AI watchdog не делает слепой повтор</span><span>✓ Естественность: бёрстинесс {humanity.avg_burstiness || '—'}, обращений {humanity.avg_addresses || '—'} (цель ≥90%)</span><span>✓ Эпизодов в памяти: {data.memory?.total || 0}</span></article>
    </div>
  </section>;
}

function ArchitectureDashboard({ data }: { data: any }) {
  const architecture = data.architecture || {};
  const [svg, setSvg] = useState('');
  const [renderError, setRenderError] = useState('');
  const diagram = useMemo(() => architectureDiagram(data), [
    data.connectors,
    architecture.handoffs_used,
    architecture.discovery_leads,
    architecture.specifications,
    architecture.contracts,
    architecture.designs,
    architecture.ai_failed_24h,
    architecture.ai_stuck,
    architecture.delivery_failed_24h,
  ]);

  useEffect(() => {
    let cancelled = false;
    const renderId = `freelance-architecture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setRenderError('');
    void loadMermaid().then((engine) => engine.render(renderId, diagram)).then((result) => {
      if (!cancelled) setSvg(result.svg);
    }).catch(() => {
      if (!cancelled) setRenderError('Схема временно не отрисовалась. Обновите страницу.');
    });
    return () => { cancelled = true; };
  }, [diagram]);

  const aiProblems = numberOf(architecture.ai_failed_24h) + numberOf(architecture.ai_stuck);
  const deliveryProblems = numberOf(architecture.delivery_failed_24h);
  const coreConnectors = [
    { key: 'fl', label: 'FL.ru' },
    { key: 'codex', label: 'Hermes/Codex' },
    { key: 'telegram', label: 'Telegram' },
  ];
  const connectorProblems = coreConnectors.filter(({ key }) => {
    const connector = data.connectors?.find((item: any) => item.connector === key);
    return !connector?.enabled || !connector?.healthy;
  });
  const totalProblems = connectorProblems.length + aiProblems + deliveryProblems;
  const lateFlowStarted = numberOf(architecture.handoffs_used) > 0;
  const discoveryStarted = numberOf(architecture.discovery_leads) > 0;
  const documentsStarted = numberOf(architecture.specifications) + numberOf(architecture.contracts) > 0;
  const designsStarted = numberOf(architecture.designs) > 0;

  const gaps = [
    connectorProblems.length > 0
      ? { tone: 'bad', title: `Недоступны: ${connectorProblems.map(({ label }) => label).join(', ')}`, text: 'Основной путь остановлен. Сначала восстановите эти подключения в разделе «Система».' }
      : { tone: 'ok', title: 'Основные подключения доступны', text: 'FL.ru, Hermes/Codex и Telegram включены и подтверждают здоровье.' },
    aiProblems > 0
      ? { tone: 'bad', title: `${aiProblems} проблем ИИ требуют проверки`, text: 'Есть упавшие или зависшие задачи Hermes/Codex за последние сутки.' }
      : { tone: 'ok', title: 'Очередь ИИ работает чисто', text: 'За последние сутки нет упавших или зависших задач.' },
    deliveryProblems > 0
      ? { tone: 'bad', title: `${deliveryProblems} проблем доставки`, text: 'Есть отправки с ошибкой или неизвестным внешним результатом.' }
      : { tone: 'ok', title: 'Ошибок доставки за сутки нет', text: 'Журнал отправок не показывает подтверждённых проблем.' },
    lateFlowStarted
      ? { tone: 'ok', title: 'Переход FL → Telegram пройден', text: `${architecture.handoffs_used} клиентов связаны между каналами.` }
      : { tone: 'warn', title: 'FL → Telegram не проверен на живом клиенте', text: 'Механика токена и связывания есть, но успешных переходов в базе пока 0.' },
    discoveryStarted && documentsStarted
      ? { tone: 'ok', title: 'Сбор требований и документы используются', text: `Клиентов с требованиями: ${architecture.discovery_leads}; ТЗ и договоров: ${numberOf(architecture.specifications) + numberOf(architecture.contracts)}.` }
      : { tone: 'warn', title: 'Хвост воронки ещё не обкатан', text: 'Требования, ТЗ и договор написаны в коде, но живых результатов в базе пока нет.' },
    designsStarted
      ? { tone: 'ok', title: 'Дизайн-концепции создавались', text: `Готовых изображений в системе: ${architecture.designs}.` }
      : { tone: 'warn', title: 'Генерация дизайна не подтверждена живым результатом', text: 'Путь Codex → HTML → PNG реализован, но сохранённых дизайн-результатов сейчас 0.' },
  ];
  const nextSteps = [
    ...(connectorProblems.length > 0 ? [{ priority: 'Срочно', tone: 'bad', title: 'Восстановить основной контур', text: `Проверить настройки и журналы: ${connectorProblems.map(({ label }) => label).join(', ')}.` }] : []),
    ...(aiProblems > 0 ? [{ priority: 'Срочно', tone: 'bad', title: 'Разобрать очередь ИИ', text: `${aiProblems} задач упали или зависли; без этого новые оценки и документы могут не завершаться.` }] : []),
    ...(deliveryProblems > 0 ? [{ priority: 'Срочно', tone: 'bad', title: 'Проверить журнал отправок', text: `${deliveryProblems} доставок имеют ошибку или неизвестный результат — повторять их автоматически нельзя.` }] : []),
    ...(!lateFlowStarted ? [{ priority: 'Следом', tone: 'warn', title: 'Обкатать FL → Telegram', text: 'Провести один контролируемый диалог через одноразовый токен и проверить, что клиент привязался к тому же заказу.' }] : []),
    ...(!discoveryStarted || !documentsStarted ? [{ priority: 'Следом', tone: 'warn', title: 'Пройти хвост воронки целиком', text: 'На одном проекте собрать подтверждённые требования, выпустить ТЗ и договор, затем проверить пакет передачи в работу.' }] : []),
    ...(!designsStarted ? [{ priority: 'Проверить', tone: 'warn', title: 'Принять одну дизайн-концепцию', text: 'Сгенерировать PNG через Codex → HTML → Chromium и визуально подтвердить, что результат пригоден заказчику.' }] : []),
  ];

  return <div className="architecturePanel">
    <div className="architectureHead">
      <div><span className="eyebrow">Живая архитектура</span><h2>Как работает фриланс-система</h2><p>Схема собирается из фактических статусов и счётчиков. Обновление — каждые 20 секунд вместе с Dashboard.</p></div>
      <div className="architectureLegend"><span><i className="legendOk" /> Работает</span><span><i className="legendWarn" /> Есть, но не обкатано</span><span><i className="legendBad" /> Требует внимания</span></div>
    </div>

    <div className="architectureStats">
      <ArchitectureStat label="FL → Telegram" value={architecture.handoffs_used || 0} hint="успешных переходов" tone={lateFlowStarted ? 'ok' : 'warn'} />
      <ArchitectureStat label="Сбор требований" value={architecture.discovery_leads || 0} hint="клиентов с фактами" tone={discoveryStarted ? 'ok' : 'warn'} />
      <ArchitectureStat label="ТЗ и договоры" value={numberOf(architecture.specifications) + numberOf(architecture.contracts)} hint="готовых документов" tone={documentsStarted ? 'ok' : 'warn'} />
      <ArchitectureStat label="Требует внимания" value={totalProblems} hint="подключения, ИИ и отправка" tone={totalProblems > 0 ? 'bad' : 'ok'} />
    </div>

    <div className="architecturePanHint">На телефоне тяните схему влево и вправо</div>
    <div className="architectureFlow" aria-label="Схема архитектуры фриланс-системы">
      {renderError ? <div className="architectureRenderError">{renderError}</div> : svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="architectureLoading">Строю схему…</div>}
    </div>

    <div className="architectureExplain">
      <div><b>1. Находит</b><span>FL.ru проверяется по расписанию. Повторы отбрасываются до обращения к ИИ.</span></div>
      <div><b>2. Оценивает</b><span>Hermes/Codex ставит балл. Вы решаете, нужен ли отклик — дорогой текст заранее не генерируется.</span></div>
      <div><b>3. Продаёт</b><span>Отклик и ответы создаются как черновики. Отправка — после вашего решения либо по точечной задаче на клиента.</span></div>
      <div><b>4. Собирает проект</b><span>Агент ведёт диалог, фиксирует требования, формирует ТЗ и договор, при необходимости переводит клиента в Telegram.</span></div>
      <div><b>5. Передаёт в работу</b><span>Подтверждённое ТЗ, файлы и дизайн-концепции становятся пакетом для выполнения проекта.</span></div>
    </div>

    <div className="architectureUnderhood">
      <div className="cardTitle"><h3>Что находится под капотом</h3><p>Эти компоненты обслуживают весь путь, но не усложняют основную схему.</p></div>
      <div className="architectureSystems">
        <div><i>AI</i><b>Hermes + Codex</b><span>Оценка заказа, смысл ваших команд, тексты, ТЗ, договор и HTML-макет дизайна.</span></div>
        <div><i>DB</i><b>PostgreSQL</b><span>Единая память: заказ, клиент, каналы, сообщения, решения, требования и журнал отправок.</span></div>
        <div><i>↻</i><b>Redis + очередь</b><span>Долгие задачи выполняются в фоне и не тормозят Dashboard.</span></div>
        <div><i>✓</i><b>Предохранители</b><span>Ручное одобрение; цена, сроки и договор всегда возвращаются вам. Активных точечных задач: {architecture.active_missions || 0}.</span></div>
      </div>
    </div>

    <div className="architectureAudit">
      <div className="cardTitle"><h3>Где сейчас косяки и пробелы</h3><p>Зелёное — подтверждено живыми данными. Жёлтое — функция есть, но реальная воронка её ещё не прошла.</p></div>
      <div className="architectureIssues">{gaps.map((gap) => <div className={`architectureIssue ${gap.tone}`} key={gap.title}><i /><div><b>{gap.title}</b><span>{gap.text}</span></div></div>)}</div>
    </div>

    <div className="architectureRoadmap">
      <div className="cardTitle"><h3>Что довести дальше</h3><p>Порядок меняется автоматически по живому состоянию системы.</p></div>
      {nextSteps.length > 0 ? <div className="architectureNextSteps">{nextSteps.map((step, index) => <div className={`architectureNext ${step.tone}`} key={step.title}><strong>{index + 1}</strong><div><span>{step.priority}</span><b>{step.title}</b><p>{step.text}</p></div></div>)}</div> : <div className="architectureAllClear"><b>Критических пробелов не видно</b><span>Все этапы проходили живыми данными, а основной контур сейчас здоров.</span></div>}
    </div>
  </div>;
}

function ArchitectureStat({ label, value, hint, tone }: { label: string; value: number | string; hint: string; tone: 'ok' | 'warn' | 'bad' }) {
  return <div className={`architectureStat ${tone}`}><span>{label}</span><b>{value}</b><small>{hint}</small></div>;
}

function architectureDiagram(data: any) {
  const architecture = data.architecture || {};
  const connectorOk = (name: string) => {
    const connector = data.connectors?.find((item: any) => item.connector === name);
    return Boolean(connector?.enabled && connector?.healthy);
  };
  const flClass = connectorOk('fl') ? 'ok' : 'bad';
  const codexClass = connectorOk('codex') ? 'ok' : 'bad';
  const telegramClass = connectorOk('telegram') ? 'ok' : 'bad';
  const handoffClass = numberOf(architecture.handoffs_used) > 0 ? 'ok' : 'warn';
  const discoveryClass = numberOf(architecture.discovery_leads) > 0 ? 'ok' : 'warn';
  const specificationClass = numberOf(architecture.specifications) > 0 ? 'ok' : 'warn';
  const contractClass = numberOf(architecture.contracts) > 0 ? 'ok' : 'warn';
  const designClass = numberOf(architecture.designs) > 0 ? 'ok' : 'warn';
  const deliveryClass = numberOf(architecture.delivery_failed_24h) > 0 ? 'bad' : 'ok';
  const aiClass = numberOf(architecture.ai_failed_24h) + numberOf(architecture.ai_stuck) > 0 ? 'bad' : codexClass;

  return `flowchart TB
    subgraph FIND["1 · Поиск и отбор заказов"]
      direction LR
      FL["FL.ru<br/>новые заказы"] --> SCAN["Мониторинг<br/>каждые 5 минут"] --> DEDUPE["Проверка дублей<br/>экономит токены"] --> SCORE["Hermes + Codex<br/>оценка заказа"] --> DASH{"Dashboard<br/>ваше решение"}
    end

    subgraph SALE["2 · Отклик и продажа"]
      direction LR
      DASH -->|подходит| RESPONSE["Отклик по кнопке<br/>+ подходящий кейс"] --> APPROVAL["Черновик<br/>ручная проверка"] --> DELIVERY["Отправка<br/>в FL.ru"] --> FLCHAT["Чат с клиентом<br/>агент отвечает"]
      DASH -->|не подходит| SKIP["Пропустить<br/>без расхода токенов"]
    end

    subgraph DISCOVERY["3 · Переход к проекту"]
      direction LR
      FLCHAT --> HANDOFF{"Нужен длинный<br/>диалог?"}
      HANDOFF -->|да| TOKEN["Одноразовый токен<br/>FL → Telegram"] --> TG["Telegram<br/>тот же клиент"]
      HANDOFF -->|нет| REQUIREMENTS["Сбор требований<br/>в чате FL.ru"]
      TG --> REQUIREMENTS --> SPEC["Реализуемое ТЗ<br/>без лишнего"] --> CONTRACT["Договор<br/>по подтверждённым данным"] --> BUILD["Передача<br/>в выполнение"]
      REQUIREMENTS --> DESIGN["Codex → HTML → PNG<br/>дизайн-концепции"] --> BUILD
    end

    classDef ok fill:#ecfdf3,stroke:#12b76a,color:#065f46,stroke-width:2px;
    classDef warn fill:#fffaeb,stroke:#f79009,color:#7a2e0e,stroke-width:2px;
    classDef bad fill:#fff1f0,stroke:#f04438,color:#912018,stroke-width:2px;
    classDef neutral fill:#f8f7ff,stroke:#818cf8,color:#3730a3,stroke-width:1.5px;
    class FL,SCAN ${flClass};
    class SCORE ${aiClass};
    class TG ${telegramClass};
    class TOKEN ${handoffClass};
    class REQUIREMENTS ${discoveryClass};
    class SPEC ${specificationClass};
    class CONTRACT ${contractClass};
    class DESIGN ${designClass};
    class DELIVERY ${deliveryClass};
    class DASH,RESPONSE,APPROVAL,FLCHAT,SKIP,HANDOFF,BUILD,DEDUPE neutral;`;
}

const numberOf = (value: unknown) => Number(value || 0);

function Sandbox({ openLead, notify }: { openLead: (id: string) => void; notify: (text: string) => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<any>();
  const [scenario, setScenario] = useState('web_service');
  const [clientMessage, setClientMessage] = useState('Спасибо. Нужны роли администратора и менеджера, интеграция с нашей PostgreSQL, уведомления в Telegram и запуск первой версии за 6 недель. Что ещё нужно уточнить?');
  const [telegramMessage, setTelegramMessage] = useState('Продолжим здесь. В первой версии используем существующего Telegram-бота: он принимает заявки и уведомляет менеджера о новой заявке и просроченном ответе. Администратор видит все сделки, менеджер — только назначенные ему.');
  const [busy, setBusy] = useState('');

  const loadRuns = async () => {
    const result = await api<any[]>('/sandbox');
    setRuns(result);
    if (!activeId && result[0]?.id) setActiveId(result[0].id);
  };
  const loadState = async () => {
    if (!activeId) { setState(undefined); return; }
    setState(await api(`/sandbox/${activeId}`));
  };
  useEffect(() => { void loadRuns(); }, []);
  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => { void loadState(); void loadRuns(); }, 5_000);
    return () => clearInterval(timer);
  }, [activeId]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      notify(success);
      window.setTimeout(() => { void loadState(); void loadRuns(); }, 700);
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(''); }
  };
  const create = () => run('create', async () => {
    const created = await api<{ id: string }>('/sandbox', { method: 'POST', body: JSON.stringify({ scenario }) });
    setActiveId(created.id);
  }, 'Тестовый заказ создан. Codex оценивает его в фоне.');

  const pendingDrafts = state?.drafts?.filter((draft: any) => draft.status === 'pending') || [];
  const handoffDone = Boolean(state?.handoffs?.some((handoff: any) => handoff.status === 'used'));
  const done = state?.steps?.filter((step: any) => step.done).length || 0;
  const total = state?.steps?.length || 13;

  return <section className="sandboxPage">
    <div className="pageTitle"><div><span className="eyebrow">Без расхода откликов FL.ru</span><h1>Полигон системы</h1><p>Здесь виден весь тест без сокращений: задача, решения Codex, точные тексты переписки, требования, ТЗ, договор, дизайн и технические доказательства.</p></div><span className="sandboxLock"><i /> FL.ru и клиенты недоступны из теста</span></div>

    <div className="sandboxHero">
      <div><b>Создать новую репетицию</b><span>Выберите тип заказа. Он появится только здесь и не испортит боевую статистику.</span></div>
      <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
        <option value="web_service">SaaS и личный кабинет</option>
        <option value="ecommerce">Интернет-магазин и 1С</option>
        <option value="vague">Нечёткий заказ — проверка вопросов</option>
      </select>
      <button className="primary" disabled={Boolean(busy)} onClick={create}>{busy === 'create' ? 'Создаю…' : 'Начать полный тест'}</button>
    </div>

    {runs.length > 0 && <div className="sandboxRuns">{runs.map((item) => <button className={activeId === item.id ? 'active' : ''} key={item.id} onClick={() => setActiveId(item.id)}><b>{item.title.replace('[ТЕСТ] ', '')}</b><span>{item.score === null ? 'Оценивается' : `${item.score}/100`} · {relativeTime(item.updated_at)}</span></button>)}</div>}

    {!activeId ? <Card><Empty text="Создайте первый тестовый заказ — реальные отклики FL.ru не расходуются." /></Card> : !state ? <Loading /> : <>
      <div className="sandboxProgress"><div><span>Пройдено этапов</span><b>{done} из {total}</b></div><i><em style={{ width: `${Math.round(done / total * 100)}%` }} /></i><small>{done === total ? 'Полный сценарий пройден' : 'Двигайтесь сверху вниз; долгие операции обновятся автоматически.'}</small></div>

      <div className="sandboxWorkspace">
        <div className="sandboxSteps"><strong>Покрытие прогона</strong>{state.steps.map((step: any, index: number) => <a className={`${step.done ? 'done' : ''} ${step.failed ? 'failed' : ''}`} href={`#sandbox-step-${step.key}`} key={step.key}><i>{step.done ? '✓' : step.failed ? '!' : index + 1}</i><span>{step.label}</span></a>)}</div>

        <div className="sandboxActions">
          <Card title="1. Отклик и безопасная отправка" subtitle="Используются те же генератор, ручное одобрение и реестр доставки, что для FL.ru.">
            <div className="sandboxButtons">
              <button disabled={Boolean(busy) || state.lead.analysis_state !== 'completed'} onClick={() => run('draft', () => api(`/sandbox/${activeId}/draft`, { method: 'POST' }), 'Отклик поставлен в очередь')}>{busy === 'draft' ? 'Генерирую…' : 'Создать отклик'}</button>
            </div>
            {pendingDrafts.map((draft: any) => <div className="sandboxDraft" key={draft.id}><small>{sandboxDraftLabel(draft)}</small><p>{draft.content}</p><button className="primary" disabled={Boolean(busy)} onClick={() => run(`approve-${draft.id}`, () => api(`/drafts/${draft.id}/approve`, { method: 'POST' }), 'Отправка отрепетирована: наружу ничего не ушло')}>{busy === `approve-${draft.id}` ? 'Проверяю…' : 'Одобрить и безопасно отправить'}</button></div>)}
          </Card>

          <Card title="2. Сообщение клиента в чате FL.ru" subtitle="Введите реплику клиента. Агент сохранит её, выделит требования и подготовит точный ответ.">
            <textarea rows={5} value={clientMessage} onChange={(event) => setClientMessage(event.target.value)} />
            <button disabled={Boolean(busy) || !clientMessage.trim()} onClick={() => run('message', () => api(`/sandbox/${activeId}/client-message`, { method: 'POST', body: JSON.stringify({ content: clientMessage }) }), 'Сообщение принято, агент готовит ответ')}>{busy === 'message' ? 'Обрабатываю…' : 'Отправить от тестового клиента'}</button>
          </Card>

          <Card title="3. Переход и общение в Telegram" subtitle="Сначала одноразовый код связывает каналы, затем сообщение проходит через боевой Telegram-ingest с искусственным chat id.">
            <div className="sandboxButtons"><button disabled={Boolean(busy) || handoffDone} onClick={() => run('handoff', () => api(`/sandbox/${activeId}/handoff`, { method: 'POST' }), 'Связка FL → Telegram создана без внешнего сообщения')}>{handoffDone ? 'FL → Telegram связан ✓' : 'Связать FL → Telegram'}</button></div>
            <textarea rows={5} value={telegramMessage} onChange={(event) => setTelegramMessage(event.target.value)} disabled={!handoffDone} />
            <button disabled={Boolean(busy) || !handoffDone || !telegramMessage.trim()} onClick={() => run('telegram-message', () => api(`/sandbox/${activeId}/telegram-message`, { method: 'POST', body: JSON.stringify({ content: telegramMessage }) }), 'Telegram-сообщение принято, агент готовит ответ по общей истории')}>{busy === 'telegram-message' ? 'Обрабатываю…' : 'Отправить от клиента в тестовый Telegram'}</button>
          </Card>

          <Card title="4. Итоговые материалы" subtitle="ТЗ, данные договора, пакет Codex и PNG создаются боевыми механизмами из накопленного контекста.">
            <div className="sandboxButtons wrap">
              <button disabled={Boolean(busy)} onClick={() => run('documents', () => api(`/sandbox/${activeId}/documents`, { method: 'POST' }), 'ТЗ, договор и пакет Codex поставлены в очередь')}>Собрать ТЗ, договор и пакет Codex</button>
              <button disabled={Boolean(busy)} onClick={() => run('design', () => api(`/sandbox/${activeId}/design`, { method: 'POST' }), 'Две PNG-концепции поставлены в очередь')}>Создать 2 PNG-концепции</button>
            </div>
          </Card>

          <div className="sandboxFooter"><button onClick={() => document.getElementById('sandbox-full-report')?.scrollIntoView({ behavior: 'smooth' })}>Перейти к полному протоколу ↓</button><button onClick={() => openLead(activeId)}>Открыть карточку сделки</button><button className="danger soft" onClick={() => run('archive', () => api(`/sandbox/${activeId}/archive`, { method: 'POST' }), 'Тестовый прогон архивирован')}>Архивировать прогон</button></div>
        </div>
      </div>

      <SandboxFullReport state={state} done={done} total={total} notify={notify} />
    </>}
  </section>;
}

function SandboxFullReport({ state, done, total, notify }: { state: any; done: number; total: number; notify: (text: string) => void }) {
  const analysis = state.lead.analysis || {};
  const understanding = analysis.understanding || {};
  const groupedRequirements = useMemo(() => state.requirements.reduce((result: Record<string, any[]>, item: any) => {
    (result[item.category] ||= []).push(item);
    return result;
  }, {}), [state.requirements]);
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); notify(`${label} скопирован`); }
    catch { notify('Не удалось скопировать в этом браузере'); }
  };
  const flMessages = state.messages.filter((message: any) => message.channel === 'fl');
  const telegramMessages = state.messages.filter((message: any) => message.channel === 'telegram');
  const confirmed = state.requirements.filter((item: any) => item.status === 'confirmed').length;
  const open = state.requirements.filter((item: any) => item.status === 'open').length;
  return <div className="sandboxReport" id="sandbox-full-report">
    <div className="sandboxReportHead"><div><span className="eyebrow">Проверяемый протокол</span><h2>Что именно произошло в этом тесте</h2><p>Ниже не описание «как должно быть», а содержимое выбранного прогона из PostgreSQL, реестра доставок и очереди ИИ.</p></div><span className={`sandboxVerdict ${done === total ? 'ok' : ''}`}>{done === total ? 'Полный прогон пройден' : `Пройдено ${done} из ${total}`}</span></div>

    <div className="sandboxMetrics">
      <SandboxMetric label="Оценка заказа" value={`${state.lead.score ?? '—'}/100`} hint={`уверенность ${state.lead.confidence ?? '—'}%`} />
      <SandboxMetric label="Предложенная цена" value={money(state.lead.recommended_price)} hint={`срок ${state.lead.recommended_days ?? '—'} дней`} />
      <SandboxMetric label="Требования" value={String(state.requirements.length)} hint={`${confirmed} подтверждено · ${open} открыто`} />
      <SandboxMetric label="Внешних отправок" value={String(state.safety?.escaped_deliveries ?? '—')} hint={`${state.safety?.captured_deliveries || 0} перехвачено полигоном`} tone={state.safety?.escaped_deliveries ? 'bad' : 'ok'} />
    </div>

    <div className="grid two sandboxBriefGrid">
      <Card title="Исходная задача" subtitle="Ровно то, что было подано системе как заказ">
        <h3 className="sandboxTaskTitle">{state.lead.title.replace('[ТЕСТ] ', '')}</h3>
        <p className="sandboxTaskText">{state.lead.description}</p>
        <div className="sandboxFactRows"><span>Бюджет<b>{state.lead.budget_text || '—'}</b></span><span>Создан<b>{exactTime(state.lead.created_at)}</b></span><span>Источник<b>Изолированный sandbox</b></span></div>
      </Card>
      <Card title="Что понял Codex" subtitle="Результат первичной оценки заказа">
        <p className="sandboxTaskText">{understanding.summary || analysis.fit_reason || 'Анализ ещё не завершён.'}</p>
        {analysis.fit_reason && <p className="sandboxCallout"><b>Почему подходит:</b> {analysis.fit_reason}</p>}
        <div className="sandboxFactRows"><span>Тип проекта<b>{understanding.project_kind || '—'}</b></span><span>Уровень цены<b>{analysis.pricing_level || '—'}</b></span><span>Риск выполнения<b>{analysis.delivery_risk ?? '—'}/100</b></span></div>
      </Card>
    </div>

    <Card title="Границы, риски и вопросы оценки" subtitle="Так видно, что ИИ не просто поставил балл, а отделил известное от неизвестного.">
      <div className="sandboxAnalysisColumns">
        <SandboxList title="Подтверждённый объём" items={understanding.confirmed_scope || []} tone="ok" />
        <SandboxList title="Не входит в оценку" items={understanding.wishlist_or_future_scope || []} tone="neutral" />
        <SandboxList title="Риски" items={analysis.risks || []} tone="warn" />
        <SandboxList title="Что нужно уточнить" items={analysis.questions || []} tone="question" />
      </div>
    </Card>

    <section className="sandboxProtocol">
      <div className="sectionHeading"><span className="eyebrow">Все контрольные точки</span><h2>Пошаговый журнал теста</h2><p>У каждого шага есть цель и конкретное доказательство из этого прогона.</p></div>
      <div className="sandboxProtocolList">{state.steps.map((step: any, index: number) => <article id={`sandbox-step-${step.key}`} className={`${step.done ? 'done' : ''} ${step.failed ? 'failed' : ''}`} key={step.key}><i>{step.done ? '✓' : step.failed ? '!' : index + 1}</i><div><span>{step.done ? 'Пройдено' : step.failed ? 'Ошибка' : 'Ожидает'}</span><h3>{step.label}</h3><p>{step.description}</p><small>{step.evidence}</small></div></article>)}</div>
    </section>

    <Card title="Переписка FL.ru" subtitle="Точные входящие и исходящие тексты в хронологическом порядке">
      <SandboxMessageThread messages={flMessages} empty="В FL-чате сообщений пока нет." />
    </Card>

    <div className="sandboxHandoffBand">
      <div><span>FL.ru</span><b>→</b><span>тот же клиент и сделка</span><b>→</b><span>Telegram</span></div>
      {state.handoffs.length ? state.handoffs.map((handoff: any) => <p key={handoff.token}><b>Код {handoff.token}</b> · {handoff.status === 'used' ? `использован ${exactTime(handoff.used_at)}` : `статус ${handoff.status}`} · chat id искусственный и не существует в Telegram.</p>) : <p>Переход ещё не запускался.</p>}
    </div>

    <Card title="Переписка Telegram" subtitle="Тексты проходят через боевой обработчик Telegram, но наружу не отправляются">
      <SandboxMessageThread messages={telegramMessages} empty="Реального Telegram-диалога в этом прогоне ещё не было. Одна связка канала не считается проверкой общения." />
      {state.turns.filter((turn: any) => turn.channel === 'telegram').map((turn: any) => <details className="sandboxTurn" key={turn.id}><summary>Как агент разобрал Telegram-реплику</summary><div className="sandboxFactRows"><span>Стадия<b>{turn.stage_before} → {turn.stage_after}</b></span><span>Намерение<b>{turn.intent}</b></span></div><p>{turn.summary}</p>{turn.decision?.riskFlags?.length > 0 && <SandboxList title="Риски этого ответа" items={turn.decision.riskFlags} tone="warn" />}</details>)}
    </Card>

    <Card title="Все черновики и решения" subtitle="Содержимое до отправки, канал, режим и итоговый статус">
      <div className="sandboxDraftArchive">{state.drafts.map((draft: any) => <details key={draft.id} open={draft.status === 'pending'}><summary><span>{sandboxDraftLabel(draft)}</span><Status value={draft.status} /></summary><p>{draft.content}</p><div className="sandboxFactRows"><span>Создан<b>{exactTime(draft.created_at)}</b></span><span>Канал<b>{draft.channel.toUpperCase()}</b></span><span>Решение<b>{draft.metadata?.autonomy?.decision || 'ручное'}</b></span></div></details>)}</div>
    </Card>

    <Card title="Извлечённые требования" subtitle="Статус, уверенность и фактическое значение каждого требования">
      {state.requirements.length === 0 ? <Empty text="Требования ещё не извлечены." /> : <div className="sandboxRequirements">{Object.entries(groupedRequirements).map(([category, items]) => <section key={category}><h4>{category}</h4>{(items as any[]).map((item: any) => <div key={`${item.category}:${item.slug}`}><span className={`requirementState ${item.status}`}>{sandboxRequirementStatus(item.status)}</span><div><b>{item.title}</b><p>{sandboxValue(item.value)}</p><small>Уверенность {item.confidence}%{item.source_message_id ? ' · подтверждается сообщением' : ''}</small></div></div>)}</section>)}</div>}
    </Card>

    <Card title="Итоговые документы" subtitle="Полный текст ТЗ, подтверждённые поля договора и handoff-пакет для Codex">
      {state.documents.length === 0 ? <Empty text="Документы ещё не создавались." /> : <div className="sandboxDocuments">{state.documents.map((document: any) => <details key={document.id}><summary><div><b>{sandboxDocumentLabel(document.kind)}</b><small>Версия {document.version} · {document.markdown?.length || 0} знаков · {exactTime(document.created_at)}</small></div><span>Показать полностью</span></summary><div className="sandboxDocumentActions"><button onClick={() => void copy(document.markdown || '', sandboxDocumentLabel(document.kind))}>Копировать текст</button>{document.downloadable && <a className="button" href={`${BASE}/api/documents/${document.id}/download`}>Скачать DOCX</a>}</div><pre>{document.markdown || 'Текст хранится только в DOCX.'}</pre></details>)}</div>}
    </Card>

    <Card title="Дизайн-концепции" subtitle="Фактические PNG 1536×1024, созданные в этом прогоне">
      {state.designs.length === 0 ? <Empty text="Концепции ещё не создавались." /> : <div className="sandboxDesigns">{state.designs.map((asset: any) => <figure key={asset.id}><img src={asset.preview_url} alt={asset.metadata?.label || 'Тестовая дизайн-концепция'} loading="lazy" /><figcaption><b>{asset.metadata?.label || `Вариант ${asset.metadata?.variant || ''}`}</b><span>{asset.metadata?.model || '—'} · {asset.metadata?.size || '—'} · {Math.round(asset.bytes / 1024)} КБ</span><a href={asset.preview_url} target="_blank" rel="noreferrer">Открыть PNG</a></figcaption></figure>)}</div>}
    </Card>

    <div className="grid two sandboxEvidenceGrid">
      <Card title="Доказательство изоляции" subtitle="Что случилось с попытками отправки">
        <div className={`sandboxSafety ${state.safety?.escaped_deliveries === 0 ? 'ok' : 'bad'}`}><b>{state.safety?.escaped_deliveries === 0 ? '✓ Наружу ничего не ушло' : '! Обнаружена подозрительная доставка'}</b><p>Перехвачено: {state.safety?.captured_deliveries || 0}. Внешних записей: {state.safety?.escaped_deliveries || 0}.</p></div>
        {state.deliveries.map((delivery: any) => <div className="sandboxDelivery" key={delivery.id}><span>{delivery.channel.toUpperCase()}</span><div><b>{delivery.status}</b><small>{delivery.external_id || '—'} · попыток {delivery.attempt_count}</small><p>{delivery.error}</p></div></div>)}
      </Card>
      <Card title="Очередь ИИ" subtitle="Какие реальные задачи выполнил Hermes/Codex">
        {state.ai_tasks.length === 0 ? <Empty text="ИИ-задачи этого прогона ещё не зафиксированы." /> : <div className="sandboxAiTasks">{state.ai_tasks.map((task: any) => <div key={task.id}><span className={`requirementState ${task.status === 'completed' ? 'confirmed' : task.status === 'failed' ? 'open' : 'assumed'}`}>{task.status}</span><div><b>{task.kind}</b><small>{exactTime(task.created_at)}{task.completed_at ? ` · завершено ${exactTime(task.completed_at)}` : ''}</small>{task.error && <p>{task.error}</p>}</div></div>)}</div>}
      </Card>
    </div>

    <Card title="Технический журнал" subtitle="События базы и worker в порядке выполнения">
      <div className="sandboxActivityLog">{state.activities.map((activity: any) => <div key={`${activity.created_at}:${activity.action}`}><time>{exactTime(activity.created_at)}</time><span>{activity.actor}</span><b>{sandboxActionLabel(activity.action)}</b><code>{JSON.stringify(activity.details)}</code></div>)}</div>
    </Card>
  </div>;
}

function SandboxMetric({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) {
  return <div className={`sandboxMetric ${tone}`}><span>{label}</span><b>{value}</b><small>{hint}</small></div>;
}

function SandboxList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return <div className={`sandboxList ${tone}`}><h4>{title}<span>{items.length}</span></h4>{items.length ? <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p>Нет данных.</p>}</div>;
}

function SandboxMessageThread({ messages, empty }: { messages: any[]; empty: string }) {
  if (!messages.length) return <Empty text={empty} />;
  return <div className="sandboxThread">{messages.map((message: any) => <article className={message.direction} key={message.id}><small>{message.direction === 'outbound' ? 'Агент / владелец' : 'Тестовый заказчик'} · {message.channel.toUpperCase()} · {exactTime(message.created_at)}</small><p>{message.content}</p></article>)}</div>;
}

const exactTime = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const sandboxDraftLabel = (draft: any) => draft.metadata?.mode === 'response' || draft.kind === 'initial_response' ? 'Первичный отклик FL.ru' : `Ответ в ${draft.channel === 'telegram' ? 'Telegram' : 'FL-чате'}`;
const sandboxDocumentLabel = (kind: string) => ({ specification: 'Техническое задание', contract_data: 'Данные для договора', contract: 'Договор DOCX', codex_handoff: 'Пакет передачи в Codex' } as Record<string, string>)[kind] || kind;
const sandboxRequirementStatus = (status: string) => ({ confirmed: 'Подтверждено', open: 'Нужно уточнить', assumed: 'Допущение', rejected: 'Отклонено', not_applicable: 'Не требуется' } as Record<string, string>)[status] || status;
const sandboxValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'Значение пока не зафиксировано';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return JSON.stringify(value, null, 2);
};
const sandboxActionLabel = (action: string) => ({ sandbox_created: 'Создан тестовый заказ', draft_created: 'Создан черновик', sandbox_delivery_captured: 'Внешняя отправка перехвачена', sandbox_client_message: 'Принято сообщение FL', sandbox_handoff_used: 'Связан Telegram-канал', sandbox_telegram_message: 'Принято сообщение Telegram', documents_generated: 'Созданы документы', sandbox_design_ready: 'Созданы PNG-концепции' } as Record<string, string>)[action] || action.replaceAll('_', ' ');

function FunnelRow({ label, value, max, accent = false }: { label: string; value: number; max: number; accent?: boolean }) {
  const width = value === 0 ? 0 : Math.max(7, Math.round(value / max * 100));
  return <div className={`funnelRow ${accent ? 'accent' : ''}`}><div><span>{label}</span><b>{value}</b></div><i><em style={{ width: `${width}%` }} /></i></div>;
}

function Connector({ connector }: { connector: any }) {
  const active = connector.connector === 'codex' ? connector.healthy : connector.enabled && connector.healthy;
  return <div className="connector"><span className={active ? 'dot ok' : 'dot'} /><div><b>{labelConnector(connector.connector)}</b><small>{connector.status_text}</small></div><span className={`state ${active ? 'ok' : ''}`}>{active ? 'Активен' : connector.enabled ? 'Проверка' : 'Выкл.'}</span></div>;
}

function Leads({ openLead, notify }: { openLead: (id: string) => void; notify: (text: string) => void }) {
  const [leads, setLeads] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('qualified');
  const load = () => api<any[]>('/leads').then(setLeads);
  useEffect(() => { void load(); }, []);
  const filtered = useMemo(() => leads.filter((lead) => (filter === 'all' || lead.status === filter) && lead.title.toLowerCase().includes(query.toLowerCase())), [leads, filter, query]);
  return <section><div className="pageTitle"><div><span className="eyebrow">База заказов</span><h1>Заказы</h1><p>{leads.length} всего · {leads.filter((lead) => lead.status === 'qualified').length} подходят</p></div><button className="primary small" onClick={() => setShow(true)}>+ Добавить</button></div>
    <div className="toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по названию" /><div className="chips">{[['qualified','Подходят'],['contacted','В работе'],['new','Оцениваются'],['all','Все'],['rejected','Отсеяны']].map(([value,label]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
    <Card><LeadRows leads={filtered} openLead={openLead} /></Card>
    {show && <Modal close={() => setShow(false)}><NewLead done={() => { setShow(false); load(); notify('Лид добавлен и отправлен на анализ'); }} /></Modal>}
  </section>;
}

function NewLead({ done }: { done: () => void }) {
  const [form, setForm] = useState({ title: '', description: '', budgetText: '', url: '' });
  const submit = async (event: React.FormEvent) => { event.preventDefault(); await api('/leads', { method: 'POST', body: JSON.stringify(form) }); done(); };
  return <form onSubmit={submit}><h2>Новый лид</h2><input required placeholder="Название" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
    <textarea placeholder="Описание" rows={6} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
    <input placeholder="Бюджет" value={form.budgetText} onChange={(event) => setForm({ ...form, budgetText: event.target.value })} />
    <input placeholder="Ссылка" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /><button className="primary">Добавить</button></form>;
}

function Chats({ openChat }: { openChat: (id: string) => void }) {
  const [chats, setChats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const load = () => api<any[]>('/chats').then(setChats).finally(() => setLoading(false));
  useEffect(() => { void load(); const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  const visible = useMemo(() => chats.filter((chat) => `${chat.title} ${chat.last_message || ''}`.toLowerCase().includes(query.toLowerCase())), [chats, query]);
  if (loading) return <Loading />;
  return <section><div className="pageTitle"><div><span className="eyebrow">Переписка FL.ru</span><h1>Чаты</h1><p>{chats.length} диалогов · обновляются каждые 5 минут</p></div><span className="liveBadge"><i /> Онлайн</span></div>
    <div className="toolbar chatToolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по чатам" /></div>
    <div className="chatList">{visible.length === 0 ? <Empty text="Чатов пока нет" /> : visible.map((chat) => <button key={chat.id} onClick={() => openChat(chat.id)}>
      <span className="chatAvatar">{String(chat.title || 'F').trim().charAt(0).toUpperCase()}</span>
      <span className="chatCopy"><span><b>{chat.title}</b><time>{relativeTime(chat.last_message_at || chat.updated_at)}</time></span><small>{chat.last_direction === 'outbound' ? 'Вы: ' : ''}{chat.last_message || 'Диалог синхронизирован'}</small></span>
      <span className="chatMeta">{Number(chat.pending_drafts) > 0 && <em>Ответ готов</em>}<i>›</i></span>
    </button>)}</div>
  </section>;
}

function Approvals({ notify }: { notify: (text: string) => void }) {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [history, setHistory] = useState(false);
  const [kind, setKind] = useState<'response' | 'message'>('response');
  const load = () => api<any[]>('/drafts').then(setDrafts);
  useEffect(() => { void load(); const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  const activeDrafts = drafts.filter((draft) => history || ['pending', 'approved', 'sending'].includes(draft.status));
  const visible = activeDrafts.filter((draft) => draft.draft_type === kind);
  const responseCount = activeDrafts.filter((draft) => draft.draft_type === 'response').length;
  const messageCount = activeDrafts.filter((draft) => draft.draft_type === 'message').length;
  const action = async (id: string, name: string) => { try { await api(`/drafts/${id}/${name}`, { method: 'POST' }); notify(name === 'approve' ? 'Одобрено и поставлено в отправку' : 'Черновик отклонён'); load(); } catch (error) { notify((error as Error).message); load(); } };
  return <section><div className="pageTitle"><div><span className="eyebrow">Ваше решение</span><h1>На проверку</h1><p>Отклики на проекты и ответы в чатах больше не смешиваются.</p></div><button className="ghost" onClick={() => setHistory(!history)}>{history ? 'Скрыть историю' : 'Показать историю'}</button></div>
    <div className="approvalTabs"><button className={kind === 'response' ? 'active' : ''} onClick={() => setKind('response')}>Отклики на проекты <b>{responseCount}</b></button><button className={kind === 'message' ? 'active' : ''} onClick={() => setKind('message')}>Сообщения клиентам <b>{messageCount}</b></button></div>
    <div className="drafts">{visible.length === 0 ? <Card><Empty text="Новых черновиков нет" /></Card> : visible.map((draft) => <DraftCard key={draft.id} draft={draft} reload={load} action={action} notify={notify} />)}</div>
  </section>;
}

function DraftCard({ draft, reload, action, notify }: any) {
  const [content, setContent] = useState(draft.content);
  const [instructions, setInstructions] = useState('');
  const [price, setPrice] = useState(String(draft.recommended_price || ''));
  const [days, setDays] = useState(String(draft.recommended_days || ''));
  const [regenerating, setRegenerating] = useState(false);
  const editable = ['pending','failed','stale'].includes(draft.status);
  const review = draft.metadata?.review;
  const reviewFlags: string[] = Array.isArray(review?.flags) ? review.flags : [];
  const unverifiedTechnologies: string[] = Array.isArray(review?.technology_fit?.unverified)
    ? review.technology_fit.unverified
    : [];
  const voiceprintSamples = Number(review?.voiceprint?.sampleCount || 0);
  const voiceprintMinimum = Number(review?.voiceprint?.minimumSamples || 10);
  const save = async () => { await api(`/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }); notify('Изменения сохранены — требуется новое одобрение'); reload(); };
  const regenerate = async () => {
    setRegenerating(true);
    try {
      const body: Record<string, unknown> = { instructions };
      if (draft.draft_type === 'response') {
        body.recommendedPrice = Number(price);
        body.recommendedDays = Number(days);
      }
      await api(`/drafts/${draft.id}/regenerate`, { method: 'POST', body: JSON.stringify(body) });
      notify('Перегенерация запущена. Новый вариант появится здесь и придёт push');
      setInstructions('');
      reload();
    } catch (error) { notify((error as Error).message); } finally { setRegenerating(false); }
  };
  return <article className="draft"><div className="draftHead"><div><span className={`badge ${draft.channel}`}>{draft.draft_type === 'message' ? 'Сообщение' : 'Отклик'}</span><b>{draft.lead_title}</b></div><Status value={draft.status} /></div>
    <div className="facts"><span>Релевантность <b>{draft.score ?? '—'}/100</b></span><span>Цена <b>{money(draft.recommended_price)}</b></span><span>Срок <b>{draft.recommended_days || '—'} дн.</b></span></div>
    {reviewFlags.length > 0 && <div className="proposalWarning"><b>Нужна ручная проверка перед отправкой</b>
      {reviewFlags.includes('technology_fit_unverified') && <span>Нет подтверждённого кейса или записи в профиле по технологии: {unverifiedTechnologies.join(', ')}. Черновик не должен заявлять такой опыт.</span>}
      {reviewFlags.includes('availability_missing') && <span>Дата старта не заполнена в настройках. Система её не выдумывает — укажите доступность или добавьте её вручную.</span>}
      {reviewFlags.includes('voiceprint_insufficient') && <span>Голос владельца ещё не откалиброван: ручных правок {voiceprintSamples} из минимальных {voiceprintMinimum}. Сохранённые вами правки будут пополнять корпус.</span>}
    </div>}
    <textarea rows={8} value={content} disabled={!editable} onChange={(event) => setContent(event.target.value)} />
    {draft.error && <div className="error">{draft.error}</div>}
    {editable && <div className="regenerateBox"><div><b>Не нравится? Напишите, что исправить</b><small>Например: короче, больше уверенности, упомянуть кейс, убрать технические детали.</small></div><textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Ваши корректировки для нового варианта" />
      {draft.draft_type === 'response' && <div className="regenerateNumbers"><label>Цена, ₽<input type="number" min="1" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Срок, дней<input type="number" min="1" value={days} onChange={(event) => setDays(event.target.value)} /></label></div>}
      <button className="regenButton" disabled={regenerating || (draft.draft_type === 'message' && !instructions.trim())} onClick={regenerate}>{regenerating ? 'Перегенерирую…' : '↻ Перегенерировать с правками'}</button><small>Текущий вариант останется до готовности нового. Ничего не отправится автоматически.</small></div>}
    {editable && <div className="actions"><button onClick={save}>Сохранить</button>{draft.status === 'pending' && <button className="primary" onClick={() => action(draft.id, 'approve')}>✓ Одобрить и отправить</button>}<button className="danger" onClick={() => action(draft.id, 'reject')}>Отклонить</button></div>}
  </article>;
}

function ChatDetail({ id, back, notify }: { id: string; back: () => void; notify: (text: string) => void }) {
  const [data, setData] = useState<any>();
  const [agent, setAgent] = useState<any>();
  const [content, setContent] = useState('');
  const [question, setQuestion] = useState('');
  const [agentAnswer, setAgentAnswer] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => Promise.all([
    api(`/leads/${id}`),
    api(`/leads/${id}/agent`),
  ]).then(([leadData, agentData]) => {
    setData(leadData);
    setAgent(agentData);
  });
  useEffect(() => { void load(); const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, [id]);
  const pending = data?.drafts?.find((draft: any) => draft.status === 'pending');
  useEffect(() => { setContent(pending?.content || ''); }, [pending?.id]);
  if (!data) return <Loading />;
  const lead = data.lead;
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); notify(message); window.setTimeout(load, 1200); } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  const makeDraft = () => run(() => api(`/leads/${id}/draft`, { method: 'POST', body: '{}' }), 'Готовлю ответ — push придёт, когда он будет готов');
  const saveDraft = () => run(() => api(`/drafts/${pending.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }), 'Правки сохранены');
  const approve = () => run(() => api(`/drafts/${pending.id}/approve`, { method: 'POST' }), 'Ответ одобрен и отправляется');
  const reject = () => run(() => api(`/drafts/${pending.id}/reject`, { method: 'POST' }), 'Ответ отклонён');
  const askAgent = async () => {
    if (!question.trim()) return;
    setAgentBusy(true);
    try {
      const result = await api<any>(`/leads/${id}/agent/query`, {
        method: 'POST',
        body: JSON.stringify({ question }),
      });
      setAgentAnswer(result.answer || 'Ответ не получен');
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };
  return <section className="chatScreen"><button className="back" onClick={back}>← Все чаты</button><div className="pageTitle chatTitle"><div><span className="eyebrow">{lead.source === 'telegram' ? 'Диалог Telegram' : 'Диалог FL.ru'}</span><h1>{lead.title}</h1><p>{data.messages.length} сообщений · обновлён {relativeTime(lead.updated_at)}</p></div>{lead.url && <a className="button ghost" href={lead.url} target="_blank" rel="noreferrer">Открыть FL.ru</a>}</div>
    <div className="chatWorkspace"><div className="conversationColumn">
      {pending ? <article className="replyReady"><div className="replyReadyHead"><div><span>Готово к отправке</span><h2>Ответ клиенту</h2></div><Status value={pending.status} /></div><textarea rows={7} value={content} onChange={(event) => setContent(event.target.value)} /><div className="actions"><button onClick={saveDraft} disabled={busy}>Сохранить правки</button><button className="primary" onClick={approve} disabled={busy}>✓ Одобрить и отправить</button><button className="danger" onClick={reject} disabled={busy}>Отклонить</button></div></article> : <div className="replyEmpty"><div><b>Нужно ответить клиенту?</b><small>Система подготовит ответ в вашем стиле. Без одобрения он не уйдёт.</small></div><button className="primary" onClick={makeDraft} disabled={busy}>{busy ? 'Готовлю…' : 'Подготовить ответ'}</button></div>}
      <Card title="Переписка" subtitle="Последние сообщения снизу"><div className="messageThread">{data.messages.length === 0 ? <Empty text="Сообщений пока нет" /> : data.messages.slice(-50).map((message: any) => <div key={message.id} className={`message ${message.direction}`}><small>{message.direction === 'outbound' ? 'Вы' : 'Клиент'} · {new Date(message.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small><p>{message.content}</p></div>)}</div></Card>
    </div><aside className="chatContext"><Card title="Агент сделки" subtitle="Можно спрашивать обычными словами"><div className="contextFacts"><span>Стадия<b>{agent?.stage || '—'}</b></span><span>Интервью<b>{agent?.discoveryReadiness ?? 0}%</b></span><span>Готовность к разработке<b>{agent?.buildReadiness ?? 0}%</b></span></div>{agent?.nextAction && <p className="hint"><b>Следующий шаг:</b> {agent.nextAction}</p>}<textarea rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Например: что клиент хочет и какие вопросы ещё не закрыты?" /><button className="primary" disabled={agentBusy || !question.trim()} onClick={askAgent}>{agentBusy ? 'Анализирую…' : 'Спросить агента'}</button>{agentAnswer && <p className="pre">{agentAnswer}</p>}</Card><Card title="Заказ и условия"><div className="contextFacts"><span>Этап<b>{labelStatus(lead.status)}</b></span><span>Релевантность<b>{lead.score ?? '—'}/100</b></span><span>Цена<b>{money(lead.recommended_price)}</b></span><span>Срок<b>{lead.recommended_days ? `${lead.recommended_days} дней` : '—'}</b></span></div>{lead.description && lead.description !== 'Диалог FL.ru' && <details><summary>Описание заказа</summary><p className="pre">{lead.description}</p></details>}<div className="actions"><button onClick={() => run(() => api(`/leads/${id}/documents`, { method: 'POST', body: '{}' }), 'ТЗ, договор и пакет для Codex готовятся')}>Сформировать пакет проекта</button></div></Card><Card title="Правило отправки"><p className="hint">Рискованные ответы, цены, сроки и договорённости всегда требуют вашего подтверждения.</p></Card></aside></div>
  </section>;
}

function LeadDetail({ id, back, notify }: { id: string; back: () => void; notify: (text: string) => void }) {
  const [data, setData] = useState<any>();
  const load = () => api(`/leads/${id}`).then(setData);
  useEffect(() => { void load(); }, [id]);
  if (!data) return <Loading />;
  const lead = data.lead;
  const project = lead.requirements?.project || {};
  const job = async (path: string, message: string) => { await api(`/leads/${id}/${path}`, { method: 'POST', body: '{}' }); notify(message); window.setTimeout(load, 1500); };
  return <section><button className="back" onClick={back}>← Назад</button><div className="pageTitle leadTitle"><div><span className="eyebrow">{labelStatus(lead.status)}</span><h1>{lead.title}</h1><p>{lead.source.toUpperCase()} · обновлён {relativeTime(lead.updated_at)}</p></div><Score value={lead.score} /></div>
    <div className="facts bigfacts"><span>Цена <b>{money(lead.recommended_price)}</b></span><span>Срок <b>{lead.recommended_days || '—'} дней</b></span><span>Уверенность <b>{lead.confidence ?? '—'}%</b></span></div>
    <div className="actions wrap"><button onClick={() => job('analyze','Повторный анализ запущен')}>Обновить анализ</button><button onClick={() => job('draft','Черновик создаётся')}>Создать ответ</button><button className="primary" onClick={() => job('documents','ТЗ и данные договора создаются')}>Сформировать ТЗ</button>{lead.url && <a className="button" href={lead.url} target="_blank" rel="noreferrer">Открыть FL.ru</a>}</div>
    {project.detail_parsed_at && <div className="projectSignals"><span>Карточка проекта<b>прочитана полностью</b></span><span>Откликов<b>{project.response_count ?? '—'}</b></span><span>Вилка исполнителей<b>{project.response_price_min ? `${money(project.response_price_min)} — ${money(project.response_price_max)}` : '—'}</b></span><span>Вложений<b>{project.attachments?.length || 0}</b></span></div>}
    <div className="grid two"><Card title="Полное описание проекта"><p className="pre">{lead.description || '—'}</p>{project.attachments?.length > 0 && <div className="attachmentList"><h4>Вложения</h4>{project.attachments.map((file: any) => <div key={file.sha256}><b>{file.name}</b><small>{Math.ceil(file.size / 1024)} КБ · {file.extraction === 'image' ? 'изображение передано Codex' : file.extracted_text ? 'текст извлечён' : 'файл сохранён'}</small></div>)}</div>}</Card><Card title="Оценка Codex"><p>{lead.analysis?.fit_reason || 'Ещё не выполнена'}</p>{lead.analysis?.risks?.length > 0 && <><h4>Риски</h4><ul>{lead.analysis.risks.map((item: string) => <li key={item}>{item}</li>)}</ul></>}</Card></div>
    <Card title="Переписка">{data.messages.length === 0 ? <Empty text="Сообщений пока нет" /> : data.messages.map((message: any) => <div key={message.id} className={`message ${message.direction}`}><small>{message.channel} · {new Date(message.created_at).toLocaleString('ru')}</small><p>{message.content}</p></div>)}</Card>
    <Card title="Документы">{data.documents.length === 0 ? <Empty text="Документов пока нет" /> : data.documents.map((document: any) => <div className="doc" key={document.id}><div><b>{document.kind === 'specification' ? 'Техническое задание' : document.kind === 'contract' ? 'Договор' : 'Данные договора'}</b><small>Версия {document.version}</small></div>{document.downloadable && <a className="button" href={`${BASE}/api/documents/${document.id}/download`}>Скачать DOCX</a>}</div>)}</Card>
  </section>;
}

function Settings({ notify }: { notify: (text: string) => void }) {
  const [data, setData] = useState<any>();
  const [seller, setSeller] = useState<any>({});
  const [style, setStyle] = useState<any>({});
  const [keys, setKeys] = useState({ telegram: '', cookies: '', images: '' });
  const [showCookies, setShowCookies] = useState(false);
  const [contractTemplate, setContractTemplate] = useState<File | null>(null);
  const load = () => api('/settings').then((value) => { setData(value); setSeller(value.seller || {}); setStyle(value.style || {}); });
  useEffect(() => { void load(); }, []);
  if (!data) return <Loading />;
  const fl = data.connectors.find((item: any) => item.connector === 'fl') || {};
  const saveProfile = async () => { await api('/settings/profile', { method: 'PATCH', body: JSON.stringify({ seller, style }) }); notify('Профиль сохранён'); };
  const connect = async (kind: string, body: unknown) => { try { await api(`/settings/${kind}`, { method: 'POST', body: JSON.stringify(body) }); notify(`${kind} подключён`); await load(); } catch (error) { notify((error as Error).message); } };
  const uploadContract = async () => { if (!contractTemplate) return; const form = new FormData(); form.append('template', contractTemplate); try { await api('/settings/contract-template', { method: 'POST', body: form }); notify('Шаблон договора сохранён'); await load(); } catch (error) { notify((error as Error).message); } };
  return <section><div className="pageTitle"><div><span className="eyebrow">Управление</span><h1>Система</h1><p>Автоматизация, ваш профиль и подключения — в одном месте.</p></div></div>
    <div className="settingsGrid">
      <Card title="Push-уведомления" subtitle="О подходящем заказе и готовом черновике"><PushControl notify={notify} /></Card>
      <Card title="Автопоиск FL.ru" subtitle="Только новые проекты, один раз в 5 минут"><div className="settingStatus"><span className={fl.enabled ? 'dot ok' : 'dot'} /><b>{fl.enabled ? 'Включён' : 'На паузе'}</b></div><button className={fl.enabled ? 'danger soft' : 'primary'} onClick={() => connect('fl', { enabled: !fl.enabled })}>{fl.enabled ? 'Остановить' : 'Включить мониторинг'}</button></Card>
    </div>
    <Card title="Ваше предложение" subtitle="Чем точнее заполнено, тем меньше лишних заказов"><div className="formgrid"><label>Имя<input value={seller.name || ''} onChange={(event) => setSeller({ ...seller, name: event.target.value })} /></label><label>Минимальная цена<input type="number" value={seller.minimum_price || ''} onChange={(event) => setSeller({ ...seller, minimum_price: Number(event.target.value) })} /></label><label>Telegram для клиентов<input placeholder="@username" value={seller.telegram_username || ''} onChange={(event) => setSeller({ ...seller, telegram_username: event.target.value })} /></label><label>Когда могу начать<input placeholder="например: с 10 августа" value={seller.available_from || ''} onChange={(event) => setSeller({ ...seller, available_from: event.target.value })} /></label><label className="wide">Услуги<textarea rows={4} value={seller.services || ''} onChange={(event) => setSeller({ ...seller, services: event.target.value })} /></label><label className="wide">Подтверждённые кейсы<textarea rows={4} value={seller.cases || ''} onChange={(event) => setSeller({ ...seller, cases: event.target.value })} /></label><label className="wide">Стиль общения<textarea rows={4} value={style.rules || ''} onChange={(event) => setStyle({ ...style, rules: event.target.value })} /></label></div><p className="hint">Если дату не указать, система не будет её выдумывать и покажет предупреждение перед отправкой отклика.</p><button className="primary" onClick={saveProfile}>Сохранить профиль</button></Card>
    <div className="settingsGrid">
      <Card title={`Codex Hub ${data.configured.codex ? '✓' : ''}`} subtitle="ИИ и подготовка документов"><p className="hint">Работает через Codex Hub на сервере. От вас ничего не требуется.</p></Card>
      <Card title={`Telegram Business ${data.configured.telegram ? '✓' : ''}`} subtitle="Общение через ваш аккаунт"><p className="hint">Подключайте, когда будете готовы перенести клиента из FL.ru в Telegram.</p><div className="inline"><input type="password" placeholder="Bot token" value={keys.telegram} onChange={(event) => setKeys({ ...keys, telegram: event.target.value })} /><button onClick={() => connect('telegram', { botToken: keys.telegram })}>Подключить</button></div></Card>
      <Card title={`Генерация дизайна ${data.configured.images ? '✓' : ''}`} subtitle="4 предварительных концепции только по вашей команде"><p className="hint">OpenAI Images: gpt-image-2, low quality, примерно $0.02 за четыре эскиза. Ключ хранится в зашифрованных настройках и не попадает в браузер после сохранения.</p><div className="inline"><input type="password" placeholder="OpenAI API key" value={keys.images} onChange={(event) => setKeys({ ...keys, images: event.target.value })} /><button disabled={!keys.images.trim()} onClick={() => connect('images', { apiKey: keys.images })}>Подключить</button></div></Card>
      <Card title={`Cookies FL.ru ${data.configured.fl ? '✓' : ''}`} subtitle="Чаты и отправка одобренных ответов"><p className="hint">Проверяются каждые 5 минут. До истечения и при разлогине придёт push.</p>{data.flCookies?.expiryKnown && <p className="cookieExpiry">Действуют до <b>{new Date(data.flCookies.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</b></p>}{showCookies ? <><textarea rows={5} autoFocus placeholder='Вставьте JSON cookies' value={keys.cookies} onChange={(event) => setKeys({ ...keys, cookies: event.target.value })} /><div className="actions"><button onClick={() => setShowCookies(false)}>Отмена</button><button className="primary" onClick={() => { try { void connect('fl', { cookies: JSON.parse(keys.cookies), enabled: fl.enabled }); setShowCookies(false); } catch { notify('Некорректный JSON'); } }}>Сохранить cookies</button></div></> : <button onClick={() => setShowCookies(true)}>Обновить cookies</button>}</Card>
      <Card title={`Шаблон договора ${data.configured.contractTemplate ? '✓' : ''}`} subtitle="Ваш DOCX-шаблон"><p className="hint">Договор всегда останется на проверке до вашего решения.</p><div className="inline"><input type="file" accept=".docx" onChange={(event) => setContractTemplate(event.target.files?.[0] || null)} /><button disabled={!contractTemplate} onClick={uploadContract}>Загрузить</button></div></Card>
    </div>
  </section>;
}

function PushControl({ notify, compact = false }: { notify: (text: string) => void; compact?: boolean }) {
  const [status, setStatus] = useState<any>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await api('/push/status');
    setStatus(next);
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await api('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      setEnabled(Boolean(subscription));
    }
  };
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  const enable = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return notify('Этот браузер не поддерживает push');
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(status.publicKey) });
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      setEnabled(true);
      const result = await api<any>('/push/test', { method: 'POST' });
      notify(result.sent > 0 ? 'Push включены, тест отправлен' : 'Подписка создана, но тест не доставлен');
    } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const result = await api<any>('/push/test', { method: 'POST' });
      notify(result.sent > 0 ? `Тестовый push отправлен на устройств: ${result.sent}` : 'Сервер не видит активной push-подписки');
      await refresh();
    } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setEnabled(false); notify('Push-уведомления выключены на этом устройстве');
    } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  };
  if (!status) return compact ? null : <p className="hint">Проверяю поддержку…</p>;
  return <div className={`pushControl ${compact ? 'compact' : ''}`}>{enabled ? <div className="pushButtons"><button className="pushOn" disabled={busy} onClick={test}>🔔 Отправить тест</button><button disabled={busy} onClick={disable}>Выключить</button></div> : <button className="primary" disabled={busy} onClick={enable}>Включить push</button>}{!compact && <small>{enabled ? `Разрешение браузера: ${Notification.permission}. Подписок на сервере: ${status.subscriptions}.` : 'На iPhone сначала добавьте сайт на главный экран.'}</small>}</div>;
}

function LeadRows({ leads, openLead }: { leads: any[]; openLead: (id: string) => void }) {
  return <div className="leadrows">{leads.length === 0 ? <Empty text="Ничего не найдено" /> : leads.map((lead) => <button key={lead.id} onClick={() => openLead(lead.id)}><Score value={lead.score} /><div><b>{lead.title}</b><small><StatusDot status={lead.status} /> {labelStatus(lead.status)} · {relativeTime(lead.updated_at)}</small></div><span className="price">{money(lead.recommended_price)}</span><span className="chevron">›</span></button>)}</div>;
}

function StatusDot({ status }: { status: string }) { return <i className={`statusDot ${status}`} />; }
function Metric({ label, value, tone = '', hint = '' }: any) { return <div className={`metric ${tone}`}><b>{value ?? 0}</b><span>{label}</span>{hint && <small>{hint}</small>}</div>; }
function Score({ value }: { value: number | null }) { return <span className={`score ${(value || 0) >= 65 ? 'high' : (value || 0) >= 45 ? 'mid' : ''}`}>{value ?? '—'}</span>; }
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{({ pending:'Ждёт решения',approved:'Одобрено',sending:'Отправляется',failed:'Ошибка',stale:'Устарело' } as Record<string,string>)[value] || value}</span>; }
function Card({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) { return <div className="card">{title && <div className="cardTitle"><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>}{children}</div>; }
function Modal({ close, children }: { close: () => void; children: React.ReactNode }) { return <div className="modal" onMouseDown={close}><div onMouseDown={(event) => event.stopPropagation()}>{children}</div></div>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Loading() { return <div className="center"><div className="spinner" /></div>; }

const money = (value: number | null) => value ? `${new Intl.NumberFormat('ru-RU').format(value)} ₽` : '—';
const labelConnector = (value: string) => ({ codex:'Codex Hub',images:'Генерация дизайна',fl:'FL.ru',telegram:'Telegram Business' } as Record<string,string>)[value] || value;
const labelStatus = (value: string) => ({ new:'На оценке',qualified:'Подходит',rejected:'Отсеян',contacted:'Связались',discovery:'Уточнение',proposal:'Предложение',negotiation:'Переговоры' } as Record<string,string>)[value] || value;
const relativeTime = (value: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'только что';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const urlBase64ToUint8Array = (value: string) => {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
