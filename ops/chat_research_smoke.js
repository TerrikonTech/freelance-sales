const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('/app/apps/api/dist/app.module.js');
const { DatabaseService } = require('/app/apps/api/dist/database.service.js');
const { SalesAgentService } = require('/app/apps/api/dist/sales-agent.service.js');

const scenarios = [
  {
    key: 'fl-bundle',
    channel: 'fl',
    pipelineStage: 'conversation',
    client: { sandbox: true, fl_dialog_id: 'chat-lab-fl-bundle' },
    messages: [
      ['outbound', 'Савелий', 'Подскажите, откуда сейчас берутся каталог и остатки?'],
      ['inbound', 'Тестовый клиент', 'Каталог уже есть.'],
      ['inbound', 'Тестовый клиент', 'Остатки приходят из МойСклад.'],
      ['inbound', 'Тестовый клиент', 'Оплата — ЮKassa.'],
    ],
  },
  {
    key: 'commercial-stop',
    channel: 'fl',
    pipelineStage: 'discovery',
    client: { sandbox: true, fl_dialog_id: 'chat-lab-commercial' },
    messages: [
      ['outbound', 'Савелий', 'Путь заказа понятен, осталось зафиксировать границы первого этапа.'],
      ['inbound', 'Тестовый клиент', 'Сколько будет стоить и успеете до конца месяца?'],
    ],
  },
  {
    key: 'telegram-spec',
    channel: 'telegram',
    pipelineStage: 'proposal',
    client: { sandbox: true, telegram_chat_id: 'chat-lab-telegram' },
    messages: [
      ['outbound', 'Савелий', 'Зафиксирую два статуса push, чтобы не раздувать первый этап.'],
      ['inbound', 'Тестовый клиент', 'Да, пуш нужен только когда заказ собран и когда передан в доставку.'],
    ],
    requirements: [
      ['product', 'platforms', 'Платформы', ['iOS', 'Android']],
      ['catalog', 'source', 'Источник каталога', 'Действующая система'],
      ['payment', 'test_flow', 'Оплата', 'Тестовый платёж'],
    ],
  },
];

async function insertScenario(db, scenario) {
  const lead = await db.query(
    `INSERT INTO leads(source,external_id,title,description,status,client,pipeline_stage)
     VALUES('sandbox',$1,$2,$3,'contacted',$4,$5) RETURNING id`,
    [
      `chat-research-${scenario.key}-${Date.now()}`,
      `[CHAT LAB] ${scenario.key}`,
      'Изолированная проверка логики общения по исследованию.',
      JSON.stringify(scenario.client),
      scenario.pipelineStage,
    ],
  );
  const leadId = lead.rows[0].id;
  let lastInbound = null;
  for (let index = 0; index < scenario.messages.length; index += 1) {
    const [direction, author, content] = scenario.messages[index];
    const inserted = await db.query(
      `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
       VALUES($1,$2,$3,$4,$5,$6,'{"sandbox":true}'::jsonb) RETURNING id`,
      [leadId, scenario.channel, `${scenario.key}-${index}-${Date.now()}`, direction, author, content],
    );
    if (direction === 'inbound') lastInbound = inserted.rows[0].id;
  }
  await db.query('UPDATE leads SET last_inbound_message_id=$2 WHERE id=$1', [leadId, lastInbound]);
  for (const [category, slug, title, value] of scenario.requirements || []) {
    await db.query(
      `INSERT INTO sales_requirements(lead_id,category,slug,title,value,status,required,confidence)
       VALUES($1,$2,$3,$4,$5,'confirmed',true,100)`,
      [leadId, category, slug, title, JSON.stringify(value)],
    );
  }
  return leadId;
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const db = app.get(DatabaseService);
  const agent = app.get(SalesAgentService);
  const leadIds = [];
  const results = [];
  try {
    for (const scenario of scenarios) {
      const leadId = await insertScenario(db, scenario);
      leadIds.push(leadId);
      const turn = await agent.prepareTurn(leadId, scenario.channel);
      results.push({
        key: scenario.key,
        conversationStage: turn.conversation_stage,
        confidence: turn.confidence,
        reply: turn.reply,
        requiresOwner: turn.requires_owner,
        ownerBrief: turn.owner_brief,
        nextAction: turn.next_action,
        riskFlags: turn.risk_flags,
        requirements: turn.requirements.map((item) => ({
          slug: item.slug,
          value: item.value,
          status: item.status,
        })),
      });
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    for (const leadId of leadIds) {
      await db.query('DELETE FROM leads WHERE id=$1', [leadId]);
    }
    await app.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
