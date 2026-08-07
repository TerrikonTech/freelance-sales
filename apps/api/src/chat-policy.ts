export const CHAT_STAGES = [
  's1_first_reply',
  's2_discovery',
  's3_qualification',
  's4_value_frame',
  's5_channel_choice',
  's6_spec_confirmation',
  's7_commercial_owner',
  's8_handoff',
] as const;

export type ChatStage = (typeof CHAT_STAGES)[number];

export type ChatPolicyMessage = {
  direction?: string;
  content?: string;
  created_at?: string | Date;
};

export type ChatStopReason =
  | 'commitment'
  | 'human_requested'
  | 'negative_tone'
  | 'ai_identity'
  | 'red_flag'
  | 'low_confidence'
  | 'model_escalation';

export type ChatPolicySnapshot = {
  conversationStage: ChatStage;
  inboundBundle: string[];
  discoveryQuestionsUsed: number;
  discoveryQuestionsRemaining: number;
  stopReasons: ChatStopReason[];
  responseProfile: {
    channel: string;
    maxCharacters: number;
    maxQuestions: number;
    valueBeforeQuestion: true;
    flTone: string;
    telegramTone: string;
  };
};

const STOP_PATTERNS: Array<[ChatStopReason, RegExp]> = [
  [
    'commitment',
    /(?:цен[аыуеой]|стоить|стоимост|бюджет|скидк|срок|дедлайн|договор|гарант|предоплат|постоплат|nda|доступ(?:ы|а|ов|ом|ами|ить)?(?!\p{L})|парол|токен|api[- ]?ключ)/iu,
  ],
  [
    'human_requested',
    /(?:позовите|позови|подключите|подключи|дайте|дай|хочу)\s+(?:человека|владельца|руководителя|савелия)|(?:созвон|позвон|голосом|встреч)/iu,
  ],
  [
    'negative_tone',
    /(?:не\s+понимаете|не\s+поняли|что\s+за\s+(?:бред|ерунда)|это\s+(?:бред|ерунда)|разочарован|возмущ|претензи|жалоб|достал|бесит)/iu,
  ],
  [
    'ai_identity',
    /(?:вы|ты)\s+(?:бот|нейросет|ии|искусственн\p{L}*\s+интеллект)|со\s+мной\s+(?:бот|нейросет|ии)/iu,
  ],
  [
    'red_flag',
    /(?:бесплатн\p{L}*\s+(?:тестов|макет|прототип)|начните?\s+(?:сейчас|сразу).{0,40}(?:обсудим|оплат)|без\s+предоплат\p{L}*|полная\s+постоплата|оплат\p{L}*\s+(?:крипт|на\s+карту\s+треть))/iu,
  ],
];

export function countChatQuestions(value: unknown): number {
  return (String(value || '').match(/\?/gu) || []).length;
}

export function classifyChatStopReasons(value: unknown): ChatStopReason[] {
  const text = String(value || '').normalize('NFKC')
    .replace(/срок\s+хранени\p{L}*/giu, '')
    .replace(/цен[аыуеой]\s+вопроса/giu, '')
    .replace(/без\s+созвонов?(?:,?\s+только\s+текст(?:ом)?)?/giu, '');
  return STOP_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
}

export function chatStageFromPipeline(value: unknown): ChatStage {
  switch (String(value || '')) {
    case 'discovery': return 's2_discovery';
    case 'proposal': return 's4_value_frame';
    case 'telegram_handoff': return 's5_channel_choice';
    case 'contract': return 's7_commercial_owner';
    case 'build_ready':
    case 'won': return 's8_handoff';
    default: return 's1_first_reply';
  }
}

function lastInboundBundle(messages: ChatPolicyMessage[]): string[] {
  let lastOutbound = -1;
  messages.forEach((message, index) => {
    if (message.direction === 'outbound') lastOutbound = index;
  });
  const afterOutbound = messages
    .slice(lastOutbound + 1)
    .filter((message) => message.direction === 'inbound')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean);
  if (afterOutbound.length) return afterOutbound.slice(-6);
  const last = [...messages].reverse().find((message) => message.direction === 'inbound');
  return last?.content ? [String(last.content).trim()] : [];
}

export function buildChatPolicySnapshot(input: {
  channel: string;
  pipelineStage: string;
  messages: ChatPolicyMessage[];
  priorAgentReplies?: string[];
  previousConversationStage?: string | null;
}): ChatPolicySnapshot {
  const inboundBundle = lastInboundBundle(input.messages);
  const discoveryQuestionsUsed = (input.priorAgentReplies || [])
    .reduce((total, reply) => total + countChatQuestions(reply), 0);
  const previous = CHAT_STAGES.includes(input.previousConversationStage as ChatStage)
    ? input.previousConversationStage as ChatStage
    : chatStageFromPipeline(input.pipelineStage);
  return {
    conversationStage: previous,
    inboundBundle,
    discoveryQuestionsUsed,
    discoveryQuestionsRemaining: Math.max(0, 7 - discoveryQuestionsUsed),
    stopReasons: classifyChatStopReasons(inboundBundle.join('\n')),
    responseProfile: {
      channel: input.channel,
      maxCharacters: 500,
      maxQuestions: discoveryQuestionsUsed >= 7 ? 0 : 1,
      valueBeforeQuestion: true,
      flTone: 'деловито, коротко, без письма и самопрезентации',
      telegramTone: 'разговорно и по делу, но без фамильярности',
    },
  };
}

