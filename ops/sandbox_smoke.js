'use strict';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const apiBase = process.env.SANDBOX_SMOKE_API || 'http://127.0.0.1:3000/api';
const pollMs = Number(process.env.SANDBOX_SMOKE_POLL_MS || 2_000);
const timeoutMs = Number(process.env.SANDBOX_SMOKE_TIMEOUT_MS || 12 * 60_000);
const designEnabled = process.env.SANDBOX_SMOKE_DESIGN !== 'false';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const user = (await db.query('SELECT id,email FROM users ORDER BY created_at LIMIT 1')).rows[0];
    if (!user) throw new Error('Admin user is missing');
    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30m', issuer: 'freelance-sales-v2' },
    );
    const call = async (path, options = {}) => {
      const response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          cookie: `fs_session=${token}`,
          ...(options.headers || {}),
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${path}: ${body.message || response.status}`);
      return body;
    };
    const poll = async (leadId, predicate, label) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const state = await call(`/sandbox/${leadId}`);
        const result = predicate(state);
        if (result) return { state, result };
        await wait(pollMs);
      }
      throw new Error(`Timeout: ${label}`);
    };

    const created = await call('/sandbox', {
      method: 'POST',
      body: JSON.stringify({ scenario: 'web_service' }),
    });
    const leadId = created.id;
    await poll(leadId, (state) => state.lead.analysis_state === 'completed', 'analysis');

    await call(`/sandbox/${leadId}/draft`, { method: 'POST', body: '{}' });
    const initial = await poll(
      leadId,
      (state) => state.drafts.find((draft) => draft.status === 'pending' && draft.metadata?.mode === 'response'),
      'initial draft',
    );
    await call(`/drafts/${initial.result.id}/approve`, { method: 'POST', body: '{}' });
    await poll(leadId, (state) => state.drafts.find((draft) => draft.id === initial.result.id)?.status === 'sent', 'captured initial send');

    await call(`/sandbox/${leadId}/client-message`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Спасибо. Нужны роли администратора и менеджера, интеграция с PostgreSQL, уведомления в Telegram и запуск первой версии за 6 недель. Что ещё нужно уточнить?',
      }),
    });
    const reply = await poll(
      leadId,
      (state) => state.drafts.find((draft) => draft.status === 'pending' && draft.metadata?.mode === 'chat'),
      'conversation reply',
    );
    await call(`/drafts/${reply.result.id}/approve`, { method: 'POST', body: '{}' });
    await poll(leadId, (state) => state.drafts.find((draft) => draft.id === reply.result.id)?.status === 'sent', 'captured chat send');

    await call(`/sandbox/${leadId}/handoff`, { method: 'POST', body: '{}' });
    await call(`/sandbox/${leadId}/telegram-message`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'Продолжим здесь. В первой версии используем существующего Telegram-бота: он принимает заявки и уведомляет менеджера о новой заявке и просроченном ответе. Администратор видит все сделки, менеджер — только назначенные ему.',
      }),
    });
    const telegramReply = await poll(
      leadId,
      (state) => state.drafts.find((draft) => draft.status === 'pending' && draft.channel === 'telegram'),
      'Telegram conversation reply',
    );
    await call(`/drafts/${telegramReply.result.id}/approve`, { method: 'POST', body: '{}' });
    await poll(leadId, (state) => state.drafts.find((draft) => draft.id === telegramReply.result.id)?.status === 'sent', 'captured Telegram send');

    await call(`/sandbox/${leadId}/documents`, { method: 'POST', body: '{}' });
    if (designEnabled) {
      await call(`/sandbox/${leadId}/design`, { method: 'POST', body: '{}' });
    }

    const completed = await poll(leadId, (state) => {
      const documentsReady = state.documents.some((document) => document.kind === 'specification')
        && state.documents.some((document) => document.kind === 'contract_data')
        && state.documents.some((document) => document.kind === 'codex_handoff');
      const designReady = !designEnabled || state.designs.length > 0;
      return documentsReady && designReady;
    }, 'documents and design');
    const externalWrites = await db.query(
      `SELECT count(*)::int AS count FROM outbound_deliveries
       WHERE lead_id=$1 AND NOT (status='sent' AND external_id LIKE 'sandbox:%' AND error LIKE '[sandbox]%')`,
      [leadId],
    );
    if (externalWrites.rows[0].count !== 0) throw new Error('Sandbox delivery escaped the capture guard');
    const selectedSteps = completed.state.steps.filter((step) => designEnabled || step.key !== 'design');
    const incomplete = selectedSteps.filter((step) => !step.done);
    if (incomplete.length) throw new Error(`Incomplete protocol: ${incomplete.map((step) => step.key).join(', ')}`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      leadId,
      completedSteps: completed.state.steps.filter((step) => step.done).map((step) => step.key),
      deliveries: completed.state.deliveries.map((delivery) => ({ status: delivery.status, externalId: delivery.external_id, error: delivery.error })),
      documents: completed.state.documents.map((document) => document.kind),
      designs: completed.state.designs.length,
      messagesByChannel: completed.state.messages.reduce((counts, message) => ({
        ...counts,
        [message.channel]: (counts[message.channel] || 0) + 1,
      }), {}),
      requirements: completed.state.requirements.length,
      protocol: `${selectedSteps.filter((step) => step.done).length}/${selectedSteps.length}`,
      externalWrites: 0,
    }, null, 2)}\n`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
