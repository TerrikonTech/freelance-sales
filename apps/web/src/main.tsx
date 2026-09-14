import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('dsh:auth-expired'));
    throw new Error(body.message || `HTTP ${response.status}`);
  }
  return body as T;
}

type Page = 'leads' | 'approvals' | 'settings';
const validPage = (value: string | null): Page => (['leads', 'approvals', 'settings'].includes(value || '') ? value as Page : 'leads');

function App() {
  const params = new URLSearchParams(location.search);
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ok'>('loading');
  const [page, setPage] = useState<Page>(validPage(params.get('page')));
  const [selectedLead, setSelectedLead] = useState<string | null>(params.get('lead'));
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const [autoMode, setAutoMode] = useState<string>('manual');
  const status = useStatus(auth === 'ok');

  useEffect(() => {
    const refreshAuth = async () => {
      try { await api('/auth/me'); setAuth('ok'); }
      catch {
        const status = await api<{ required: boolean }>('/auth/setup-status').catch(() => ({ required: false }));
        setAuth(status.required ? 'setup' : 'login');
      }
    };
    void refreshAuth();
  }, []);
  useEffect(() => {
    const onExpired = () => setAuth('login');
    window.addEventListener('dsh:auth-expired', onExpired);
    return () => window.removeEventListener('dsh:auth-expired', onExpired);
  }, []);
  useEffect(() => {
    if (auth !== 'ok') return;
    api<{ policy?: { mode?: string } }>('/autonomy')
      .then((value) => setAutoMode(value.policy?.mode || 'manual'))
      .catch(() => undefined);
  }, [auth]);

  const notify = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), 3500);
  };
  const busy = (status?.running?.length || 0) + (status?.queue?.active || 0);
  const workerSeenAt = status?.worker?.seenAt || null;
  const serverNow = status?.serverTime ? Date.parse(status.serverTime) : Date.now();
  const workerDead = Boolean(auth === 'ok' && (!workerSeenAt || serverNow - Date.parse(workerSeenAt) > 150_000));
  const blocked = blockingError(status);
  const navigate = (next: Page) => { setPage(next); history.pushState({ dsh: 1 }, '', `${BASE}/?page=${next}`); window.scrollTo({ top: 0 }); };
  const openLead = (id: string) => { setSelectedLead(id); history.pushState({ dsh: 1 }, '', `${BASE}/?lead=${id}`); window.scrollTo({ top: 0 }); };
  const closeLead = () => {
    if (history.state?.dsh) { history.back(); return; }
    setSelectedLead(null); history.replaceState({}, '', `${BASE}/?page=${page}`); window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const onPop = () => {
      const pop = new URLSearchParams(location.search);
      setPage(validPage(pop.get('page')));
      setSelectedLead(pop.get('lead'));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (auth === 'loading') return <div className="center"><div className="spinner" /></div>;
  if (auth !== 'ok') return <Auth mode={auth} onDone={() => setAuth('ok')} />;

  return <div className={`shell ${selectedLead ? 'focus' : ''}`}>
    <header>
      <button className="brand brandButton" onClick={() => navigate('leads')} title="К заказам">
        <span className="logo">S</span><div><strong>Sales Control</strong><small>Заказы и отклики</small></div>
      </button>
      <div className="headerActions">
        <span className={`systemPill ${workerDead ? 'bad' : blocked ? 'warn' : busy ? 'busy' : ''}`}>
          <i className={busy && !workerDead && !blocked ? 'livePulse' : undefined} />
          {workerDead ? 'Обработчик не отвечает' : blocked ? 'ИИ остановлен' : busy ? `В работе: ${busy}` : 'Система свободна'}
        </span>
        <span className={`approvalLock ${autoMode === 'smart' ? 'auto' : ''}`}><i /> {autoMode === 'smart' ? 'Авто-отправка включена' : 'Отправка вручную'}</span>
      </div>
    </header>
    <main>
      <div className="page" key={selectedLead || page}>
        {selectedLead
          ? <LeadDetail id={selectedLead} back={closeLead} notify={notify} />
          : <>
            {page === 'leads' && <Leads openLead={openLead} notify={notify} status={status} />}
            {page === 'approvals' && <Approvals notify={notify} openLead={openLead} status={status} />}
            {page === 'settings' && <Settings notify={notify} status={status} />}
          </>}
      </div>
    </main>
    {!selectedLead && <nav>
      <Nav active={page === 'leads'} onClick={() => navigate('leads')} icon="▣" text="Заказы" />
      <Nav active={page === 'approvals'} onClick={() => navigate('approvals')} icon="✓" text="Отклики" />
      <Nav active={page === 'settings'} onClick={() => navigate('settings')} icon="⚙" text="Система" />
    </nav>}
    {toasts.length > 0 && <div className="toastStack">{toasts.map((toast) => <div className="toast" role="status" key={toast.id}>{toast.text}</div>)}</div>}
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
  return <button className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={onClick}><span>{icon}</span>{text}</button>;
}

/**
 * One polling rule for every screen: refresh now, then on an interval, never while
 * the tab is in the background (a hidden tab polling is how this UI used to stutter).
 */
function usePolling(load: () => void, everyMs: number, immediate = true) {
  const saved = useRef(load);
  saved.current = load;
  useEffect(() => {
    let cancelled = false;
    const run = () => { if (!cancelled && !document.hidden) void saved.current(); };
    if (immediate) void saved.current();
    const timer = window.setInterval(run, everyMs);
    const onVisible = () => { if (!document.hidden) void saved.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs, immediate]);
}

type ActivityStep = { key: string; label: string; status: 'pending' | 'active' | 'done' | 'skipped' | 'failed'; note?: string; attempts?: number; started_at?: string; ended_at?: string };
type ActivityJob = {
  id: string; kind: string; title: string; status: 'running' | 'completed' | 'failed';
  lead_id: string | null; lead_title: string | null; steps: ActivityStep[];
  result_text: string | null; error: string | null;
  started_at: string; updated_at: string; finished_at: string | null;
};
type ActivityFeed = { active: ActivityJob[]; recent: ActivityJob[]; aiQueue: number };

function useActivity(leadId?: string, signal = 0) {
  const [feed, setFeed] = useState<ActivityFeed>();
  const load = useCallback(
    () => api<ActivityFeed>(`/activity${leadId ? `?leadId=${encodeURIComponent(leadId)}` : ''}`).then(setFeed).catch(() => undefined),
    [leadId],
  );
  const running = (feed?.active?.length || 0) > 0;
  useEffect(() => { void load(); }, [load, signal]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, running ? 2_000 : 12_000);
    return () => clearInterval(timer);
  }, [load, running]);
  return { feed, running, reload: load };
}

