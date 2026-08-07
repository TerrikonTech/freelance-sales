import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { OutboundDeliveryUnknownError } from './outbound-errors';
import { QueueService } from './queue.service';
import { SalesAgentService } from './sales-agent.service';
import { AutonomyService } from './autonomy.service';
import { CodexTaskService } from './codex-task.service';
import { SettingsService } from './settings.service';

export function telegramOnDemandOnly(value = process.env.TELEGRAM_ON_DEMAND_ONLY): boolean {
  return !/^(?:0|false|off|no)$/i.test(String(value || 'true').trim());
}

export function shouldQueueAutomaticTelegramDraft(
  live: boolean,
  value = process.env.TELEGRAM_ON_DEMAND_ONLY,
): boolean {
  return live && !telegramOnDemandOnly(value);
}

export function isOwnerSendCommand(text: string): boolean {
  return /^(?:отправь(?:те)?|отправляй(?:те)?|отправляем|да,?\s*(?:отправь(?:те)?|отправляй(?:те)?)|подтверждаю\s+отправку)[.!\s]*$/i.test(text.trim());
}

export type OwnerOutboundRequest = {
  instructions: string;
  recipient: string | null;
  sendNow: boolean;
};

export type OwnerSendApproval = {
  recipient: string | null;
};

export type OwnerDesignRequest = {
  instructions: string;
  referenceUrl: string | null;
  count: number;
};

export function parseOwnerDesignRequest(text: string): OwnerDesignRequest | null {
  const normalized = stripLeadIn(text);
  if (!/^(?:сгенерируй|создай|сделай|подготовь)(?:\s|$)/iu.test(normalized)) return null;
  if (!/(?:дизайн|концепц|макет|эскиз)/iu.test(normalized)) return null;
  const referenceUrl = normalized.match(/https?:\/\/[^\s<>]+/iu)?.[0]?.replace(/[),.;!?]+$/u, '') || null;
  const countRaw = normalized.match(/\b([1-4])\s+(?:вариант|концепц|макет|эскиз)/iu)?.[1];
  return {
    instructions: normalized.slice(0, 4_000),
    referenceUrl,
    count: countRaw ? Number(countRaw) : 4,
  };
}

export function isOwnerDiscoveryCommand(text: string): boolean {
  const normalized = stripLeadIn(text);
  return /^(?:собери|собирай|начни|продолжи|подготовь|сформируй|напиши)\s+(?:(?:грамотное|полное)\s+)?(?:тз|техническое\s+задание|опрос|интервью)(?:\s+(?:для\s+)?(?:клиента|заказчика))?(?:[,:]?\s+.+)?[.!\s]*$/iu.test(normalized);
}

function startsWithDeferredSendInstruction(value: string): boolean {
  return /^(?:когда|если|потом|позже|пока|только\s+когда|как\s+только|после\s+того\s+как)(?:\s|$|[,.!?])/iu.test(value.trim());
}

/** Filler nouns between the verb and the recipient: "напиши сообщение Олегу …". */
const OUTBOUND_FILLER = /^(?:сообщение|сообщения|ответ|письмо|текст)$/iu;
/** "отправь ему" — the recipient is the lead already in focus, not a name to look up. */
const OUTBOUND_PRONOUN = /^(?:ему|ей|им|его|её|ее)$/iu;
const OUTBOUND_ADDRESSEE = /^(?:заказчику|клиенту|заказчик|клиент)$/iu;
const OUTBOUND_VERB = /^(?:подготовь|напиши|составь|скажи|сформулируй|отправь(?:те)?|отправляй(?:те)?|скинь(?:те)?|пошли(?:те)?)$/iu;
const OUTBOUND_SEND_VERB = /^(?:отправ|скинь|пошли)/iu;
/** Words that can never start a name — they already belong to the instruction. */
const OUTBOUND_NAME_STOP = /^(?:тз|дизайн|макет|концепция|ответ|сообщение|письмо|текст|когда|если|потом|позже|пока|только|как|но|ему|ей|им|это|эту|его|ее|её|их|что|чтобы|про|на|по|о|об|за|в|с|и|или|сколько|какой|какая|какие|где|кто|зачем|почему)$/iu;

const trimWord = (value: string) => value.replace(/[.,!?…:;]+$/u, '');

function isCapitalised(word: string): boolean {
  const first = Array.from(word)[0] || '';
  return first === first.toLocaleUpperCase('ru-RU') && first !== first.toLocaleLowerCase('ru-RU');
}

/**
 * Owner speech is messy: "Напиши сообщение и отправь Олегу Зотову на эльфийском …".
 * Walk the words instead of one rigid regex: verb, optional filler noun,
 * optional second verb ("и отправь" — that is what turns a draft into a send),
 * then the recipient (pronoun, "клиенту", or up to three name words).
 */
export function parseOwnerOutboundRequest(text: string): OwnerOutboundRequest | null {
  const words = stripLeadIn(text).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const head = trimWord(words[0]);
  if (!OUTBOUND_VERB.test(head)) return null;
  let sendNow = OUTBOUND_SEND_VERB.test(head);
  let i = 1;
  if (i < words.length && OUTBOUND_FILLER.test(trimWord(words[i]))) i += 1;

  // "напиши сообщение и отправь …" — the second verb carries the real intent.
  if (i + 1 < words.length) {
    const conjunction = trimWord(words[i]).toLowerCase();
    const second = trimWord(words[i + 1]);
    if (/^(?:и|а|потом|затем)$/iu.test(conjunction) && OUTBOUND_VERB.test(second)) {
      // "потом отправь" is deferred — never turn it into an immediate send.
      if (/^(?:потом|затем)$/iu.test(conjunction)) return null;
      if (OUTBOUND_SEND_VERB.test(second)) sendNow = true;
      i += 2;
      if (i < words.length && OUTBOUND_FILLER.test(trimWord(words[i]))) i += 1;
    }
  }
  if (i >= words.length) return null;

  let recipient: string | null = null;
  const target = trimWord(words[i]);
  if (OUTBOUND_ADDRESSEE.test(target) || OUTBOUND_PRONOUN.test(target)) {
    i += 1;
    if (i < words.length && OUTBOUND_FILLER.test(trimWord(words[i]))) i += 1;
  } else {
    const nameWords: string[] = [];
    while (nameWords.length < 3 && i < words.length) {
      const word = trimWord(words[i]);
      if (!/^[\p{L}][\p{L}-]{1,50}$/u.test(word) || OUTBOUND_NAME_STOP.test(word)) break;
      // A surname only continues the name when it is capitalised: "Олегу Зотову",
      // but "Олегу привет" must stop after the first word.
      if (nameWords.length && !isCapitalised(word)) break;
      nameWords.push(word);
      i += 1;
    }
    if (!nameWords.length) return null;
    recipient = nameWords.join(' ');
    if (i < words.length && OUTBOUND_FILLER.test(trimWord(words[i]))) i += 1;
    // A lowercase first word is only a name when the owner explicitly said "отправь".
    if (!sendNow && !isCapitalised(nameWords[0])) return null;
  }

  const instructions = words.slice(i).join(' ').replace(/^[,:;]\s*/u, '').trim();
  if (!instructions) return null;
  if (sendNow && startsWithDeferredSendInstruction(instructions)) return null;
  return { instructions, recipient, sendNow };
}

