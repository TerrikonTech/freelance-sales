import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const BASE = '/sales';

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

type Page = 'dashboard' | 'leads' | 'chats' | 'approvals' | 'settings';
const validPage = (value: string | null): Page => ['dashboard', 'leads', 'chats', 'approvals', 'settings'].includes(value || '') ? value as Page : 'dashboard';

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

  return <div className={`shell ${selectedLead ? 'focus' : ''}`}>
    <header>
      <div className="brand"><span className="logo">S</span><div><strong>Sales Control</strong><small>Заказы под контролем</small></div></div>
      <span className="approvalLock"><i /> Отправка только после одобрения</span>
    </header>
    <main>
      {selectedLead ? selectedView === 'chat' ? <ChatDetail id={selectedLead} back={closeLead} notify={notify} /> : <LeadDetail id={selectedLead} back={closeLead} notify={notify} /> : <>
        {page === 'dashboard' && <Dashboard openLead={openLead} notify={notify} openApprovals={() => navigate('approvals')} openChats={() => navigate('chats')} />}
        {page === 'leads' && <Leads openLead={openLead} notify={notify} />}
        {page === 'chats' && <Chats openChat={openChat} />}
        {page === 'approvals' && <Approvals notify={notify} />}
        {page === 'settings' && <Settings notify={notify} />}
      </>}
    </main>
    {!selectedLead && <nav>
      <Nav active={page === 'dashboard'} onClick={() => navigate('dashboard')} icon="⌂" text="Главная" />
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
  </section>;
}

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
  const [keys, setKeys] = useState({ telegram: '', cookies: '' });
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
    <Card title="Ваше предложение" subtitle="Чем точнее заполнено, тем меньше лишних заказов"><div className="formgrid"><label>Имя<input value={seller.name || ''} onChange={(event) => setSeller({ ...seller, name: event.target.value })} /></label><label>Минимальная цена<input type="number" value={seller.minimum_price || ''} onChange={(event) => setSeller({ ...seller, minimum_price: Number(event.target.value) })} /></label><label>Telegram для клиентов<input placeholder="@username" value={seller.telegram_username || ''} onChange={(event) => setSeller({ ...seller, telegram_username: event.target.value })} /></label><label className="wide">Услуги<textarea rows={4} value={seller.services || ''} onChange={(event) => setSeller({ ...seller, services: event.target.value })} /></label><label className="wide">Подтверждённые кейсы<textarea rows={4} value={seller.cases || ''} onChange={(event) => setSeller({ ...seller, cases: event.target.value })} /></label><label className="wide">Стиль общения<textarea rows={4} value={style.rules || ''} onChange={(event) => setStyle({ ...style, rules: event.target.value })} /></label></div><button className="primary" onClick={saveProfile}>Сохранить профиль</button></Card>
    <div className="settingsGrid">
      <Card title={`Codex Hub ${data.configured.codex ? '✓' : ''}`} subtitle="ИИ и подготовка документов"><p className="hint">Работает через Codex Hub на сервере. От вас ничего не требуется.</p></Card>
      <Card title={`Telegram Business ${data.configured.telegram ? '✓' : ''}`} subtitle="Общение через ваш аккаунт"><p className="hint">Подключайте, когда будете готовы перенести клиента из FL.ru в Telegram.</p><div className="inline"><input type="password" placeholder="Bot token" value={keys.telegram} onChange={(event) => setKeys({ ...keys, telegram: event.target.value })} /><button onClick={() => connect('telegram', { botToken: keys.telegram })}>Подключить</button></div></Card>
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
const labelConnector = (value: string) => ({ codex:'Codex Hub',fl:'FL.ru',telegram:'Telegram Business' } as Record<string,string>)[value] || value;
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