type SystemStatus = {
  serverTime: string;
  worker: { seenAt: string | null };
  queue: { waiting: number; active: number; delayed: number; failed: number };
  ai: { pending: string; claimed: string; done24: string; failed24: string; waiting_ms: string };
  scan: {
    last: { created_at: string; found_count: number; new_count: number; analyzed_count: number; duration_ms: number } | null;
    intervalSeconds: number; enabled: boolean; healthy: boolean; statusText: string | null; lastSuccessAt: string | null;
  };
  broker: { healthy: boolean; statusText: string | null; lastSuccessAt: string | null };
  drafts: { today: number; autoUsed: number };
  policy: { minScore: number; minDealPrice: number; autoDraft: boolean; autoDraftLimit: number; autoSend: boolean };
  running: ActivityJob[];
  errors: Array<{ message: string; count: string; last_at: string }>;
};

/** Nothing in this interface may leave the owner guessing whether the click worked. */
function useStatus(enabled = true, everyMs = 8_000) {
  const [status, setStatus] = useState<SystemStatus>();
  const load = useCallback(
    () => api<SystemStatus>('/status').then(setStatus).catch(() => undefined),
    [],
  );
  const busy = (status?.running?.length || 0) > 0 || (status?.queue?.active || 0) > 0;
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, busy ? 3_000 : everyMs);
    return () => clearInterval(timer);
  }, [enabled, load, busy, everyMs]);
  return status;
}

const aiWaiting = (status?: SystemStatus) => Number(status?.ai.pending || 0) + Number(status?.ai.claimed || 0);
const blockingError = (status?: SystemStatus) => (status?.errors || []).find((row) => /402|credit|quota|limit/i.test(row.message));

function useTicker(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
};

/** Broker and queue failures arrive as English internals; the owner needs the meaning. */
const humanError = (text: string) => {
  const table: Array<[RegExp, string]> = [
    [/402|exceed your available credits|requires more credits|insufficient credits/i, 'Закончились средства на OpenRouter. Пополните баланс на openrouter.ai/settings/credits — пока этого не сделать, заказы не оцениваются и тексты не пишутся.'],
    [/exceeds the Hermes input limit|instruction limit/i, 'Заказ оказался слишком большим для одной задачи ИИ. Запустите ещё раз или сократите описание.'],
    [/Время ожидания истекло|Время ожидания Codex истекло/i, 'ИИ не ответил за отведённое время. Запустите ещё раз.'],
    [/Unsupported AI task kind/i, 'Внутренняя ошибка конфигурации задач — обновите систему или сообщите разработчику.'],
    [/не прошёл финальную проверку качества/i, 'Текст не прошёл проверку на живость и достоверность. Запустите заново или задайте свои правки.'],
    [/Hermes did not return a JSON object|invalid task id/i, 'ИИ вернул испорченный ответ. Запустите ещё раз.'],
    [/Hermes run failed|run was cancelled/i, 'Задача ИИ оборвалась на стороне брокера. Запустите ещё раз.'],
    [/fetch failed|ECONNREFUSED|ETIMEDOUT/i, 'Не достучались до внешнего сервиса. Проверьте подключения в разделе «Система».'],
    [/Работа прервана: сервис перезапустился/i, 'Работа прервалась из-за перезапуска сервиса. Запустите заново.'],
    [/cookie|Unauthorized|401/i, 'FL.ru не принял вход. Обновите cookies в разделе «Система».'],
  ];
  for (const [pattern, message] of table) if (pattern.test(text)) return message;
  return text;
};

const jobEta = (kind: string) => ({
  'draft-reply': 'обычно 3–6 минут',
  'analyze-lead': 'обычно 30–90 секунд',
  'generate-documents': 'обычно 2–5 минут',
  'send-draft': 'обычно несколько секунд',
  'scan-fl': 'обычно 10–30 секунд',
} as Record<string, string>)[kind] || '';

const jobIcon = ({ kind }: ActivityJob) => ({
  'draft-reply': '✎', 'analyze-lead': '⚖', 'generate-documents': '▤',
  'send-draft': '➤', 'scan-fl': '⟳', 'owner-command': '☰',
} as Record<string, string>)[kind] || '•';