export function parseOwnerSendApproval(text: string): OwnerSendApproval | null {
  if (isOwnerSendCommand(text)) return { recipient: null };
  const normalized = stripLeadIn(text);
  const named = normalized.match(
    /^(?:отправь(?:те)?|отправляй(?:те)?|скинь(?:те)?|пошли(?:те)?)\s+((?:[\p{L}][\p{L}-]{1,50})(?:\s+[\p{L}][\p{L}-]{1,50})?)[.!\s]*$/iu,
  );
  if (!named?.[1]) return null;
  const value = named[1].trim();
  const parts = value.split(/\s+/);
  if (/^(?:потом|позже|когда|если|пока|только|сообщение|ответ|письмо|текст)$/iu.test(parts[0])) return null;
  // "отправь Олегу привет" is a compose-and-send, not an approval — leave it to the outbound parser.
  if (parts.length === 2 && !isCapitalised(parts[1])) return null;
  if (OUTBOUND_ADDRESSEE.test(value)) return { recipient: null };
  if (OUTBOUND_PRONOUN.test(value)) return { recipient: null };
  return { recipient: value };
}

export function ownerOutboundInstructions(text: string): string | null {
  return parseOwnerOutboundRequest(text)?.instructions || null;
}

export function looksLikeOwnerDeliveryCommand(text: string): boolean {
  const normalized = stripLeadIn(text);
  return /^(?:(?:не|пока\s+не)\s+)?(?:отправ|скин|пошл)/iu.test(normalized)
    || /^(?:подготовь|напиши|составь|скажи|сформулируй)\s+(?:(?:ответ|сообщение|письмо)\s+)?(?:заказчику|клиенту)(?:\s|$)/iu.test(normalized)
    // "напиши сообщение и потом отправь …": the owner did ask to send, so explain the refusal
    // instead of dropping the phrase into the analytical path.
    || /^(?:подготовь|напиши|составь|скажи|сформулируй)(?:\s|$).*(?:^|\s)(?:и|а|потом|затем)\s+(?:отправь|отправляй|скинь|пошли)/iu.test(normalized);
}

/** Voice input arrives as "Так, смотри, общайся с Олегом…" — drop the lead-in before matching. */
/**
 * "отправь если он ответит" — a delivery verb tied to a condition. This class stays
 * deterministic on purpose: sending early is irreversible, so we refuse and explain
 * rather than let the model guess the owner meant "now".
 */
export function looksLikeDeferredDeliveryCommand(text: string): boolean {
  return looksLikeOwnerDeliveryCommand(text)
    && /(?:^|\s)(?:когда|если|потом|позже|пока)(?:\s|[,.!?]|$)/iu.test(stripLeadIn(text));
}

export function stripLeadIn(text: string): string {
  let value = text.replace(/\s+/g, ' ').trim();
  const leadIn = /^(?:так|смотри|слушай|давай|ок(?:ей)?|ладно|ну|а|и|вот|пожалуйста|плиз)[,!.…]*\s+/iu;
  for (let i = 0; i < 4 && leadIn.test(value); i += 1) value = value.replace(leadIn, '');
  return value.trim();
}

/** "Олегом" / "Олега" -> "Олег": Russian case endings break a plain ILIKE match. */
export function stemRecipient(name: string): string {
  const word = name.trim().replace(/[.,!?…]+$/u, '');
  const stem = word.replace(/(?:ом|ем|ой|ей|ым|им|а|я|у|ю|е|ы|и)$/iu, '');
  return stem.length >= 3 ? stem : word;
}

/** One command the model extracted from a free-form owner message. */
export type OwnerIntent = {
  intent:
    | 'send_message' | 'draft_message' | 'approve_send'
    | 'start_mission' | 'stop_mission' | 'mission_status' | 'list_missions'
    | 'select_lead' | 'list_clients' | 'overview'
    | 'design_concept' | 'collect_spec' | 'question' | 'clarify';
  recipient: string | null;
  instruction: string | null;
  question: string | null;
  confidence: number;
  restated: string;
  deadline?: 'today' | 'tomorrow' | null;
  max_turns?: number | null;
  reference_url?: string | null;
  count?: number | null;
};

/** The question the agent asked plus the command it could not finish without an answer. */
export type OwnerPendingIntent = {
  text: string;
  question: string;
  intent: OwnerIntent;
  askedAt: string;
};

export type OwnerMissionStart = {
  recipient: string;
  instruction: string;
  deadline: Date | null;
  maxTurns: number | null;
  /** "Олег Зотов" before "Олег": longest name first, so a surname wins over a bare first name. */
  candidates: Array<{ recipient: string; instruction: string }>;
};

/** Words that can never be part of a name — they start the instruction. */
const NAME_STOP = /^(?:только|на|по|до|и|или|чтобы|сам|сама|самостоятельно|сегодня|завтра|пока|как|про|за|в|с|о|об|же|ему|ей|максимум|напиши)$/iu;

function parseMissionDeadline(text: string): Date | null {
  const now = new Date();
  const endOfDay = (base: Date) => {
    const d = new Date(base);
    d.setHours(23, 59, 59, 0);
    return d;
  };
  if (/до\s+конца\s+дня|сегодня/iu.test(text)) return endOfDay(now);
  if (/завтра/iu.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return endOfDay(d);
  }
  const hours = text.match(/(?:в\s+течение\s+)?(\d{1,2})\s*час/iu);
  if (hours) return new Date(now.getTime() + Number(hours[1]) * 3_600_000);
  return null;
}

function parseMissionTurns(text: string): number | null {
  const turns = text.match(/(\d{1,2})\s*(?:ход|сообщен|ответ)/iu);
  return turns ? Number(turns[1]) : null;
}

