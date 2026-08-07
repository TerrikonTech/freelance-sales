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
    /(?:цен[аыуеой]|стоить|стоимост|бюджет|скидк|срок|дедлайн|договор|гарант|предоплат|постоплат|nda|доступ(?:ы|а|ов|ом|ами|ить)?|парол|токен|api[- ]?ключ)/iu,
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
  const text = String(value || '').normalize('NFKC');
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

export function ownerEscalationReply(reasons: ChatStopReason[], deadline: string): string {
  if (reasons.includes('ai_identity')) {
    return 'Мне помогает ИИ-инструмент готовить черновики и держать контекст, но решения по проекту и обязательствам принимаю я лично.';
  }
  if (reasons.includes('negative_tone')) {
    return `Понял, здесь мой ответ действительно не попал в вопрос. Перечитаю контекст лично и вернусь с ответом ${deadline}.`;
  }
  if (reasons.includes('human_requested')) {
    return `Да, подключусь лично. Перечитаю контекст и предложу следующий шаг ${deadline}.`;
  }
  if (reasons.includes('red_flag')) {
    return `Такой формат сначала проверю лично, чтобы не зафиксировать неверные условия. Вернусь с ответом ${deadline}.`;
  }
  if (reasons.includes('commitment')) {
    return `По деньгам, срокам и условиям решаю лично. Проверю объём и вернусь с конкретикой ${deadline}.`;
  }
  return `Хороший вопрос — сначала проверю детали лично, чтобы не ответить наугад. Вернусь с конкретикой ${deadline}.`;
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
  return issues;
}