function ActivityJobCard({ job, now }: { job: ActivityJob; now: number }) {
  const finished = job.finished_at ? new Date(job.finished_at).getTime() : now;
  const total = finished - new Date(job.started_at).getTime();
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const doneCount = steps.filter((step) => step.status === 'done').length;
  const countable = steps.filter((step) => step.status !== 'skipped').length || 1;
  return <article className={`liveJob ${job.status}`}>
    <div className="liveJobHead">
      <span className="liveJobIcon">{jobIcon(job)}</span>
      <div>
        <b>{job.title}</b>
        <small>{job.lead_title ? job.lead_title : 'Общая задача системы'}{job.status === 'running' && jobEta(job.kind) ? ` · ${jobEta(job.kind)}` : ''}</small>
      </div>
      <div className="liveJobTime">
        <b>{duration(total)}</b>
        <small>{job.status === 'running' ? `шаг ${Math.min(doneCount + 1, countable)} из ${countable}` : job.status === 'failed' ? 'с ошибкой' : 'готово'}</small>
      </div>
    </div>
    <div className="liveJobBar"><i style={{ width: `${Math.round(Math.min(1, doneCount / countable) * 100)}%` }} /></div>
    <ol className="liveSteps">{steps.map((step) => {
      const started = step.started_at ? new Date(step.started_at).getTime() : 0;
      const ended = step.ended_at ? new Date(step.ended_at).getTime() : now;
      const spent = started ? ended - started : 0;
      return <li className={step.status} key={step.key}>
        <i>{step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : step.status === 'skipped' ? '–' : step.status === 'active' ? '' : '○'}</i>
        <span>{step.label}{step.note ? <em> — {step.note}</em> : null}</span>
        <time>{step.status === 'pending' ? '' : step.status === 'skipped' ? 'не потребовалось' : duration(spent)}</time>
      </li>;
    })}</ol>
    {job.error && <p className="liveJobError">Не получилось: {humanError(job.error)}</p>}
    {job.result_text && !job.error && <p className="liveJobResult">{job.result_text}</p>}
  </article>;
}

function LiveActivity({ leadId, signal = 0, onIdle, title = 'Прямо сейчас', onlyWhenBusy = false }: { leadId?: string; signal?: number; onIdle?: () => void; title?: string; onlyWhenBusy?: boolean }) {
  const { feed, running } = useActivity(leadId, signal);
  const now = useTicker(running);
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) setWasRunning(true);
    else if (wasRunning) { setWasRunning(false); onIdle?.(); }
  }, [running, wasRunning, onIdle]);
  if (!feed) return null;
  if (onlyWhenBusy && !running) return null;
  return <section className={`liveActivity ${running ? 'busy' : ''}`}>
    <div className="liveHead">
      <div><span className="eyebrow">{running ? 'Идёт работа' : 'Система свободна'}</span><h2>{title}</h2></div>
      <span className="liveBadgeCount">{running ? <><i className="livePulse" />{feed.active.length} в работе</> : <>Ожидает команды</>}</span>
    </div>
    {running && feed.aiQueue > 1 && <p className="liveQueue">ИИ выполняет задачи по очереди: в очереди {feed.aiQueue}.</p>}
    {running
      ? <div className="liveJobs">{feed.active.map((job) => <ActivityJobCard job={job} now={now} key={job.id} />)}</div>
      : <p className="liveIdle">Ничего не считается и никуда не отправляется.</p>}
  </section>;
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return <div className={`tile ${tone || ''}`}><span>{label}</span><b>{value}</b><small>{hint}</small></div>;
}

/**
 * The owner's main question is "what is happening and did my click do anything".
 * Everything the system knows about itself is therefore in one block at the top.
 */
function SystemPanel({ status, onScan, scanning }: { status?: SystemStatus; onScan: () => void; scanning: boolean }) {
  const now = useTicker(Boolean(status));
  const scanButton = <button className="primary" disabled={scanning} onClick={onScan}>{scanning ? 'Проверяю…' : '⟳ Проверить заказы на FL.ru'}</button>;
  if (!status) return <section className="systemPanel">
    <div className="systemTop">
      <div><span className="eyebrow">Что происходит</span><h2>Процессы</h2></div>
      {scanButton}
    </div>
    <p className="liveIdle">Статус системы недоступен. Кнопка проверки работает — если заказы не появятся, загляните в «Система».</p>
  </section>;
  const blocked = blockingError(status);
  const failed = Number(status.ai.failed24 || 0);
  const waiting = aiWaiting(status);
  const seenAt = status.worker?.seenAt || null;
  const serverNow = status.serverTime ? Date.parse(status.serverTime) : Date.now();
  const workerDead = !seenAt || serverNow - Date.parse(seenAt) > 150_000;
  return <section className="systemPanel">
    <div className="systemTop">
      <div><span className="eyebrow">Что происходит</span><h2>Процессы</h2></div>
      {scanButton}
    </div>
    {workerDead && <div className="alert bad"><b>Обработчик задач не отвечает.</b> Заказы не оцениваются и отклики не пишутся.</div>}
    {blocked && <div className="alert bad">
      <b>ИИ остановлен: {blocked.count} случаев за сутки.</b> {humanError(blocked.message)}
    </div>}
    {!blocked && failed > 3 && <div className="alert warn">За сутки {failed} задач ИИ закончились ошибкой. Ниже — что именно не так.</div>}
    <div className="tiles">
      <Tile
        label="Поиск на FL.ru"
        value={status.scan.enabled ? 'Включён' : 'На паузе'}
        hint={status.scan.last
          ? `проверял ${relativeTime(status.scan.last.created_at)} · нашёл ${status.scan.last.found_count}, новых ${status.scan.last.new_count}`
          : 'ещё не запускался'}
        tone={status.scan.enabled ? 'ok' : 'muted'}
      />
      <Tile
        label="Задачи"
        value={`${status.queue.active} в работе`}
        hint={waiting ? `в очереди ${status.queue.waiting} · у ИИ ${waiting}` : 'очередь пуста'}
      />
      <Tile
        label="Черновики сегодня"
        value={String(status.drafts.today)}
        hint={status.policy.autoDraft ? `авто ${status.drafts.autoUsed} из ${status.policy.autoDraftLimit}` : 'только по кнопке'}
      />
      <Tile
        label="Ошибки за сутки"
        value={String(failed)}
        hint={status.broker.healthy && status.broker.lastSuccessAt ? `брокер на связи · ${relativeTime(status.broker.lastSuccessAt)}` : 'брокер не отвечает'}
        tone={failed > 3 ? 'warn' : 'ok'}
      />
    </div>
    <p className="policyLine">
      Берём заказы с оценкой от <b>{status.policy.minScore}</b> и сделкой от <b>{money(status.policy.minDealPrice)}</b>.
      {' '}Черновики: {status.policy.autoDraft ? `сами, до ${status.policy.autoDraftLimit} в день` : 'только по кнопке'}.
      {' '}Отправка — только вашей кнопкой.
    </p>
    <div className="liveJobs">
      {status.running.length > 0
        ? status.running.map((job) => <ActivityJobCard job={job} now={now} key={job.id} />)
        : <p className="liveIdle">{waiting > 0 ? `Ждут своей очереди: ${waiting}` : 'Ничего не считается и никуда не отправляется.'}</p>}
    </div>
  </section>;
}