/** «веди Олега сам», «общайся с Олегом на эльфийском», «веди Олега до ТЗ до конца дня» */
export function parseOwnerMissionStart(text: string): OwnerMissionStart | null {
  const normalized = stripLeadIn(text);
  const patterns: RegExp[] = [
    /^(?:общайся|переписывайся|говори|веди\s+диалог)\s+с\s+(.+)$/iu,
    /^веди\s+(?:сам(?:остоятельно)?\s+)?(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const tail = match[1].trim();
    const words = tail.split(/\s+/);

    // How many leading words can still be part of the name?
    let nameLength = 0;
    while (nameLength < Math.min(3, words.length)) {
      const word = words[nameLength].replace(/[.,!?…:;]+$/u, '');
      if (!/^[\p{L}][\p{L}-]{1,40}$/u.test(word) || NAME_STOP.test(word)) break;
      nameLength += 1;
    }
    if (!nameLength) continue;

    const candidates: Array<{ recipient: string; instruction: string }> = [];
    for (let take = nameLength; take >= 1; take -= 1) {
      const recipient = words.slice(0, take)
        .map((word) => stemRecipient(word.replace(/[.,!?…:;]+$/u, '')))
        .join(' ')
        .trim();
      const instruction = words.slice(take).join(' ').trim();
      if (!recipient || /^(?:себя|меня|себе)$/iu.test(recipient)) continue;
      candidates.push({ recipient, instruction });
    }
    // Keep only variants that still leave an instruction, unless nothing else is left.
    const usable = candidates.filter((item) => item.instruction) ;
    const list = usable.length ? usable : candidates;
    if (!list.length) continue;
    const best = list[0];
    return {
      recipient: best.recipient,
      instruction: best.instruction.slice(0, 2_000),
      deadline: parseMissionDeadline(best.instruction),
      maxTurns: parseMissionTurns(best.instruction),
      candidates: list.map((item) => ({ recipient: item.recipient, instruction: item.instruction.slice(0, 2_000) })),
    };
  }
  return null;
}

/** «1» / «2» — picking one of the numbered options the bot just offered. */
export function parseOwnerChoice(text: string): number | null {
  const normalized = stripLeadIn(text).replace(/[.)\]]+$/u, '').trim();
  if (!/^\d{1,2}$/.test(normalized)) return null;
  const index = Number(normalized);
  return index >= 1 && index <= 20 ? index : null;
}

/** «стоп по Олегу», «стоп», «хватит с Олегом» -> recipient null = текущий клиент */
export function parseOwnerMissionStop(text: string): { recipient: string | null } | null {
  const normalized = stripLeadIn(text);
  if (/^(?:стоп|хватит|прекрати|отбой)[.!…\s]*$/iu.test(normalized)) return { recipient: null };
  const named = normalized.match(/^(?:стоп|хватит|прекрати|отбой)\s+(?:по|с|со)\s+([\p{L}][\p{L}-]{1,40})[.!…\s]*$/iu);
  if (named) return { recipient: stemRecipient(named[1]) };
  return null;
}

/** «что там у Олега», «задачи» */
export function parseOwnerMissionStatus(text: string): { recipient: string | null } | null {
  const normalized = stripLeadIn(text);
  if (/^(?:задачи|мои\s+задачи|активные\s+задачи)[.!?…\s]*$/iu.test(normalized)) return { recipient: null };
  const named = normalized.match(/^что\s+там\s+(?:у|с)\s+([\p{L}][\p{L}-]{1,40})[.!?…\s]*$/iu);
  if (named) return { recipient: stemRecipient(named[1]) };
  return null;
}

export function ownerDeliveryResultMessage(result: {
  status: 'sent' | 'failed' | 'send_unknown' | 'blocked';
  leadTitle: string;
  channel: string;
  error?: string | null;
}): string {
  const channel = result.channel === 'telegram' ? 'Telegram' : result.channel === 'fl' ? 'FL.ru' : result.channel;
  if (result.status === 'sent') {
    return /\[userbot\]/i.test(String(result.error || ''))
      ? `✅ Отправлено клиенту «${result.leadTitle}» — с вашего аккаунта в ${channel}.`
      : `✅ Отправлено клиенту «${result.leadTitle}» через ${channel}.`;
  }
  if (result.status === 'send_unknown') {
    return `Статус отправки клиенту «${result.leadTitle}» неизвестен. Автоповтор отключён; проверьте ${channel} вручную.`;
  }
  const reason = String(result.error || 'причина не указана').slice(0, 500);
  // Bot API cannot write into chats mirrored from the owner's personal account.
  // The owner-session bridge picks these up within seconds, so do not claim failure.
  if (/BUSINESS_PEER_INVALID/i.test(reason)) {
    return `Отправляю «${result.leadTitle}» с вашего аккаунта — обычно это занимает полминуты. Сообщу, как только уйдёт.`;
  }
  return `Не отправлено клиенту «${result.leadTitle}» через ${channel}. Причина: ${reason}`;
}

