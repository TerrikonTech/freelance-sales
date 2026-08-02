import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';

export type AutonomyDecision = 'auto_send' | 'ask_owner' | 'skip';
export type AutonomyPolicyMode = 'manual' | 'smart';

export type AutonomyPolicyConfig = {
  mode: AutonomyPolicyMode;
  globalPaused: boolean;
  minAutoConfidence: number;
};

export type AutonomyEvaluation = {
  decision: AutonomyDecision;
  confidence: number;
  reason: string;
  signals: string[];
};

export type AutonomyEvaluationInput = {
  inbound: string;
  outbound: string;
  mode: 'response' | 'chat';
  duplicate?: boolean;
  leadConfidence?: number | null;
  runtimeSignals?: string[];
};

const DEFAULT_POLICY: AutonomyPolicyConfig = {
  mode: 'manual',
  globalPaused: false,
  minAutoConfidence: 0.92,
};

export function strictApprovalEnabled(value = process.env.STRICT_APPROVAL): boolean {
  return !/^(?:0|false|off|no)$/i.test(String(value || 'true').trim());
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

const matches = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

const ACK_PATTERNS = [
  /^(?:ок(?:ей)?|хорошо|понял[аи]?|принято|спасибо|благодарю|ясно|договорились|жду|👍|👌|🙏|ok|thanks?|got it)[.!…\s]*$/iu,
];

const SPAM_PATTERNS = [
  /(?:казино|ставк[аи]|крипт[оа]\s*сигнал|быстрый заработок|накрут(?:ка|ить)|adult|viagra)/iu,
  /(?:https?:\/\/\S+\s*){3,}/iu,
  /(.)\1{12,}/u,
];

const RISK_RULES: Array<{ signal: string; patterns: RegExp[] }> = [
  {
    signal: 'price_or_discount',
    patterns: [
      /(?:цен[ауы]|стоимост|бюджет|руб(?:\.|лей)?|₽|доллар|евро|оплат|предоплат|скидк|дешевле|дорого|торг|смет[аы]|price|cost|budget|payment|discount)/iu,
      /\d[\d\s]{2,}\s*(?:₽|руб|р\.|usd|eur|\$|€)/iu,
    ],
  },
  {
    signal: 'deadline_or_schedule',
    patterns: [
      /(?:срок|дедлайн|когда\s+(?:сдела|готов|начн)|к\s+какому\s+числу|час(?:а|ов)?|дн(?:я|ей)|недел|месяц|deadline|eta|delivery date|how long)/iu,
    ],
  },
  {
    signal: 'scope_or_commitment',
    patterns: [
      /(?:объ[её]м|scope|тз|техническ(?:ое|ого)\s+задани|входит\s+ли|добав(?:ить|ьте)|передела|доработ|гарантир|гаранти|обязательств|точно\s+сможете|бер[её]те\s+в\s+работу)/iu,
    ],
  },
  {
    signal: 'contract_or_legal',
    patterns: [
      /(?:договор|акт|сч[её]т|оферт|ндс|ип(?:\s|$)|ооо(?:\s|$)|самозанят|юридическ|реквизит|nda|ндашк|contract|invoice|legal)/iu,
    ],
  },
  {
    signal: 'contact_or_channel_move',
    patterns: [
      /(?:telegram|телеграм|телег[ау]|tg(?:\s|$)|whatsapp|ватсап|номер\s+телефон|созвон|позвон|контакт|почт[ауы]|email|e-mail|перейд[её]м|напишите\s+мне\s+в)/iu,
    ],
  },
  {
    signal: 'files_or_attachments',
    patterns: [
      /(?:файл|вложени|архив|документ|таблиц|макет|исходник|доступ\s+к|ссылк[ау]\s+на\s+(?:диск|файл)|attachment|upload|download)/iu,
    ],
  },
  {
    signal: 'credentials_or_secrets',
    patterns: [
      /(?:парол|логин|токен|api[\s_-]*key|секрет|credential|доступ\s+в\s+(?:админ|аккаунт)|ssh|приватн(?:ый|ого)\s+ключ)/iu,
    ],
  },
  {
    signal: 'negative_or_conflict',
    patterns: [
      /(?:недовол|претензи|жалоб|возврат|обман|мошенн|плохо|не\s+работает|сломал|штраф|суд|отказ|не\s+устраивает|ужас|negative|refund|complaint)/iu,
    ],
  },
];

const SAFE_CHAT_PATTERNS: Array<{ signal: string; patterns: RegExp[] }> = [
  {
    signal: 'safe_experience_faq',
    patterns: [
      /(?:есть\s+ли\s+у\s+вас\s+опыт|какой\s+у\s+вас\s+опыт|покажите\s+портфолио|есть\s+примеры|какие\s+проекты\s+делали)/iu,
    ],
  },
  {
    signal: 'safe_process_faq',
    patterns: [
      /(?:как\s+вы(?:\s+обычно)?\s+работаете|как\s+обычно\s+проходит\s+работа|какой\s+у\s+вас\s+процесс|как\s+будем\s+работать)/iu,
    ],
  },
  {
    signal: 'safe_technical_faq',
    patterns: [
      /(?:какой\s+стек|с\s+чем\s+работаете|какие\s+технологии|на\s+ч[её]м\s+пишете)/iu,
    ],
  },
  {
    signal: 'safe_status',
    patterns: [
      /(?:как\s+продвигается|какой\s+статус|есть\s+новости|получили\s+сообщение|вы\s+на\s+связи)/iu,
    ],
  },
  {
    signal: 'safe_clarification',
    patterns: [
      /(?:что\s+именно\s+нужно\s+уточнить|какой\s+информации\s+не\s+хватает|есть\s+ли\s+вопросы)/iu,
    ],
  },
];

export function evaluateAutonomy(input: AutonomyEvaluationInput, policy: AutonomyPolicyConfig): AutonomyEvaluation {
  if (policy.mode !== 'smart') {
    return { decision: 'ask_owner', confidence: 1, reason: 'Ручное одобрение включено', signals: ['manual_mode'] };
  }

  const inbound = normalize(input.inbound);
  const outbound = normalize(input.outbound);
  const combined = `${inbound}\n${outbound}`;
  const runtimeSignals = (input.runtimeSignals || []).map(normalize).filter(Boolean);

  if (input.duplicate) {
    return { decision: 'skip', confidence: 1, reason: 'Это входящее сообщение уже обработано', signals: ['duplicate'] };
  }
  if (matches(inbound, SPAM_PATTERNS)) {
    return { decision: 'skip', confidence: 0.99, reason: 'Сообщение похоже на спам', signals: ['spam'] };
  }

  if (runtimeSignals.length) {
    return {
      decision: 'ask_owner',
      confidence: 1,
      reason: 'Коннектор недоступен или требует проверки владельца',
      signals: ['connector_risk', ...runtimeSignals],
    };
  }

  const riskSignals = RISK_RULES
    .filter((rule) => matches(combined, rule.patterns))
    .map((rule) => rule.signal);
  if (input.mode === 'response') riskSignals.unshift('initial_response');
  if (riskSignals.length) {
    return {
      decision: 'ask_owner',
      confidence: 0.99,
      reason: 'Ответ затрагивает обязательства или чувствительные данные',
      signals: [...new Set(riskSignals)],
    };
  }

  if (matches(inbound, ACK_PATTERNS) && !/[?？]/u.test(inbound)) {
    return { decision: 'skip', confidence: 0.98, reason: 'Простое подтверждение не требует ответа', signals: ['ack_without_question'] };
  }

  const leadConfidence = input.leadConfidence;
  if (typeof leadConfidence === 'number' && Number.isFinite(leadConfidence) && leadConfidence < 70) {
    return { decision: 'ask_owner', confidence: 0.96, reason: 'Низкая уверенность в контексте лида', signals: ['low_lead_confidence'] };
  }

  const safeSignals = SAFE_CHAT_PATTERNS
    .filter((rule) => matches(inbound, rule.patterns))
    .map((rule) => rule.signal);
  const confidence = safeSignals.length ? 0.95 : 0.55;
  if (safeSignals.length && confidence >= policy.minAutoConfidence) {
    return {
      decision: 'auto_send',
      confidence,
      reason: 'Безопасный информационный ответ без новых обязательств',
      signals: safeSignals,
    };
  }

  return {
    decision: 'ask_owner',
    confidence,
    reason: 'Недостаточно уверенности для автоматической отправки',
    signals: ['low_classification_confidence'],
  };
}

@Injectable()
export class AutonomyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
  ) {}

  async getPolicy(): Promise<AutonomyPolicyConfig> {
    const stored = await this.settings.getPublic<Partial<AutonomyPolicyConfig>>('autonomy_policy');
    const policy = this.normalizePolicy(stored);
    return strictApprovalEnabled() ? { ...policy, mode: 'manual' } : policy;
  }

  async setPolicy(input: Partial<AutonomyPolicyConfig>): Promise<AutonomyPolicyConfig> {
    const current = await this.getPolicy();
    const policy = this.normalizePolicy({ ...current, ...input });
    if (strictApprovalEnabled()) policy.mode = 'manual';
    await this.settings.setPublic('autonomy_policy', policy);
    return policy;
  }

  async evaluate(input: AutonomyEvaluationInput): Promise<AutonomyEvaluation & { policyMode: AutonomyPolicyMode }> {
    const policy = await this.getPolicy();
    return { ...evaluateAutonomy(input, policy), policyMode: policy.mode };
  }

  async runtimeSignals(channel: string): Promise<string[]> {
    const result = await this.db.query<{ healthy: boolean; status_text: string | null }>(
      'SELECT healthy,status_text FROM connector_state WHERE connector=$1',
      [channel],
    );
    const state = result.rows[0];
    if (!state) return [`${channel}: connector missing`];
    if (state.healthy) return [];
    return [String(state.status_text || `${channel}: connector unhealthy`)];
  }

  async wasSourceMessageDecided(sourceMessageId: string | null | undefined): Promise<boolean> {
    if (!sourceMessageId) return false;
    const result = await this.db.query(
      'SELECT 1 FROM autonomy_decisions WHERE source_message_id=$1 LIMIT 1',
      [sourceMessageId],
    );
    return Boolean(result.rows[0]);
  }

  async recordDecision(input: {
    leadId: string;
    draftId: string;
    sourceMessageId?: string | null;
    policyMode: AutonomyPolicyMode;
    evaluation: AutonomyEvaluation;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO autonomy_decisions(
         lead_id,draft_id,source_message_id,policy_mode,decision,confidence,reason,signals
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [
        input.leadId,
        input.draftId,
        input.sourceMessageId || null,
        input.policyMode,
        input.evaluation.decision,
        input.evaluation.confidence,
        input.evaluation.reason,
        JSON.stringify(input.evaluation.signals),
      ],
    );
  }

  async pauseClient(leadId: string, paused: boolean, reason = ''): Promise<void> {
    await this.db.query(
      `INSERT INTO autonomy_client_state(lead_id,paused,reason,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(lead_id) DO UPDATE SET paused=EXCLUDED.paused,reason=EXCLUDED.reason,updated_at=now()`,
      [leadId, paused, reason.slice(0, 500) || null],
    );
  }

  async outboundPause(leadId: string): Promise<{ paused: boolean; reason: string | null; scope: 'global' | 'client' | null }> {
    const [policy, client] = await Promise.all([
      this.getPolicy(),
      this.db.query<{ paused: boolean; reason: string | null }>(
        'SELECT paused,reason FROM autonomy_client_state WHERE lead_id=$1',
        [leadId],
      ),
    ]);
    if (policy.globalPaused) return { paused: true, reason: 'Глобальная пауза отправки', scope: 'global' };
    if (client.rows[0]?.paused) return { paused: true, reason: client.rows[0].reason || 'Клиент на паузе', scope: 'client' };
    return { paused: false, reason: null, scope: null };
  }

  private normalizePolicy(value: Partial<AutonomyPolicyConfig> | null | undefined): AutonomyPolicyConfig {
    const min = Number(value?.minAutoConfidence);
    return {
      mode: value?.mode === 'smart' ? 'smart' : 'manual',
      globalPaused: value?.globalPaused === true,
      minAutoConfidence: Number.isFinite(min) ? Math.min(0.99, Math.max(0.8, min)) : DEFAULT_POLICY.minAutoConfidence,
    };
  }
}