const FILTERS: Array<[string, string]> = [
  ['all', 'Все'],
  ['fresh', 'Актуальные 24 ч'],
  ['qualified', 'Подходят'],
  ['contacted', 'В работе'],
  ['rejected', 'Отсеяны'],
];
const SORTS: Array<[string, string]> = [['date', 'Сначала новые'], ['score', 'Сначала лучшие'], ['price', 'Сначала дорогие']];

function Leads({ openLead, notify, status }: { openLead: (id: string) => void; notify: (text: string) => void; status?: SystemStatus }) {
  const [leads, setLeads] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('date');
  const [limit, setLimit] = useState(150);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (search) params.set('q', search);
    if (filter !== 'all' && filter !== 'fresh') params.set('status', filter);
    return api<any[]>(`/leads?${params.toString()}`)
      .then((next) => { setLeads(next); setLastLoaded(new Date()); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [search, filter, limit]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  usePolling(load, 30_000, false);

  const visible = useMemo(() => {
    const isFresh = (lead: any) => lead.status !== 'rejected'
      && Date.now() - Date.parse(lead.published_at || lead.created_at || lead.updated_at) <= 24 * 60 * 60 * 1_000;
    const rows = filter === 'fresh' ? leads.filter(isFresh) : leads;
    const sorted = [...rows];
    if (sort === 'score') sorted.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    else if (sort === 'price') sorted.sort((a, b) => Number(b.recommended_price || 0) - Number(a.recommended_price || 0));
    else sorted.sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at));
    return sorted;
  }, [leads, filter, sort]);

  const scan = async () => {
    setScanning(true);
    try {
      const result = await api<{ projects?: { found?: number; created?: number } }>('/connectors/fl/scan', { method: 'POST' });
      notify(`Проверил FL.ru: найдено ${result.projects?.found ?? 0}, новых ${result.projects?.created ?? 0}`);
      await load();
    } catch (error) { notify((error as Error).message); }
    finally { setScanning(false); }
  };

  const startDraft = async (lead: any) => {
    setBusyId(lead.id);
    try {
      await api(`/leads/${lead.id}/draft`, { method: 'POST', body: '{}' });
      notify('Готовлю отклик — он появится в разделе «Отклики»');
    } catch (error) { notify((error as Error).message); }
    finally { setBusyId(null); }
  };

  return <section>
    <SystemPanel status={status} onScan={scan} scanning={scanning} />
    <div className="pageTitle">
      <div><span className="eyebrow">Заказы с FL.ru</span><h1>Заказы</h1><p>Показаны последние {visible.length}. Нажмите на заказ, чтобы открыть его целиком.</p></div>
      <span className="liveBadge"><i /> {lastLoaded ? `Обновлено ${lastLoaded.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Подключаюсь'}</span>
    </div>
    <div className="toolbar leadsToolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по названию" />
      <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Сортировка">
        {SORTS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </div>
    <div className="chips">
      {FILTERS.map(([value, label]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    {loading && !leads.length
      ? <SkeletonRows />
      : <div className="leadrows">
        {visible.length === 0
          ? <Empty text="Ничего не найдено — попробуйте другой фильтр или слово" />
          : visible.map((lead) => <div className="leadRow" key={lead.id}>
            <button className="leadRowOpen" onClick={() => openLead(lead.id)}>
              <Grade price={lead.recommended_price} />
              <span className="leadRowBody"><b>{lead.title}</b>
                <small><StatusDot status={lead.status} /> {labelStatus(lead.status)} · {relativeTime(lead.published_at || lead.created_at || lead.updated_at)}{lead.budget_text ? ` · бюджет ${lead.budget_text}` : ''}</small>
              </span>
              <span className="price">{money(lead.recommended_price)}</span>
            </button>
            <div className="leadRowActions">
              {['qualified', 'new'].includes(lead.status) && <button className="small" disabled={busyId === lead.id} onClick={() => startDraft(lead)}>{busyId === lead.id ? 'Готовлю…' : 'Отклик'}</button>}
              {lead.url && <a className="button small ghost" href={lead.url} target="_blank" rel="noreferrer">FL</a>}
            </div>
          </div>)}
      </div>}
    {leads.length >= limit && <div className="actions"><button onClick={() => setLimit(limit + 150)}>Показать ещё</button></div>}
  </section>;
}

function LeadDetail({ id, back, notify }: { id: string; back: () => void; notify: (text: string) => void }) {
  const [data, setData] = useState<any>();
  const [failed, setFailed] = useState(false);
  const [signal, setSignal] = useState(0);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const load = useCallback(() => api(`/leads/${id}`)
    .then((value) => { setData(value); setFailed(false); })
    .catch(() => setFailed(true)), [id]);
  useEffect(() => { setData(undefined); setFailed(false); void load(); }, [load]);
  if (failed) return <section>
    <button className="back" onClick={back}>← К заказам</button>
    <Card title="Заказ не открылся">
      <Empty text="Не удалось загрузить заказ — он удалён или сервис недоступен." />
      <div className="actions"><button onClick={() => { setFailed(false); void load(); }}>Повторить</button><button className="ghost" onClick={back}>К заказам</button></div>
    </Card>
  </section>;
  if (!data) return <Loading />;
  const lead = data.lead;
  const project = lead.requirements?.project || {};
  const job = async (path: string, message: string) => {
    setBusyJob(path); setSignal((value) => value + 1);
    try { await api(`/leads/${id}/${path}`, { method: 'POST', body: '{}' }); notify(message); }
    catch (error) { notify((error as Error).message); }
    finally {
      setBusyJob(null); setSignal((value) => value + 1);
      window.setTimeout(() => void load(), 1500);
    }
  };
  return <section>
    <button className="back" onClick={back}>← К заказам</button>
    <div className="pageTitle leadTitle">
      <div><span className="eyebrow">{labelStatus(lead.status)}</span><h1>{lead.title}</h1><p>{lead.source.toUpperCase()} · обновлён {relativeTime(lead.updated_at)}</p></div>
      <Grade grade={lead.analysis?.size_grade} price={lead.recommended_price} />
    </div>
    <div className="facts bigfacts">
      <span>Рыночная цена <b>{money(lead.recommended_price)}</b></span>
      <span>Срок <b>{lead.recommended_days || '—'} дн.</b></span>
      <span>Гриф <b>{GRADE_LABELS[lead.analysis?.size_grade || gradeOf(lead.recommended_price)] || '—'}</b></span>
      {lead.analysis?.underpriced && <span className="trapBadge">⚠ Ловушка цены: просят {money(lead.analysis.underpriced.named_budget)}, справедливая {money(lead.analysis.underpriced.fair_price)}</span>}
      <span>Уверенность <b>{lead.confidence ?? '—'}%</b></span>
      {lead.budget_text && <span>Бюджет заказчика <b>{lead.budget_text}</b></span>}
      {project.response_count != null && <span>Откликов у заказчика <b>{project.response_count}</b></span>}
    </div>
    <div className="actions wrap">
      <button disabled={busyJob !== null} onClick={() => job('analyze', 'Запустил переоценку')}>{busyJob === 'analyze' ? 'Оцениваю…' : 'Обновить оценку'}</button>
      <button className="primary" disabled={busyJob !== null} onClick={() => job('draft', 'Готовлю отклик — он появится в разделе «Отклики»')}>{busyJob === 'draft' ? 'Готовлю…' : 'Написать отклик'}</button>
      {lead.url && <a className="button" href={lead.url} target="_blank" rel="noreferrer">Открыть на FL.ru</a>}
    </div>
    <LiveActivity leadId={id} signal={signal} onIdle={load} title="Что делает система по этому заказу" />
    <div className="grid two">
      <Card title="Описание заказа"><p className="pre">{lead.description || '—'}</p></Card>
      <Card title="Оценка системы">
        <p>{lead.analysis?.fit_reason || 'Ещё не выполнена'}</p>
        {lead.analysis?.risks?.length > 0 && <><h4>Риски</h4><ul>{lead.analysis.risks.map((item: string) => <li key={item}>{item}</li>)}</ul></>}
      </Card>
    </div>
    {data.messages?.length > 0 && <Card title="Переписка">{data.messages.map((message: any) => <div key={message.id} className={`message ${message.direction}`}><small>{message.channel} · {new Date(message.created_at).toLocaleString('ru')}</small><p>{message.content}</p></div>)}</Card>}
  </section>;
}

function Approvals({ notify, openLead, status }: { notify: (text: string) => void; openLead: (id: string) => void; status?: SystemStatus }) {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [history, setHistory] = useState(false);
  const [kind, setKind] = useState<'response' | 'message'>('response');
  const load = useCallback(() => api<any[]>('/drafts').then(setDrafts).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  usePolling(load, 20_000, false);
  const activeDrafts = drafts.filter((draft) => history
    ? ['pending', 'approved', 'sending', 'sent', 'failed', 'stale', 'send_unknown'].includes(draft.status)
    : ['pending', 'approved', 'sending', 'failed', 'send_unknown'].includes(draft.status));
  const visible = activeDrafts.filter((draft) => draft.draft_type === kind);
  const responseCount = activeDrafts.filter((draft) => draft.draft_type === 'response').length;
  const messageCount = activeDrafts.filter((draft) => draft.draft_type === 'message').length;
  useEffect(() => {
    if (kind === 'response' && responseCount === 0 && messageCount > 0) setKind('message');
    if (kind === 'message' && messageCount === 0 && responseCount > 0) setKind('response');
  }, [kind, responseCount, messageCount]);
  const action = async (id: string, name: string) => {
    try {
      await api(`/drafts/${id}/${name}`, { method: 'POST' });
      notify(name === 'approve' ? 'Одобрено и поставлено в отправку' : 'Черновик отклонён');
      await load();
    } catch (error) { notify((error as Error).message); await load(); }
  };
  return <section>
    <div className="pageTitle">
      <div><span className="eyebrow">Ваше решение</span><h1>Отклики</h1><p>Проверьте текст и отправьте. Ничего не уйдёт без вашей кнопки.</p></div>
      <button className="ghost" onClick={() => setHistory(!history)}>{history ? 'Скрыть историю' : 'Показать историю'}</button>
    </div>
    <div className="approvalTabs">
      <button className={kind === 'response' ? 'active' : ''} onClick={() => setKind('response')}>Отклики на проекты <b>{responseCount}</b></button>
      <button className={kind === 'message' ? 'active' : ''} onClick={() => setKind('message')}>Сообщения клиентам <b>{messageCount}</b></button>
    </div>
    {status && <p className="hint">
      Сегодня подготовлено {status.drafts.today}
      {status.policy.autoDraft ? `, из них автоматически ${status.drafts.autoUsed} из ${status.policy.autoDraftLimit}` : ''}.
      {' '}Отправка только после вашей кнопки.
      {blockingError(status) ? ' Сейчас ИИ не работает — новые черновики не появятся.' : ''}
    </p>}
    <div className="drafts">
      {visible.length === 0
        ? <Card><Empty text={status?.policy.autoDraft
          ? `Ждущих откликов нет. Они появляются сами для заказов с оценкой от ${status.policy.minScore} и ценой от ${money(status.policy.minDealPrice)} — до ${status.policy.autoDraftLimit} в день. Или нажмите «Отклик» на заказе.`
          : 'Ждущих откликов нет. Нажмите «Отклик» на подходящем заказе.'} /></Card>
        : visible.map((draft) => <DraftCard key={draft.id} draft={draft} reload={load} action={action} notify={notify} openLead={openLead} />)}
    </div>
  </section>;
}

function DraftCard({ draft, reload, action, notify, openLead }: any) {
  const [content, setContent] = useState(draft.content);
  const [instructions, setInstructions] = useState('');
  const [price, setPrice] = useState(String(draft.recommended_price || ''));
  const [days, setDays] = useState(String(draft.recommended_days || ''));
  const [openPanel, setOpenPanel] = useState<'none' | 'warnings' | 'regen'>('none');
  const [regenerating, setRegenerating] = useState(false);
  const [acting, setActing] = useState(false);
  useEffect(() => {
    setContent(draft.content ?? '');
    setPrice(String(draft.recommended_price || ''));
    setDays(String(draft.recommended_days || ''));
  }, [draft.content, draft.recommended_price, draft.recommended_days]);
  const editable = ['pending', 'failed', 'stale'].includes(draft.status);
  const review = draft.metadata?.review;
  const reviewFlags: string[] = Array.isArray(review?.flags) ? review.flags : [];
  const unverifiedTechnologies: string[] = Array.isArray(review?.technology_fit?.unverified)
    ? review.technology_fit.unverified
    : [];
  const qualityIssues: string[] = Array.isArray(review?.quality_issues) ? review.quality_issues : [];
  const warnings: string[] = [];
  if (reviewFlags.includes('technology_fit_unverified')) warnings.push(`Нет подтверждённого кейса по технологии: ${unverifiedTechnologies.join(', ')}`);
  if (reviewFlags.includes('availability_missing')) warnings.push('Не заполнена дата старта — укажите её в профиле или добавьте в текст');
  if (reviewFlags.includes('style_check_failed')) warnings.push(`Текст похож на шаблон: ${qualityIssues.join(' ')}`.trim());
  const changed = content !== draft.content;
  const save = async () => {
    try {
      await api(`/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
      notify('Сохранено. Отправится после вашего одобрения');
      await reload();
      return true;
    } catch (error) { notify((error as Error).message); return false; }
  };
  const regenerate = async () => {
    setRegenerating(true);
    try {
      const body: Record<string, unknown> = { instructions };
      if (draft.draft_type === 'response') {
        const parsedPrice = Number(price);
        const parsedDays = Number(days);
        if (Number.isFinite(parsedPrice) && parsedPrice > 0) body.recommendedPrice = parsedPrice;
        if (Number.isFinite(parsedDays) && parsedDays > 0) body.recommendedDays = parsedDays;
      }
      await api(`/drafts/${draft.id}/regenerate`, { method: 'POST', body: JSON.stringify(body) });
      notify('Пишу новый вариант — он появится здесь');
      setInstructions('');
      setOpenPanel('none');
      await reload();
    } catch (error) { notify((error as Error).message); } finally { setRegenerating(false); }
  };
  const runAction = async (name: 'approve' | 'reject') => {
    setActing(true);
    try {
      if (name === 'approve' && changed && !(await save())) return;
      await action(draft.id, name);
    } finally { setActing(false); }
  };
  return <article className="draft">
    <div className="draftHead">
      <div>
        <span className={`badge ${draft.channel}`}>{draft.draft_type === 'message' ? 'Сообщение' : 'Отклик'}</span>
        <button className="draftTitle" onClick={() => draft.lead_id && openLead(draft.lead_id)}>{draft.lead_title || 'Заказ без названия'}</button>
      </div>
      <Status value={draft.status} />
    </div>
    <div className="facts draftFacts">
      <span>Гриф <b>{GRADE_LABELS[gradeOf(draft.recommended_price)] || '—'}</b></span>
      <span>Рыночная цена <b>{money(draft.recommended_price)}</b></span>
      <span>Срок <b>{draft.recommended_days || '—'} дн.</b></span>
    </div>
    {warnings.length > 0 && <button className="inlineToggle warn" onClick={() => setOpenPanel(openPanel === 'warnings' ? 'none' : 'warnings')}>
      ⚠ Проверить перед отправкой ({warnings.length}) <i>{openPanel === 'warnings' ? '▾' : '▸'}</i>
    </button>}
    {openPanel === 'warnings' && <div className="proposalWarning">{warnings.map((text) => <span key={text}>{text}</span>)}</div>}
    <textarea rows={8} value={content} disabled={!editable} onChange={(event) => setContent(event.target.value)} />
    {draft.error && <div className="error">{humanError(draft.error)}</div>}
    {editable && <>
      <button className="inlineToggle" onClick={() => setOpenPanel(openPanel === 'regen' ? 'none' : 'regen')}>
        ↻ Переписать <i>{openPanel === 'regen' ? '▾' : '▸'}</i>
      </button>
      {openPanel === 'regen' && <div className="regenerateBox">
        {draft.draft_type === 'response' && <div className="regenerateNumbers"><label>Цена, ₽<input type="number" min="1" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Срок, дней<input type="number" min="1" value={days} onChange={(event) => setDays(event.target.value)} /></label></div>}
        <textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Что исправить: короче, увереннее, убрать детали, добавить кейс" />
        <button className="regenButton" disabled={regenerating} onClick={regenerate}>{regenerating ? 'Пишу…' : 'Переписать с правками'}</button>
        <small>Цена и срок применятся в новом варианте. Текущий останется, пока не готов новый.</small>
      </div>}
      <div className="actions">
        <button className="primary" disabled={acting || !content.trim()} onClick={() => runAction('approve')}>{acting ? 'Отправляю…' : draft.status === 'failed' ? '↻ Повторить отправку' : '✓ Отправить'}</button>
        {changed && <button onClick={save} disabled={acting}>Сохранить правки</button>}
        <button className="danger" disabled={acting} onClick={() => runAction('reject')}>Отклонить</button>
      </div>
    </>}
  </article>;
}