export function qualifiedLeadTelegramMessage(result: {
  title: string;
  score: number;
  price: number;
  days: number;
  fitReason?: string | null;
  url?: string | null;
}): string {
  const reason = String(result.fitReason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return [
    `🔥 Подходящий заказ на FL.ru: «${result.title}»`,
    `${result.score}/100 · ${result.price.toLocaleString('ru-RU')} ₽ · ${result.days} дн.`,
    reason,
    result.url || '',
    'Если подходит — откройте заказ и нажмите «Сгенерировать отклик». Ничего не отправлено автоматически.',
  ].filter(Boolean).join('\n\n');
}

export function flInboundTelegramMessage(result: {
  title: string;
  author?: string | null;
  content: string;
  url?: string | null;
}): string {
  return [
    `💬 Новое сообщение на FL.ru по «${result.title}»`,
    `${String(result.author || 'Заказчик').slice(0, 120)}: ${String(result.content || '').replace(/\s+/g, ' ').trim().slice(0, 1_200)}`,
    result.url || '',
    'Черновик ответа готовится. Клиенту ничего не отправлено автоматически.',
  ].filter(Boolean).join('\n\n');
}

@Injectable()
export class TelegramService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly agent: SalesAgentService,
    private readonly autonomy: AutonomyService,
    private readonly tasks: CodexTaskService,
  ) {}

  async configureWebhook() {
    const token = await this.settings.getSecret('telegram_bot_token');
    const secret = await this.settings.getSecret('telegram_webhook_secret');
    const publicUrl = process.env.PUBLIC_URL;
    if (!token || !secret || !publicUrl) throw new Error('Telegram или PUBLIC_URL не настроены');
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${publicUrl}/api/connectors/telegram/webhook`,
        secret_token: secret,
        allowed_updates: [
          'message',
          'edited_message',
          'business_connection',
          'business_message',
          'edited_business_message',
          'deleted_business_messages',
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    await this.settings.setConnectorState('telegram', { enabled: true, healthy: true, statusText: 'Webhook подключён', success: true });
    return { ok: true };
  }

  async verifyWebhookSecret(header: string | undefined) {
    const expected = await this.settings.getSecret('telegram_webhook_secret');
    return Boolean(expected && header && expected === header);
  }

  async processUpdate(update: Record<string, any>) {
    const ownerMessage = update.message || update.edited_message;
    if (ownerMessage?.chat?.id) {
      const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
      if (owner?.id && Number(ownerMessage.from?.id) === Number(owner.id)) {
        await this.queue.add(
          'owner-command',
          { message: ownerMessage },
          `owner-command-${String(ownerMessage.chat.id)}-${String(ownerMessage.message_id)}`,
        );
      }
      return;
    }
    if (update.business_connection) {
      const connection = update.business_connection;
      await this.settings.setSecret('telegram_business_connection_id', String(connection.id));
      await this.settings.setPublic('telegram_owner', { id: connection.user?.id, username: connection.user?.username || null });
      await this.settings.setConnectorState('telegram', { enabled: true, healthy: true, statusText: 'Business-аккаунт подключён', success: true });
      return;
    }
    const message = update.business_message || update.edited_business_message;
    if (!message?.chat?.id || !message.text) return;
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    const outbound = owner?.id && message.from?.id === owner.id;
    const chatId = String(message.chat.id);
    const externalLeadId = `telegram:${chatId}`;
    const linkedLeadId = await this.agent.resolveTelegramLead(chatId, message.text);
    let leadId = linkedLeadId;
    if (!leadId) {
      const lead = await this.db.query<{ id: string }>(
        `SELECT COALESCE(
           (SELECT lead_id FROM lead_channels WHERE channel='telegram' AND external_id=$1),
           (SELECT id FROM leads WHERE source='telegram' AND external_id=$2)
         ) AS id`,
        [chatId, externalLeadId],
      );
      leadId = lead.rows[0]?.id || null;
    }
    if (!leadId) {
      const created = await this.db.query<{ id: string }>(
        `INSERT INTO leads(source,external_id,title,description,status,client)
         VALUES('telegram',$1,$2,'Диалог из Telegram','contacted',$3) RETURNING id`,
        [externalLeadId, `Telegram: ${message.chat.first_name || message.chat.username || chatId}`, JSON.stringify({ telegram_chat_id: chatId, username: message.chat.username || null })],
      );
      leadId = created.rows[0].id;
    }
    await this.agent.registerLeadChannel(leadId, 'telegram', chatId);
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)
       VALUES($1,'telegram',$2,$3,$4,$5,$6)
       ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
      [
        leadId,
        `${chatId}:${String(message.message_id)}`,
        outbound ? 'outbound' : 'inbound',
        message.from?.first_name || null,
        message.text,
        JSON.stringify({ date: message.date, transport: 'bot_api' }),
      ],
    );
    if (!inserted.rows[0]) return;
    if (!outbound) {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE leads SET last_inbound_message_id=$2,
           pipeline_stage=CASE WHEN pipeline_stage IN ('new','qualified','outreach','conversation','telegram_handoff')
             THEN 'discovery' ELSE pipeline_stage END,
           client=client || $3::jsonb,updated_at=now() WHERE id=$1`,
          [
            leadId,
            inserted.rows[0].id,
            JSON.stringify({
              telegram_chat_id: chatId,
              telegram_username: message.chat.username || null,
            }),
          ],
        );
        await client.query("UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'", [leadId]);
      });
      if (shouldQueueAutomaticTelegramDraft(true)) {
        await this.queue.add(
          'draft-reply',
          { leadId, channel: 'telegram', targetExternalId: chatId },
          `tg-draft-${inserted.rows[0].id}`,
        );
      }
    }
  }

  async ingestMtprotoMessages(
    items: Array<{
      chatId?: string | number;
      messageId?: string | number;
      direction?: string;
      text?: string;
      label?: string;
      createdAt?: string | number;
      live?: boolean;
      voice?: boolean;
    }>,
  ) {
    let insertedCount = 0;
    let queuedCount = 0;
    for (const item of items.slice(0, 500)) {
      const chatId = String(item.chatId || '').trim();
      const messageId = String(item.messageId || '').trim();
      const text = String(item.text || '').trim().slice(0, 8_000);
      const direction = item.direction === 'outbound' ? 'outbound' : 'inbound';
      if (!chatId || !messageId || !text) continue;
      const linked = await this.db.query<{ id: string }>(
        `SELECT COALESCE(
           (SELECT lead_id FROM lead_channels WHERE channel='telegram' AND external_id=$1),
           (SELECT id FROM leads WHERE source='telegram' AND external_id=$2)
         ) AS id`,
        [chatId, `telegram:${chatId}`],
      );
      let leadId = linked.rows[0]?.id || null;
      if (!leadId) {
        const created = await this.db.query<{ id: string }>(
          `INSERT INTO leads(source,external_id,title,description,status,client,pipeline_stage)
           VALUES('telegram',$1,$2,'Диалог из Telegram','contacted',$3,'conversation')
           ON CONFLICT(source,external_id) DO UPDATE SET
             title=EXCLUDED.title,client=leads.client || EXCLUDED.client,updated_at=now()
           RETURNING id`,
          [
            `telegram:${chatId}`,
            String(item.label || `Telegram: ${chatId}`).slice(0, 300),
            JSON.stringify({ telegram_chat_id: chatId }),
          ],
        );
        leadId = created.rows[0].id;
      }
      await this.agent.registerLeadChannel(leadId, 'telegram', chatId);
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO messages(
           lead_id,channel,external_id,direction,author,content,metadata,created_at
         ) VALUES($1,'telegram',$2,$3,$4,$5,$6,
           CASE WHEN $7::text ~ '^[0-9]+$'
             THEN to_timestamp($7::double precision) ELSE now() END)
         ON CONFLICT(channel,external_id) DO NOTHING RETURNING id`,
        [
          leadId,
          `${chatId}:${messageId}`,
          direction,
          String(item.label || '').slice(0, 200) || null,
          text,
          JSON.stringify({ transport: 'mtproto', voice: item.voice === true }),
          String(item.createdAt || ''),
        ],
      );
      if (!inserted.rows[0]) continue;
      insertedCount += 1;
      if (direction === 'inbound') {
        await this.db.transaction(async (client) => {
          await client.query(
            `UPDATE leads SET last_inbound_message_id=$2,
             pipeline_stage=CASE WHEN pipeline_stage IN (
               'new','qualified','outreach','conversation','telegram_handoff'
             ) THEN 'discovery' ELSE pipeline_stage END,
             client=client || $3::jsonb,updated_at=now() WHERE id=$1`,
            [leadId, inserted.rows[0].id, JSON.stringify({ telegram_chat_id: chatId })],
          );
          await client.query(
            "UPDATE drafts SET status='stale',updated_at=now() WHERE lead_id=$1 AND status='pending'",
            [leadId],
          );
        });
        if (shouldQueueAutomaticTelegramDraft(item.live === true)) {
          await this.queue.add(
            'draft-reply',
            { leadId, channel: 'telegram', targetExternalId: chatId },
            `mtproto-draft-${inserted.rows[0].id}`,
          );
          queuedCount += 1;
        }
      }
    }
    return { inserted: insertedCount, queued: queuedCount };
  }

  /** Stores the task on one lead and reports the frame back to the owner. */
  private async startMission(
    leadId: string,
    leadTitle: string,
    input: { instruction: string; deadline: Date | null; maxTurns: number | null },
  ): Promise<string> {
    const mission = await this.autonomy.setMission({
      leadId,
      instruction: input.instruction || 'веди диалог сам',
      deadline: input.deadline,
      maxTurns: input.maxTurns ?? 10,
    });
    const until = mission.deadline
      ? new Date(mission.deadline).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
      : 'без срока';
    return `Принял. «${leadTitle}» — веду сам.\nЗадача: ${mission.instruction}\nПотолок: ${mission.max_turns} ответов · срок: ${until}\nЦена, договор, сроки и любые обещания всё равно принесу вам.\nОстановить: «стоп по ${leadTitle.split(' ')[0]}».`;
  }

  /**
   * Everything the cheap patterns could not classify goes through the model.
   * It returns one command; when it is unsure it asks the owner a question and we
   * keep the half-built command so the plain-language answer completes it.
   */
  private async routeOwnerIntent(
    ownerId: string,
    chatId: string,
    text: string,
    pending: OwnerPendingIntent | null,
  ): Promise<void> {
    const carried = pending ?? await this.loadPendingIntent(ownerId);
    // Context is a nicety; never let gathering it swallow the owner's command.
    const active = await this.safely(() => this.agent.ownerLead(ownerId), null);
    const missions = await this.safely(() => this.autonomy.activeMissions(), [] as any[]);
    let intent: OwnerIntent;
    try {
      intent = await this.tasks.run<OwnerIntent>('owner_intent', {
        message: text.slice(0, 4_000),
        pending: carried
          ? { question: carried.question, earlier_message: carried.text, partial: carried.intent }
          : null,
        active_lead: active ? { title: (active as any).title } : null,
        active_missions: (missions || []).slice(0, 10)
          .map((mission: any) => ({ title: mission.title, instruction: mission.instruction })),
      }, 3 * 60_000);
    } catch (error) {
      await this.sendControlMessage(
        chatId,
        `Не смог разобрать команду: ${error instanceof Error ? error.message : 'ошибка'}. Повторите проще — например «отправь Олегу сообщение …».`,
      );
      return;
    }
    await this.dispatchOwnerIntent(ownerId, chatId, text, intent);
  }

  private async safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch {
      return fallback;
    }
  }

  /** Pending questions go stale: an hour later the owner is talking about something else. */
  private async loadPendingIntent(ownerId: string): Promise<OwnerPendingIntent | null> {
    let carried: OwnerPendingIntent | null = null;
    try {
      carried = await this.agent.takePendingIntent<OwnerPendingIntent>(ownerId);
    } catch {
      return null;
    }
    if (!carried?.askedAt) return null;
    const age = Date.now() - Date.parse(String(carried.askedAt));
    return Number.isFinite(age) && age < 60 * 60_000 ? carried : null;
  }

  private async dispatchOwnerIntent(
    ownerId: string,
    chatId: string,
    text: string,
    intent: OwnerIntent,
  ): Promise<void> {
    const recipient = String(intent.recipient || '').trim() || null;
    const instruction = String(intent.instruction || '').trim();
    const say = (value: string) => this.sendControlMessage(chatId, value);
    const fail = (error: unknown, fallback: string) =>
      say(error instanceof Error ? error.message : fallback);

    try {
      switch (intent.intent) {
        case 'clarify': {
          const question = String(intent.question || '').trim()
            || 'Уточните, пожалуйста: что именно сделать и с кем?';
          await this.agent.setPendingIntent(ownerId, {
            text,
            question,
            intent,
            askedAt: new Date().toISOString(),
          } satisfies OwnerPendingIntent);
          await say(question);
          return;
        }
        case 'list_clients':
          await say(this.formatLeadMatches(await this.agent.recentLeads(12)));
          return;
        case 'overview': {
          const result = await this.agent.answerOwnerOverview(text);
          await say(result.answer);
          return;
        }
        case 'list_missions': {
          const active = await this.autonomy.activeMissions();
          await say(active.length
            ? `Активные задачи:\n${active.map((m: any) => `• ${m.title} — ${m.instruction} (${m.turns_used}/${m.max_turns})`).join('\n')}`
            : 'Активных задач нет — ни одному заказчику я сам не пишу.');
          return;
        }
        case 'select_lead': {
          if (!recipient) { await say('Не понял, какого клиента выбрать.'); return; }
          const found = await this.agent.selectOwnerLead(ownerId, recipient);
          await say(found.selected
            ? `Выбран клиент: ${found.selected.title}.`
            : found.matches.length
              ? `Нашёл несколько вариантов:\n${this.formatLeadMatches(found.matches)}\nУточните название.`
              : `Клиента «${recipient}» не нашёл.`);
          return;
        }
        case 'start_mission': {
          if (!recipient) { await say('Не понял, кого вести. Назовите заказчика.'); return; }
          const candidates = [{ recipient, instruction }];
          const first = recipient.split(/\s+/)[0];
          if (first && first !== recipient) candidates.push({ recipient: first, instruction });
          const found = await this.agent.selectOwnerLeadByCandidates(ownerId, candidates);
          if (found.selected) {
            await say(await this.startMission(found.selected.id, found.selected.title, {
              instruction,
              deadline: intent.deadline === 'today' || intent.deadline === 'tomorrow'
                ? parseMissionDeadline(intent.deadline === 'today' ? 'сегодня' : 'завтра')
                : parseMissionDeadline(instruction),
              maxTurns: Number.isFinite(Number(intent.max_turns)) && Number(intent.max_turns) > 0
                ? Number(intent.max_turns)
                : parseMissionTurns(instruction),
            }));
            return;
          }
          if (found.matches.length) {
            const options = found.matches.slice(0, 9).map((row: any) => ({ id: row.id, title: row.title }));
            await this.agent.setPendingChoice(ownerId, {
              kind: 'mission',
              options,
              mission: { instruction, deadline: null, maxTurns: intent.max_turns ?? null },
            });
            await say(`Кого именно вести?\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}\n\nОтветьте номером — например «1».`);
            return;
          }
          await say(`Клиента «${recipient}» не нашёл. Задачу не ставил.`);
          return;
        }
        case 'stop_mission': {
          let leadId: string | null = null;
          let title = '';
          if (recipient) {
            const found = await this.agent.selectOwnerLead(ownerId, recipient);
            if (found.selected) { leadId = found.selected.id; title = found.selected.title; }
          } else {
            const current = await this.agent.ownerLead(ownerId);
            if (current) { leadId = current.id; title = current.title; }
          }
          if (!leadId) { await say('Не понял, по кому остановить. Напишите «стоп по Олегу».'); return; }
          const stopped = await this.autonomy.stopMission(leadId, 'Остановлено владельцем');
          await say(stopped
            ? `Остановился по «${title}». Дальше — только по вашей команде.`
            : `По «${title}» активной задачи и не было. Ничего не менял.`);
          return;
        }
        case 'mission_status': {
          if (!recipient) {
            const active = await this.autonomy.activeMissions();
            await say(active.length
              ? `Активные задачи:\n${active.map((m: any) => `• ${m.title} — ${m.instruction} (${m.turns_used}/${m.max_turns})`).join('\n')}`
              : 'Активных задач нет.');
            return;
          }
          const found = await this.agent.selectOwnerLead(ownerId, recipient);
          if (!found.selected) { await say(`Клиента «${recipient}» не нашёл.`); return; }
          const mission = await this.autonomy.getMission(found.selected.id);
          await say(mission
            ? `«${found.selected.title}»\nЗадача: ${mission.instruction}\nСтатус: ${mission.active ? 'веду сам' : `остановлена (${mission.stopped_reason || '—'})`}\nХоды: ${mission.turns_used} из ${mission.max_turns}`
            : `По «${found.selected.title}» задачи нет — пишу только по вашей команде.`);
          return;
        }
        case 'design_concept': {
          const queued = await this.agent.queueOwnerDesign(ownerId, {
            instructions: instruction || text,
            referenceUrl: intent.reference_url || null,
            count: Number.isFinite(Number(intent.count)) && Number(intent.count) > 0 ? Number(intent.count) : 4,
          });
          await say(`Запустил ${queued.count} концепции для «${queued.leadTitle}». ${queued.estimatedCostUsd > 0
            ? `Оценка: около $${queued.estimatedCostUsd.toFixed(3)}.`
            : 'Рисует Codex через Hermes — отдельной оплаты нет.'
          } Готовые картинки сначала придут сюда на проверку.`);
          return;
        }
        case 'collect_spec': {
          const prepared = await this.agent.prepareDiscoveryOutbound(ownerId);
          await say(prepared.complete
            ? `По клиенту «${prepared.leadTitle}» ТЗ уже собрано на ${prepared.discoveryReadiness}%. Клиенту ничего не отправлено.`
            : `Следующий вопрос для «${prepared.leadTitle}» · готовность ${prepared.discoveryReadiness}%:\n\n${prepared.content}\n\nКлиенту ничего не отправлено. Если верно — напишите «отправь».`);
          return;
        }
        case 'approve_send': {
          await this.agent.approveOwnerOutbound(ownerId, recipient);
          await say('Ответ одобрен и поставлен на отправку. Когда канал вернёт результат, я сообщу сюда.');
          return;
        }
        case 'send_message':
        case 'draft_message': {
          const prepared = await this.agent.prepareOwnerOutbound(ownerId, instruction || text, recipient);
          const channel = prepared.channel === 'telegram' ? 'Telegram' : 'FL.ru';
          if (intent.intent === 'send_message') {
            await this.agent.approveOwnerOutbound(ownerId, recipient);
            await say(`Понял: ${intent.restated}\n\nСообщение для «${prepared.leadTitle}» поставлено на отправку через ${channel}:\n\n${prepared.content}\n\nКогда канал вернёт результат, я отдельно сообщу.`);
            return;
          }
          await say(`Понял: ${intent.restated}\n\nЧерновик для «${prepared.leadTitle}» · канал: ${channel}:\n\n${prepared.content}\n\nЕсли всё верно, напишите «отправь».`);
          return;
        }
        case 'question':
        default: {
          const lead = await this.agent.ownerLead(ownerId);
          const result = lead
            ? await this.agent.answerOwner(lead.id, text)
            : await this.agent.answerOwnerOverview(text);
          await say(result.answer);
          return;
        }
      }
    } catch (error) {
      await fail(error, 'Не удалось выполнить команду');
    }
  }

  async processOwnerMessage(message: Record<string, any>) {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id || Number(message.from?.id) !== Number(owner.id)) return;
    const ownerId = String(owner.id);
    const chatId = String(message.chat.id);
    const text = String(message.text || message.caption || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      await this.sendControlMessage(
        chatId,
        'Голосовое получено, но единый агент пока не получил его расшифровку. Напишите команду текстом.',
      );
      return;
    }
    if (/^\/(?:start|help)\b/i.test(text)) {
      await this.sendControlMessage(
        chatId,
        'Пишите обычными словами — я разберусь, что нужно. Если не пойму — задам один вопрос и запомню, о чём шла речь: ответьте коротко, и я доделаю начатое. Сам клиенту ничего не отправляю. «Напиши Олегу …» — покажу черновик, «отправь Олегу …» — поставлю на отправку. Могу: показать клиентов и сводку, собрать ТЗ, сделать концепции дизайна. Задачи: «общайся с Олегом на эльфийском» или «веди Олега до ТЗ до конца дня» — и я отвечаю ему сам, пока не скажете «стоп по Олегу». Цена, договор и сроки всегда приходят к вам.',
      );
      return;
    }
    if (
      /^\/(?:clients|клиенты)\b/i.test(text)
      || /^(?:покажи|список)\s+клиент/i.test(text)
    ) {
      await this.sendControlMessage(chatId, this.formatLeadMatches(await this.agent.recentLeads(12)));
      return;
    }
    if (/^(?:обзор|сводка|что\s+нового|что\s+важного|приоритеты)(?:\s|$)/i.test(text)) {
      try {
        const result = await this.agent.answerOwnerOverview(text);
        await this.sendControlMessage(chatId, result.answer);
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось подготовить обзор',
        );
      }
      return;
    }
    const select = text.match(/^(?:работаем\s+с|выбери(?:\s+клиента)?|клиент)\s+(.+)$/i);
    if (select) {
      const result = await this.agent.selectOwnerLead(ownerId, select[1]);
      if (result.selected) {
        await this.sendControlMessage(
          chatId,
          `Выбран клиент: ${result.selected.title}. Теперь задавайте вопросы или попросите подготовить ответ.`,
        );
      } else {
        await this.sendControlMessage(
          chatId,
          result.matches.length
            ? `Нашёл несколько вариантов:\n${this.formatLeadMatches(result.matches)}\nУточните название.`
            : 'Клиента по такому запросу не нашёл.',
        );
      }
      return;
    }
    const choice = parseOwnerChoice(text);
    if (choice) {
      const pending = await this.agent.takePendingChoice<{
        kind: string;
        options: Array<{ id: string; title: string }>;
        mission?: { instruction: string; deadline: string | null; maxTurns: number | null };
      }>(ownerId);
      if (pending?.kind === 'mission' && pending.options?.length) {
        const picked = pending.options[choice - 1];
        if (!picked) {
          await this.sendControlMessage(chatId, `Такого номера не было. Повторите команду целиком.`);
          return;
        }
        await this.sendControlMessage(chatId, await this.startMission(picked.id, picked.title, {
          instruction: pending.mission?.instruction || '',
          deadline: pending.mission?.deadline ? new Date(pending.mission.deadline) : null,
          maxTurns: pending.mission?.maxTurns ?? null,
        }));
        return;
      }
    }

    const missionStart = parseOwnerMissionStart(text);
    if (missionStart) {
      const found = await this.agent.selectOwnerLeadByCandidates(ownerId, missionStart.candidates);
      if (found.selected) {
        const used = found.used || missionStart.candidates[0];
        await this.sendControlMessage(chatId, await this.startMission(found.selected.id, found.selected.title, {
          instruction: used.instruction || missionStart.instruction,
          deadline: parseMissionDeadline(used.instruction || missionStart.instruction),
          maxTurns: parseMissionTurns(used.instruction || missionStart.instruction),
        }));
        return;
      }
      if (found.matches.length) {
        const options = found.matches.slice(0, 9).map((row: any) => ({ id: row.id, title: row.title }));
        await this.agent.setPendingChoice(ownerId, {
          kind: 'mission',
          options,
          mission: {
            instruction: missionStart.instruction,
            deadline: missionStart.deadline ? missionStart.deadline.toISOString() : null,
            maxTurns: missionStart.maxTurns,
          },
        });
        const list = options.map((option, index) => `${index + 1}. ${option.title}`).join('\n');
        await this.sendControlMessage(
          chatId,
          `Кого именно вести?\n${list}\n\nОтветьте номером — например «1», и я сразу возьму его с той же задачей.`,
        );
        return;
      }
      await this.sendControlMessage(chatId, `Клиента «${missionStart.recipient}» не нашёл. Задачу не ставил.`);
      return;
    }

    const missionStop = parseOwnerMissionStop(text);
    if (missionStop) {
      let leadId: string | null = null;
      let title = '';
      if (missionStop.recipient) {
        const found = await this.agent.selectOwnerLead(ownerId, missionStop.recipient);
        if (found.selected) { leadId = found.selected.id; title = found.selected.title; }
      } else {
        const current = await this.agent.ownerLead(ownerId);
        if (current) { leadId = current.id; title = current.title; }
      }
      if (!leadId) {
        await this.sendControlMessage(chatId, 'Не понял, по кому остановить. Напишите «стоп по Олегу».');
        return;
      }
      const stopped = await this.autonomy.stopMission(leadId, 'Остановлено владельцем');
      await this.sendControlMessage(
        chatId,
        stopped
          ? `Остановился по «${title}». Дальше — только по вашей команде.`
          : `По «${title}» активной задачи и не было. Ничего не менял.`,
      );
      return;
    }

    const missionStatus = parseOwnerMissionStatus(text);
    if (missionStatus) {
      if (!missionStatus.recipient) {
        const active = await this.autonomy.activeMissions();
        await this.sendControlMessage(
          chatId,
          active.length
            ? `Активные задачи:\n${active.map((m) => `• ${m.title} — ${m.instruction} (${m.turns_used}/${m.max_turns})`).join('\n')}`
            : 'Активных задач нет — ни одному заказчику я сам не пишу.',
        );
        return;
      }
      const found = await this.agent.selectOwnerLead(ownerId, missionStatus.recipient);
      if (!found.selected) {
        await this.sendControlMessage(chatId, `Клиента «${missionStatus.recipient}» не нашёл.`);
        return;
      }
      const mission = await this.autonomy.getMission(found.selected.id);
      await this.sendControlMessage(
        chatId,
        mission
          ? `«${found.selected.title}»\nЗадача: ${mission.instruction}\nСтатус: ${mission.active ? 'веду сам' : `остановлена (${mission.stopped_reason || '—'})`}\nХоды: ${mission.turns_used} из ${mission.max_turns}`
          : `По «${found.selected.title}» задачи нет — пишу только по вашей команде.`,
      );
      return;
    }

    const design = parseOwnerDesignRequest(text);
    if (design) {
      try {
        const queued = await this.agent.queueOwnerDesign(ownerId, design);
        await this.sendControlMessage(
          chatId,
          `Запустил ${queued.count} концепции для «${queued.leadTitle}». ${queued.estimatedCostUsd > 0
            ? `Оценка генерации: около $${queued.estimatedCostUsd.toFixed(3)}.`
            : 'Рисует Codex через Hermes — отдельной оплаты нет.'
        } Это не отправка клиенту: готовые картинки сначала придут сюда на проверку.`,
        );
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось запустить генерацию дизайна',
        );
      }
      return;
    }
    if (isOwnerDiscoveryCommand(text)) {
      try {
        const prepared = await this.agent.prepareDiscoveryOutbound(ownerId);
        if (prepared.complete) {
          await this.sendControlMessage(
            chatId,
            `По клиенту «${prepared.leadTitle}» ТЗ уже собрано на ${prepared.discoveryReadiness}%. Формирую документы; клиенту ничего не отправлено.`,
          );
        } else {
          await this.sendControlMessage(
            chatId,
            `Следующий вопрос для «${prepared.leadTitle}» · готовность ТЗ ${prepared.discoveryReadiness}% · канал: ${prepared.channel === 'telegram' ? 'Telegram' : 'FL.ru'}:\n\n${prepared.content}\n\nКлиенту ничего не отправлено. Если вопрос верный, напишите отдельным сообщением «отправь».`,
          );
        }
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось подготовить вопрос для ТЗ',
        );
      }
      return;
    }
    const sendApproval = parseOwnerSendApproval(text);
    if (sendApproval) {
      try {
        await this.agent.approveOwnerOutbound(ownerId, sendApproval.recipient);
        await this.sendControlMessage(
          chatId,
          'Ответ одобрен и поставлен на отправку. Когда канал вернёт результат, я сообщу сюда: отправлено, ошибка или статус неизвестен.',
        );
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось отправить ответ',
        );
      }
      return;
    }
    const outbound = parseOwnerOutboundRequest(text);
    if (outbound) {
      try {
        const prepared = await this.agent.prepareOwnerOutbound(
          ownerId,
          outbound.instructions,
          outbound.recipient,
        );
        if (outbound.sendNow) {
          await this.agent.approveOwnerOutbound(ownerId, outbound.recipient);
          await this.sendControlMessage(
            chatId,
            `Команда понята. Сообщение для «${prepared.leadTitle}» сформировано и поставлено на отправку через ${prepared.channel === 'telegram' ? 'Telegram' : 'FL.ru'}:\n\n${prepared.content}\n\nКогда канал вернёт результат, я отдельно сообщу: отправлено, ошибка или статус неизвестен.`,
          );
          return;
        }
        await this.sendControlMessage(
          chatId,
          `Черновик для «${prepared.leadTitle}» · канал: ${prepared.channel === 'telegram' ? 'Telegram' : 'FL.ru'}:\n\n${prepared.content}\n\nЕсли всё верно, напишите отдельным сообщением «отправь».`,
        );
      } catch (error) {
        await this.sendControlMessage(
          chatId,
          error instanceof Error ? error.message : 'Не удалось подготовить ответ',
        );
      }
      return;
    }
    if (looksLikeDeferredDeliveryCommand(text)) {
      await this.sendControlMessage(
        chatId,
        'Ничего не отправлено: вы привязали отправку к условию («если», «когда», «потом»). Напишите когда надо будет отправить — или сразу: «отправь Олегу сообщение …».',
      );
      return;
    }
    // Nothing matched a cheap pattern: let the model work out what the owner meant.
    await this.routeOwnerIntent(ownerId, chatId, text, null);
  }

  async notifyOwnerDraft(
    leadId: string,
    draftId: string,
    leadTitle: string,
    content: string,
  ) {
    if (telegramOnDemandOnly()) {
      return { sent: false, reason: 'on_demand_only' };
    }
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false };
    await this.db.query(
      `INSERT INTO owner_agent_sessions(
         owner_external_id,active_lead_id,pending_draft_id,updated_at
       ) VALUES($1,$2,$3,now())
       ON CONFLICT(owner_external_id) DO UPDATE SET
         active_lead_id=EXCLUDED.active_lead_id,
         pending_draft_id=EXCLUDED.pending_draft_id,updated_at=now()`,
      [String(owner.id), leadId, draftId],
    );
    await this.sendControlMessage(
      String(owner.id),
      `Нужен ваш ответ клиенту «${leadTitle}»:\n\n${content.slice(0, 3000)}\n\nЕсли всё верно, напишите отдельным сообщением «отправь». Если нужно изменить — напишите «подготовь ответ клиенту …».`,
    );
    return { sent: true };
  }

  async sendBusinessMessage(chatId: string, content: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    const connectionId = await this.settings.getSecret('telegram_business_connection_id');
    if (!token || !connectionId) throw new Error('Telegram Business не подключён');
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ business_connection_id: connectionId, chat_id: chatId, text: content }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new OutboundDeliveryUnknownError(
        'Telegram не подтвердил результат отправки; автоматический повтор запрещён',
        { cause: error },
      );
    }
    let body: { ok?: boolean; description?: string; result?: { message_id?: number } };
    try {
      body = await response.json() as typeof body;
    } catch (error) {
      if (response.ok) {
        throw new OutboundDeliveryUnknownError(
          'Telegram вернул неразбираемый успешный ответ; проверьте чат вручную',
          { cause: error },
        );
      }
      throw new Error(`Telegram HTTP ${response.status}`);
    }
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    return { externalId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  async sendBusinessMediaGroup(chatId: string, content: string, urls: string[]) {
    const token = await this.settings.getSecret('telegram_bot_token');
    const connectionId = await this.settings.getSecret('telegram_business_connection_id');
    if (!token || !connectionId) throw new Error('Telegram Business не подключён');
    const media = urls.slice(0, 10).map((url, index) => ({
      type: 'photo',
      media: url,
      ...(index === 0 ? { caption: content.slice(0, 1_000) } : {}),
    }));
    if (!media.length) throw new Error('Нет изображений для отправки');
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          business_connection_id: connectionId,
          chat_id: chatId,
          media,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new OutboundDeliveryUnknownError(
        'Telegram не подтвердил результат отправки изображений; автоматический повтор запрещён',
        { cause: error },
      );
    }
    let body: { ok?: boolean; description?: string; result?: Array<{ message_id?: number }> };
    try {
      body = await response.json() as typeof body;
    } catch (error) {
      if (response.ok) {
        throw new OutboundDeliveryUnknownError(
          'Telegram вернул неразбираемый успешный ответ для изображений; проверьте чат вручную',
          { cause: error },
        );
      }
      throw new Error(`Telegram HTTP ${response.status}`);
    }
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    return {
      externalId: body.result?.map((item) => item.message_id).filter(Boolean).join(',') || null,
    };
  }

  async notifyOwnerDesignReady(result: {
    ownerExternalId: string;
    leadTitle: string;
    content: string;
    previewUrls: string[];
    visualDirection?: string | null;
  }) {
    await this.sendControlMediaGroup(
      result.ownerExternalId,
      result.previewUrls,
      `Концепции для «${result.leadTitle}». ${String(result.visualDirection || '').slice(0, 700)}`,
    );
    await this.sendControlMessage(
      result.ownerExternalId,
      `Медиачерновик для «${result.leadTitle}» готов:\n\n${result.content}\n\nКлиенту ничего не отправлено. Чтобы отправить картинки и подпись, напишите отдельным сообщением «отправь».`,
    );
  }

  async notifyOwnerDesignFailure(ownerExternalId: string, leadTitle: string, error: string) {
    await this.sendControlMessage(
      ownerExternalId,
      `Не удалось подготовить дизайн для «${leadTitle}». Клиенту ничего не отправлено, автоповтор платной генерации отключён. Причина: ${error.slice(0, 700)}`,
    );
  }

  async notifyOwnerDeliveryResult(result: {
    status: 'sent' | 'failed' | 'send_unknown' | 'blocked';
    leadTitle: string;
    channel: string;
    error?: string | null;
  }) {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false, reason: 'owner_not_configured' };
    await this.sendControlMessage(String(owner.id), ownerDeliveryResultMessage(result));
    return { sent: true };
  }

  async notifyOwnerQualifiedLead(result: {
    leadId: string;
    title: string;
    score: number;
    price: number;
    days: number;
    fitReason?: string | null;
  }) {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false, reason: 'owner_not_configured' };
    const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const url = base ? `${base}/?lead=${encodeURIComponent(result.leadId)}` : null;
    await this.sendControlMessage(String(owner.id), qualifiedLeadTelegramMessage({ ...result, url }));
    return { sent: true };
  }

  async notifyOwnerFlMessage(result: {
    leadId: string;
    title: string;
    author?: string | null;
    content: string;
  }) {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false, reason: 'owner_not_configured' };
    const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const url = base ? `${base}/?lead=${encodeURIComponent(result.leadId)}` : null;
    await this.sendControlMessage(String(owner.id), flInboundTelegramMessage({ ...result, url }));
    return { sent: true };
  }

  async notifyOwnerSystem(message: string, relativeUrl = '/sales/') {
    const owner = await this.settings.getPublic<{ id?: number }>('telegram_owner');
    if (!owner?.id) return { sent: false, reason: 'owner_not_configured' };
    const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const url = base ? `${base}${relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`}` : null;
    await this.sendControlMessage(String(owner.id), `${message.slice(0, 3_500)}${url ? `\n\n${url}` : ''}`);
    return { sent: true };
  }

  private async sendControlMessage(chatId: string, text: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    if (!token) throw new Error('Telegram-бот не настроен');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4_000) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
  }

  private async sendControlMediaGroup(chatId: string, urls: string[], caption: string) {
    const token = await this.settings.getSecret('telegram_bot_token');
    if (!token) throw new Error('Telegram-бот не настроен');
    const media = urls.slice(0, 10).map((url, index) => ({
      type: 'photo',
      media: url,
      ...(index === 0 ? { caption: caption.slice(0, 1_000) } : {}),
    }));
    if (!media.length) throw new Error('Нет изображений для предпросмотра');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, media }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    if (!body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
  }

  private formatLeadMatches(rows: Array<Record<string, any>>) {
    if (!rows.length) return 'Активных клиентов пока нет.';
    return rows.slice(0, 12).map(
      (row, index) =>
        `${index + 1}. ${String(row.title || 'Без названия')} · ${String(row.pipeline_stage || 'new')}`,
    ).join('\n');
  }
}