export function ownerReplyDeadline(now = new Date()): string {
  const moscowHour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    hour12: false,
  }).format(now));
  return moscowHour >= 8 && moscowHour < 17
    ? 'сегодня до 18:00 по Москве'
    : 'в следующий рабочий день до 11:00 по Москве';
}

export function ownerEscalationReply(
  reasons: ChatStopReason[],
  deadline: string,
  seed = '',
  recentReplies: string[] = [],
): string {
  const key = reasons.includes('ai_identity') ? 'ai_identity'
    : reasons.includes('negative_tone') ? 'negative_tone'
      : reasons.includes('human_requested') ? 'human_requested'
        : reasons.includes('red_flag') ? 'red_flag'
          : reasons.includes('commitment') ? 'commitment'
            : 'fallback';
  const variants: Record<string, string[]> = {
    ai_identity: [
      'Мне помогает ИИ-инструмент готовить черновики и держать контекст, но решения по проекту и обязательствам принимаю я лично.',
      'Да, для черновиков и памяти я использую ИИ. Все условия проекта проверяю и подтверждаю лично.',
      'ИИ помогает мне не терять детали переписки; цену, сроки и остальные решения всегда подтверждаю сам.',
    ],
    negative_tone: [
      `Понял, здесь мой ответ действительно не попал в вопрос. Перечитаю контекст лично и вернусь с ответом ${deadline}.`,
      `Согласен, сейчас ответ получился мимо сути. Сам пересмотрю переписку и дам точный ответ ${deadline}.`,
      `Вижу, что неправильно понял акцент. Подключусь лично и исправлю ответ ${deadline}.`,
    ],
    human_requested: [
      `Да, подключусь лично. Перечитаю контекст и предложу следующий шаг ${deadline}.`,
      `Хорошо, дальше отвечу сам. Сверю всю переписку и вернусь ${deadline}.`,
      `Принял — нужен мой личный ответ. Подготовлю его по полному контексту ${deadline}.`,
    ],
    red_flag: [
      `Такой формат сначала проверю лично, чтобы не зафиксировать неверные условия. Вернусь с ответом ${deadline}.`,
      `Здесь не хочу подтверждать условия без личной проверки. Разберу детали и отвечу ${deadline}.`,
      `Этот вариант требует отдельной проверки с моей стороны. Вернусь с решением ${deadline}.`,
    ],
    commitment: [
      `По деньгам, срокам и условиям решаю лично. Проверю объём и вернусь с конкретикой ${deadline}.`,
      `Чтобы не назвать случайные цифры, я сам сверю объём и условия. Дам конкретный ответ ${deadline}.`,
      `Цену и срок подтверждаю только после личной проверки контекста. Вернусь с расчётом ${deadline}.`,
      `Это вопрос обязательств, поэтому отвечу сам после сверки объёма — ${deadline}.`,
    ],
    fallback: [
      `Хороший вопрос — сначала проверю детали лично, чтобы не ответить наугад. Вернусь с конкретикой ${deadline}.`,
      `Здесь нужна моя проверка контекста. Дам предметный ответ ${deadline}.`,
      `Не хочу гадать по неполным данным — пересмотрю детали и отвечу ${deadline}.`,
    ],
  };
  const pool = variants[key];
  const offset = seed
    ? Number.parseInt(createHash('sha256').update(`${seed}:${key}`).digest('hex').slice(0, 8), 16) % pool.length
    : 0;
  for (let index = 0; index < pool.length; index += 1) {
    const candidate = pool[(offset + index) % pool.length];
    if (!recentReplies.includes(candidate)) return candidate;
  }
  return pool[offset];
}

export function reviewChatReply(input: {
  reply: string;
  conversationStage: ChatStage;
  valueBeforeQuestion: boolean;
  discoveryQuestionsRemaining: number;
  requiresOwner: boolean;
  inboundBundle?: string[];
}): string[] {
  const issues: string[] = [];
  const reply = String(input.reply || '').trim();
  const questions = countChatQuestions(reply);
  if (!reply) issues.push('Пустой ответ.');
  if (input.conversationStage !== 's6_spec_confirmation' && reply.length > 500) {
    issues.push('Обычная реплика длиннее 500 знаков.');
  }
  if (questions > 1) issues.push('В реплике больше одного вопроса.');
  if (questions > 0 && !input.valueBeforeQuestion) {
    issues.push('Вопрос задан без ценности перед ним.');
  }
  if (questions > 0 && input.valueBeforeQuestion) {
    const beforeQuestion = reply.split('?', 1)[0];
    const startsAsReceipt = /^(?:понял|поняла|зафиксировал|итого|верно понял)\s*[:,—-]/iu.test(beforeQuestion);
    const addsUsefulMove = /(?:значит|поэтому|тогда|важн|узк\p{L}*\s+мест|риск|можно|лучше|достаточ|не\s+нужно|без\s+дополнитель|это\s+(?:позвол|снима|означа))/iu.test(beforeQuestion);
    if (startsAsReceipt && !addsUsefulMove && (input.inboundBundle || []).length > 0) {
      issues.push('Перед вопросом только пересказ входящих фактов, а не новая ценность.');
    }
  }
  if (questions > 0 && input.discoveryQuestionsRemaining <= 0) {
    issues.push('Исчерпан бюджет из 7 discovery-вопросов.');
  }
  if (!input.requiresOwner && classifyChatStopReasons(reply).includes('ai_identity')) {
    issues.push('Ответ о природе ИИ должен пройти через владельца.');
  }
  if (!input.requiresOwner) issues.push(...outboundCommitmentIssues(reply));
  return issues;
}
import { createHash } from 'node:crypto';
import { outboundCommitmentIssues } from './research-controls';