function Settings({ notify, status }: { notify: (text: string) => void; status?: SystemStatus }) {
  const [data, setData] = useState<any>();
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seller, setSeller] = useState<any>({});
  const [style, setStyle] = useState<any>({});
  const [cookies, setCookies] = useState('');
  const [showCookies, setShowCookies] = useState(false);
  const load = useCallback(() => api('/settings').then((value) => {
    setData(value); setSeller(value.seller || {}); setStyle(value.style || {}); setFailed(false);
  }).catch(() => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);
  if (failed) return <section>
    <div className="pageTitle"><div><span className="eyebrow">Управление</span><h1>Система</h1></div></div>
    <Card title="Настройки не загрузились">
      <Empty text="Сервис не ответил. Проверьте связь и повторите." />
      <div className="actions"><button className="primary" onClick={() => { setFailed(false); void load(); }}>Повторить</button></div>
    </Card>
  </section>;
  if (!data) return <Loading />;
  const fl = data.connectors.find((item: any) => item.connector === 'fl') || {};
  const serverNow = status?.serverTime ? Date.parse(status.serverTime) : Date.now();
  const workerAlive = Boolean(status?.worker?.seenAt && serverNow - Date.parse(status.worker.seenAt) < 150_000);
  const saveProfile = async () => {
    setSaving(true);
    try { await api('/settings/profile', { method: 'PATCH', body: JSON.stringify({ seller, style }) }); notify('Профиль сохранён'); }
    catch (error) { notify((error as Error).message); }
    finally { setSaving(false); }
  };
  const connect = async (kind: string, body: unknown) => {
    try { await api(`/settings/${kind}`, { method: 'POST', body: JSON.stringify(body) }); notify('Сохранено'); await load(); }
    catch (error) { notify((error as Error).message); }
  };
  return <section>
    <div className="pageTitle"><div><span className="eyebrow">Управление</span><h1>Система</h1><p>Только то, без чего заказы и отклики не работают.</p></div></div>
    <div className="settingsGrid">
      <Card title="Обработчик и ИИ" subtitle="Живы ли они прямо сейчас">
        <div className="settingStatus"><span className={workerAlive ? 'dot ok' : 'dot bad'} /><b>{workerAlive ? 'Обработчик работает' : 'Обработчик не отвечает'}</b></div>
        <p className="hint">{status?.worker?.seenAt ? `Откликался ${relativeTime(status.worker.seenAt!)}` : 'Нет данных'} · в работе {status?.queue.active ?? 0}, в очереди {status?.queue.waiting ?? 0}</p>
        <div className="settingStatus"><span className={status?.broker.healthy ? 'dot ok' : 'dot bad'} /><b>{status?.broker.healthy ? 'Брокер ИИ на связи' : 'Брокер ИИ не отвечает'}</b></div>
        <p className="hint">{status?.broker.statusText || 'Нет данных'}{status?.broker.lastSuccessAt ? ` · ${relativeTime(status.broker.lastSuccessAt)}` : ''}</p>
        {blockingError(status) && <div className="alert bad"><b>ИИ остановлен.</b> {humanError(blockingError(status)!.message)}</div>}
      </Card>
      <Card title="Автопоиск FL.ru" subtitle="Ищет новые проекты и ставит их на оценку">
        <div className="settingStatus"><span className={fl.enabled ? 'dot ok' : 'dot'} /><b>{fl.enabled ? 'Включён' : 'На паузе'}</b></div>
        <p className="hint">{fl.status_text || 'Нет данных'}{fl.last_success_at ? ` · последний раз ${relativeTime(fl.last_success_at)}` : ''}</p>
        <button className={fl.enabled ? 'danger soft' : 'primary'} onClick={() => connect('fl', { enabled: !fl.enabled })}>{fl.enabled ? 'Остановить' : 'Включить поиск'}</button>
      </Card>
      <Card title={`Cookies FL.ru ${data.configured.fl ? '✓' : ''}`} subtitle="Без них нет ни заказов, ни отправки">
        {data.flCookies?.expiryKnown && <p className="cookieExpiry">Действуют до <b>{new Date(data.flCookies.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</b></p>}
        {showCookies
          ? <>
            <textarea rows={5} autoFocus placeholder="Вставьте JSON cookies" value={cookies} onChange={(event) => setCookies(event.target.value)} />
            <div className="actions">
              <button onClick={() => setShowCookies(false)}>Отмена</button>
              <button className="primary" onClick={() => {
                try { void connect('fl', { cookies: JSON.parse(cookies), enabled: fl.enabled }); setShowCookies(false); setCookies(''); }
                catch { notify('Некорректный JSON'); }
              }}>Сохранить cookies</button>
            </div>
          </>
          : <button onClick={() => setShowCookies(true)}>Обновить cookies</button>}
      </Card>
      <Card title="Push-уведомления" subtitle="О подходящем заказе и готовом отклике"><PushControl notify={notify} /></Card>
    </div>
    <Card title="Ваше предложение" subtitle="Чем точнее заполнено, тем меньше лишних заказов и точнее цена">
      <div className="formgrid">
        <label>Имя<input value={seller.name || ''} onChange={(event) => setSeller({ ...seller, name: event.target.value })} /></label>
        <label>Минимальная цена<input type="number" value={seller.minimum_price || ''} onChange={(event) => setSeller({ ...seller, minimum_price: Number(event.target.value) })} /></label>
        <label>Telegram для клиентов<input placeholder="@username" value={seller.telegram_username || ''} onChange={(event) => setSeller({ ...seller, telegram_username: event.target.value })} /></label>
        <label>Когда могу начать<input placeholder="например: с 10 августа" value={seller.available_from || ''} onChange={(event) => setSeller({ ...seller, available_from: event.target.value })} /></label>
        <label className="wide">Услуги<textarea rows={4} value={seller.services || ''} onChange={(event) => setSeller({ ...seller, services: event.target.value })} /></label>
        <label className="wide">Подтверждённые кейсы<textarea rows={4} value={seller.cases || ''} onChange={(event) => setSeller({ ...seller, cases: event.target.value })} /></label>
        <label className="wide">Стиль общения<textarea rows={4} value={style.rules || ''} onChange={(event) => setStyle({ ...style, rules: event.target.value })} /></label>
      </div>
      <button className="primary" disabled={saving} onClick={saveProfile}>{saving ? 'Сохраняю…' : 'Сохранить профиль'}</button>
    </Card>
  </section>;
}

function PushControl({ notify, compact = false }: { notify: (text: string) => void; compact?: boolean }) {
  const [status, setStatus] = useState<any>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const value = await api<any>('/push/status');
      setStatus(value);
      setEnabled(Boolean(value.enabled));
    } catch { setStatus({}); }
  };
  useEffect(() => { void refresh(); }, []);
  const enable = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return notify('Этот браузер не поддерживает push');
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
      if (!status?.publicKey) throw new Error('Сервер не выдал ключ уведомлений — обновите страницу и попробуйте снова');
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
      notify(result.sent > 0 ? `Тестовый push отправлен: ${result.sent}` : 'Сервер не видит активной push-подписки');
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
  return <div className={`pushControl ${compact ? 'compact' : ''}`}>
    {enabled
      ? <div className="pushButtons"><button className="pushOn" disabled={busy} onClick={test}>🔔 Отправить тест</button><button disabled={busy} onClick={disable}>Выключить</button></div>
      : <button className="primary" disabled={busy} onClick={enable}>Включить push</button>}
    {!compact && <small>{enabled ? `Разрешение браузера: ${Notification.permission}.` : 'На iPhone сначала добавьте сайт на главный экран.'}</small>}
  </div>;
}

function StatusDot({ status }: { status: string }) { return <i className={`statusDot ${status}`} />; }
const GRADE_LABELS: Record<string, string> = { large: 'Крупный', medium: 'Средний', small: 'Мелкий' };

// Same thresholds as sizeGrade() in pricing-policy.ts: the lead list does not
// ship the analysis JSON, so the grade is derived from the fair price here.
function gradeOf(price: number | null | undefined): string {
  const value = Number(price || 0);
  if (!value) return '';
  if (value >= 300_000) return 'large';
  if (value >= 100_000) return 'medium';
  return 'small';
}

function Grade({ grade, price }: { grade?: string | null; price?: number | null }) {
  const g = grade || gradeOf(price);
  if (!g) return <span className="grade small">Мелкий</span>;
  return <span className={`grade ${g}`}>{GRADE_LABELS[g] || g}</span>;
}
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{({ pending: 'Ждёт решения', approved: 'Одобрено', sending: 'Отправляется', sent: 'Отправлено', failed: 'Ошибка отправки', stale: 'Устарело', send_unknown: 'Проверьте отправку' } as Record<string, string>)[value] || value}</span>; }
function Card({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) { return <div className="card">{title && <div className="cardTitle"><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>}{children}</div>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Loading() { return <div className="center"><div className="spinner" /></div>; }
function SkeletonRows({ count = 6 }: { count?: number }) {
  return <div className="skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div className="skeletonRow" key={index}>
      <i className="sk sq" />
      <div className="skBody"><i className="sk w70" /><i className="sk w45" /></div>
      <i className="sk w60" />
    </div>)}
  </div>;
}

const money = (value: number | null) => value ? `${new Intl.NumberFormat('ru-RU').format(value)} ₽` : '—';
const labelStatus = (value: string) => ({ new: 'На оценке', qualified: 'Подходит', rejected: 'Отсеян', contacted: 'Связались', discovery: 'Уточнение', proposal: 'Предложение', negotiation: 'Переговоры' } as Record<string, string>)[value] || value;
const relativeTime = (value: string) => {
  if (!value) return '—';
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${BASE}/sw.js`).catch(() => undefined); });
}
