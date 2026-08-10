import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';
import {
  calculateCatalogPrice,
  DEFAULT_PRICING_POLICY,
  PricingCategory,
  PricingLevel,
  PricingModifier,
} from './pricing-policy';

export type BuyerIntent = 'ready' | 'exploratory' | 'contradictory' | 'unrealistic' | 'irrelevant';
export type ExistingSystem = 'yes' | 'no' | 'unknown';
export type ProjectKind = 'new_build' | 'integration' | 'revision' | 'audit' | 'support' | 'non_development';

export interface LeadUnderstanding {
  summary: string;
  project_kind: ProjectKind;
  buyer_intent: BuyerIntent;
  existing_system: ExistingSystem;
  confirmed_scope: string[];
  wishlist_or_future_scope: string[];
  separate_costs: string[];
  critical_unknowns: string[];
  assumption_for_quote: string;
  pricing_category_hint: PricingCategory;
  pricing_level_hint: PricingLevel;
  relevance_signals: string[];
  mismatch_signals: string[];
  confidence: number;
}

export interface LeadAnalysis {
  score: number;
  confidence: number;
  technical_fit: number;
  commercial_fit: number;
  brief_quality: number;
  delivery_risk: number;
  recommended_price: number;
  recommended_days: number;
  fit_reason: string;
  client_value: string;
  risks: string[];
  questions: string[];
  should_respond: boolean;
  pricing_category: PricingCategory;
  pricing_level: PricingLevel;
  pricing_modifiers: PricingModifier[];
  understanding: LeadUnderstanding;
}

type ModelLeadAnalysis = Omit<LeadAnalysis, 'understanding'>;
type ModelCombinedLeadAnalysis = ModelLeadAnalysis & { understanding: LeadUnderstanding };

type DraftCandidate = { content: string; angle: string };

type DraftStrategy = {
  buyer_goal: string;
  buyer_risk: string;
  unique_signals: string[];
  micro_plan: string[];
  done_criterion: string;
  message_type: string;
  proof: string;
  conversation_goal: string;
  dialogue_question: string;
  psychology_angles: string[];
  mention_price_in_body: boolean;
  hook_pattern: ProposalHookPattern;
  acceptance_label: ProposalAcceptanceLabel;
  avoid_phrases: string[];
};

type DraftReview = {
  content: string;
  selected_index: number;
  human_score: number;
  sales_score: number;
  specificity_score: number;
  factual_score: number;
  issues: string[];
};

const DEFAULT_STYLE_PROFILE = {
  response_greeting: 'Короткое обращение по имени, если имя подтверждено; иначе сразу содержательный хук без приветствия-филлера',
  response_structure: 'Обычно 2–5 асимметричных абзацев: вариативный хук; микро-план и измеримый критерий приёмки; один кейс; цена, срок, подтверждённый старт и один лёгкий вопрос',
  response_length: 'FL.ru: обычно 100–200 слов; компактная точечная задача 60–120; дорогой сложный проект 170–260, жёсткий потолок 300 слов',
  punctuation: 'Естественная русская пунктуация. Короткий список из 2–3 шагов допустим, если он делает план сканируемым',
  tone: 'Спокойное личное сообщение сильного разработчика. Зеркалировать терминологию и регистр заказчика, не давить и не изображать рекламный текст',
  rules: [
    'Первая содержательная фраза — о задаче или риске заказчика, а не об исполнителе. В ней должна быть уникальная деталь этого брифа.',
    'Писать как конкретному человеку: естественно использовать «у вас», «вам» или «ваш» минимум дважды, но не повторять бриф.',
    'Чередовать короткие, средние и длинные предложения. Нужен один смысловой акцент на 2–5 слов; телеграфные заглушки вроде «Всё прозрачно», «Границу закрепим» и «Откат предусмотрю» запрещены.',
    'Абзацы должны следовать за мыслью и отличаться по длине. Не упаковывать хук, план и кейс в три одинаковых симметричных блока.',
    'Говорить глаголами и от первого лица. Не начинать фразы с «важно», «нужно», «следует», «необходимо» и не прятать действие в канцелярские существительные.',
    'Использовать 1–3 естественные разговорные связки по смыслу: «по деньгам», «на практике», «скажу честно». Не рассыпать их для вида.',
    'Использовать минимум две конкретные детали заказа, но не пересказывать список функций.',
    'Дать микро-план из 2–3 шагов. Показать приёмку как сцену с живым человеком: ваш сотрудник сам добавляет товар, менеджер получает уведомление или пользователь проходит сценарий.',
    'Использовать ровно одно самое релевантное доказательство. Если назван кейс, сразу дать точную ссылку.',
    'В каждом отклике естественно назвать цену, срок и подтверждённое условие старта, даже если цифры также попадут в отдельные поля FL.ru. Если доступность не настроена, не выдумывать её.',
    'Закончить одним простым вопросом или бинарным выбором, на который легко ответить.',
    'Из психологии использовать только честные приёмы: зеркалирование, конкретное социальное доказательство, снижение риска, взаимность через полезное наблюдение. Никакой искусственной срочности.',
  ],
};

export type ProposalProfile = 'compact' | 'standard' | 'premium';
export type ProposalHookPattern = 'observation_detail' | 'result_first' | 'proof_first' | 'direct_commitment' | 'first_step';
export type ProposalAcceptanceLabel = 'ready_equals' | 'acceptance' | 'stage_closed' | 'result_accepted' | 'result_check';

export type ProposalCommercialContext = {
  price?: number;
  days?: number;
  availability?: string;
  availabilityConfigured?: boolean;
  clientName?: string;
  hookPattern?: ProposalHookPattern;
  acceptanceLabel?: ProposalAcceptanceLabel;
  technologyFit?: ProposalTechnologyFit;
};

export type ProposalHumanityMetrics = {
  wordCount: number;
  sentenceLengths: number[];
  averageSentenceWords: number;
  burstiness: number;
  burstinessTargetMet: boolean;
  burstinessHardFail: boolean;
  paragraphWordCounts: number[];
  paragraphBurstiness: number;
  clientAddressCount: number;
  shortSentenceCount: number;
  longSentenceFollowupMissCount: number;
  emptyAccentCount: number;
  impersonalStartCount: number;
  nominalizationCount: number;
  inlineNumberedPlan: boolean;
  negativeParallelismCount: number;
  repeatedSentenceStartCount: number;
  parallelismPairCount: number;
  symmetricParagraphPairCount: number;
  ruleOfThreeCount: number;
  capitalizedColonListCount: number;
  conclusionPhraseCount: number;
  bureaucraticPhraseCount: number;
  protocolHonestyCount: number;
  tablePricingCount: number;
  firstPersonActionCount: number;
  conversationalConnectorCount: number;
  questionCount: number;
};

export type ProposalTechnologyFit = {
  required: string[];
  verifiedEvidence: Array<{
    technology: string;
    source: 'seller_profile' | 'portfolio';
    detail: string;
    url?: string;
  }>;
  unverified: string[];
  risk: 'none' | 'elevated';
};

const PROPOSAL_TECHNOLOGIES: Array<{ label: string; pattern: RegExp }> = [
  { label: '1С-Битрикс', pattern: /(?:1[сc]\s*[-–—]?\s*)?битрикс(?!\s*24)|bitrix(?!\s*24)/iu },
  { label: 'Bitrix24', pattern: /битрикс\s*24|bitrix\s*24/iu },
  { label: 'WordPress', pattern: /wordpress|вордпресс/iu },
  { label: 'WooCommerce', pattern: /woocommerce|в[уо]коммерс/iu },
  { label: 'Tilda', pattern: /(?:^|[^\p{L}])tilda(?:[^\p{L}]|$)|тильд[аеуы]?/iu },
  { label: 'OpenCart', pattern: /opencart|опенкарт/iu },
  { label: 'MODX', pattern: /(?:^|[^\p{L}])modx(?:[^\p{L}]|$)/iu },
  { label: 'Shopify', pattern: /shopify|шопифай/iu },
  { label: 'Webflow', pattern: /webflow|вебфлоу/iu },
  { label: 'Flutter', pattern: /flutter|флаттер/iu },
  { label: 'React Native', pattern: /react\s*native|реакт\s*нейтив/iu },
];

function technologyDefinition(label: string) {
  return PROPOSAL_TECHNOLOGIES.find((item) => item.label === label);
}

export function proposalTechnologyFitContext(
  lead: Record<string, unknown>,
  seller: Record<string, unknown>,
  portfolioValue: unknown,
): ProposalTechnologyFit {
  const leadText = `${lead.title || ''}\n${lead.description || ''}`;
  const required = PROPOSAL_TECHNOLOGIES
    .filter((technology) => technology.pattern.test(leadText))
    .map((technology) => technology.label);
  const sellerText = JSON.stringify(seller || {});
  const portfolio = Array.isArray(portfolioValue) ? portfolioValue : [];
  const verifiedEvidence: ProposalTechnologyFit['verifiedEvidence'] = [];

  for (const label of required) {
    const definition = technologyDefinition(label)!;
    const matchedCase = portfolio.find((item) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return definition.pattern.test(`${row.title || ''}\n${row.description || ''}\n${row.stack || ''}`);
    });
    if (matchedCase && typeof matchedCase === 'object') {
      const row = matchedCase as Record<string, unknown>;
      verifiedEvidence.push({
        technology: label,
        source: 'portfolio',
        detail: String(row.title || label).slice(0, 180),
        ...(String(row.url || '').trim() ? { url: String(row.url).trim().slice(0, 500) } : {}),
      });
      continue;
    }
    if (definition.pattern.test(sellerText)) {
      verifiedEvidence.push({
        technology: label,
        source: 'seller_profile',
        detail: `Подтверждено профилем продавца: ${label}`,
      });
    }
  }

  const verified = new Set(verifiedEvidence.map((item) => item.technology));
  const unverified = required.filter((label) => !verified.has(label));
  return {
    required,
    verifiedEvidence,
    unverified,
    risk: unverified.length ? 'elevated' : 'none',
  };
}

export function proposalTechnologyIssues(content: string, fit?: ProposalTechnologyFit): string[] {
  if (!fit?.required.length) return [];
  const issues: string[] = [];
  const sentences = content.split(/(?<=[.!?])\s+|\n+/u).map((item) => item.trim()).filter(Boolean);
  const proofClaim = /(?:работал[аи]?|работаю|делал[аи]?|реализовал[аи]?|разрабатывал[аи]?|есть\s+опыт|владею|знаю)/iu;
  const negativeProof = /(?:нет|не\s+заявляю|не\s+буду\s+выдумывать|без).{0,80}(?:опыт|кейс|проект|подтвержден)/iu;

  for (const label of fit.unverified) {
    const definition = technologyDefinition(label);
    const unsupported = definition && sentences.some((sentence) => (
      definition.pattern.test(sentence) && proofClaim.test(sentence) && !negativeProof.test(sentence)
    ));
    if (unsupported) {
      issues.push(`Нельзя заявлять опыт с ${label}: в профиле и портфолио нет подтверждающего факта.`);
    }
    const linkedCase = /https?:\/\/[^\s)]+/iu.test(content);
    const mismatchDisclosed = sentences.some((sentence) => (
      Boolean(definition?.pattern.test(sentence))
        && /(?:не\s+на|нет\s+подтвержд[её]нного|опыт\s+не\s+подтвержд[её]н)/iu.test(sentence)
    )) || sentences.some((sentence) => /стек(?:\s+у\s+него|\s+там|\s+проекта)?\s+(?:был\s+)?друг/iu.test(sentence));
    if (linkedCase && !mismatchDisclosed) {
      issues.push(
        `Связанный кейс не подтверждает ${label}: скажи это прямо человеческими словами, например «Скажу честно: тот проект был не на ${label}, стек другой».`,
      );
    }
  }

  for (const evidence of fit.verifiedEvidence) {
    const definition = technologyDefinition(evidence.technology);
    const exactCaseUsed = Boolean(evidence.url && content.includes(evidence.url));
    const verifiedClaimUsed = Boolean(definition && sentences.some((sentence) => (
      definition.pattern.test(sentence) && proofClaim.test(sentence)
    )));
    if (!exactCaseUsed && !verifiedClaimUsed) {
      issues.push(`Заказ явно требует ${evidence.technology}: добавь одно подтверждённое доказательство из technology_fit.`);
    }
  }
  return issues;
}

const PROPOSAL_LIMITS: Record<ProposalProfile, { minWords: number; maxWords: number; minChars: number; maxChars: number }> = {
  compact: { minWords: 60, maxWords: 120, minChars: 350, maxChars: 850 },
  standard: { minWords: 100, maxWords: 200, minChars: 600, maxChars: 1_400 },
  premium: { minWords: 170, maxWords: 260, minChars: 950, maxChars: 1_900 },
};

const PROPOSAL_HOOK_PATTERNS: ProposalHookPattern[] = [
  'observation_detail', 'result_first', 'proof_first', 'direct_commitment', 'first_step',
];

const PROPOSAL_ACCEPTANCE_LABELS: ProposalAcceptanceLabel[] = [
  'ready_equals', 'acceptance', 'stage_closed', 'result_accepted', 'result_check',
];

const ACCEPTANCE_LABEL_TEXT: Record<ProposalAcceptanceLabel, string> = {
  ready_equals: 'Работа готова, когда',
  acceptance: 'Проверим просто:',
  stage_closed: 'Этап закрываем, когда',
  result_accepted: 'На приёмке ваш сотрудник',
  result_check: 'Финальная проверка простая:',
};

export function proposalVariationPlan(recentDrafts: string[], seed: string) {
  const joined = recentDrafts.join('\n').toLowerCase();
  const acceptanceCounts: Record<ProposalAcceptanceLabel, number> = {
    ready_equals: (joined.match(/(?:готово\s*=|работа\s+готова,?\s+когда)/gu) || []).length,
    acceptance: (joined.match(/(?:при[ёе]мка\s*:|проверим\s+просто\s*:)/gu) || []).length,
    stage_closed: (joined.match(/(?:этап\s+считается\s+закрыт|этап\s+закрываем,?\s+когда)/gu) || []).length,
    result_accepted: (joined.match(/(?:результат\s+можно\s+принимать|на\s+при[ёе]мке\s+ваш\s+сотрудник)/gu) || []).length,
    result_check: (joined.match(/(?:проверка\s+результата\s*:|финальная\s+проверка\s+простая\s*:)/gu) || []).length,
  };
  const seedNumber = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const acceptanceLabel = [...PROPOSAL_ACCEPTANCE_LABELS]
    .sort((left, right) => acceptanceCounts[left] - acceptanceCounts[right]
      || ((PROPOSAL_ACCEPTANCE_LABELS.indexOf(left) - seedNumber) % PROPOSAL_ACCEPTANCE_LABELS.length)
      - ((PROPOSAL_ACCEPTANCE_LABELS.indexOf(right) - seedNumber) % PROPOSAL_ACCEPTANCE_LABELS.length))[0];
  const hookPattern = PROPOSAL_HOOK_PATTERNS[seedNumber % PROPOSAL_HOOK_PATTERNS.length];
  return {
    hookPattern,
    acceptanceLabel,
    acceptanceText: ACCEPTANCE_LABEL_TEXT[acceptanceLabel],
  };
}

export function proposalOpeningSeed(seed: string, clientName = ''): string {
  const name = clientName.trim().split(/\s+/u)[0];
  const openings = [
    'У вас в задаче',
    'Сразу зацепила деталь:',
    'По вашему описанию видно:',
    'Здесь я бы первым делом разобрался с',
    'У вас хороший ориентир —',
  ];
  const seedNumber = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const substantive = openings[seedNumber % openings.length];
  return name ? `Здравствуйте, ${name}!\n\n${substantive}` : substantive;
}

export function proposalProfileForLead(lead: Record<string, unknown>): ProposalProfile {
  const description = String(lead.description || '').trim();
  const price = Number(lead.recommended_price) || 0;
  if (description.length <= 220 || (price > 0 && price <= 40_000)) return 'compact';
  if (price >= 500_000) return 'premium';
  return 'standard';
}

const HUMANITY_WORD_PATTERN = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu;

function proposalSentences(content: string): Array<{ text: string; words: string[] }> {
  const withoutUrls = content.replace(/https?:\/\/[^\s)]+/giu, ' ссылка ');
  return withoutUrls
    .split(/(?<=[.!?])(?:\s+|$)|\n+/u)
    .map((text) => text.replace(/^\s*(?:[-•]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean)
    .map((text) => ({ text, words: text.match(HUMANITY_WORD_PATTERN) || [] }))
    .filter((sentence) => sentence.words.length > 0);
}

function sentenceStructure(text: string): string {
  const normalized = text.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
  if (/^я(?:\s|$)/u.test(normalized)) return 'first_person';
  if (/^(?:у\s+вас|вам|ваш[а-яё]*)(?:\s|$)/u.test(normalized)) return 'client';
  if (/^(?:сначала|затем|потом|дальше|в\s+конце|наконец)(?:\s|$)/u.test(normalized)) return 'sequence';
  if (/^(?:если|когда|после|перед|пока)(?:\s|$)/u.test(normalized)) return 'condition';
  return (normalized.match(HUMANITY_WORD_PATTERN) || []).slice(0, 1).join(' ');
}

function priceWithSpaces(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Safe deterministic cleanup for formatting that should not consume an AI retry. */
export function normalizeProposalFormatting(
  content: string,
  commercial: ProposalCommercialContext = {},
): string {
  const price = Math.round(Number(commercial.price) || 0);
  if (price < 10_000) return content.trim();
  const raw = String(price);
  const grouped = priceWithSpaces(price);
  return content.trim().replace(
    new RegExp(`(^|[^\\d])${raw}(?=\\s*(?:₽|руб(?:\\.|лей|ля)?))`, 'gimu'),
    (_match, prefix: string) => `${prefix}${grouped}`,
  );
}

/** Deterministic style diagnostics: editorial signals, not an AI-detector verdict. */
export function proposalHumanityMetrics(content: string): ProposalHumanityMetrics {
  const sentences = proposalSentences(content);
  const allWords = content.match(HUMANITY_WORD_PATTERN) || [];
  const sentenceLengths = sentences.map((sentence) => sentence.words.length);
  const average = sentenceLengths.length
    ? sentenceLengths.reduce((sum, value) => sum + value, 0) / sentenceLengths.length
    : 0;
  const variance = sentenceLengths.length
    ? sentenceLengths.reduce((sum, value) => sum + ((value - average) ** 2), 0) / sentenceLengths.length
    : 0;
  const burstiness = average > 0 ? Math.sqrt(variance) / average : 0;
  const paragraphWordCounts = content.trim().split(/\n\s*\n/u)
    .map((paragraph) => (paragraph.match(HUMANITY_WORD_PATTERN) || []).length)
    .filter((length) => length > 0);
  const paragraphAverage = paragraphWordCounts.length
    ? paragraphWordCounts.reduce((sum, value) => sum + value, 0) / paragraphWordCounts.length
    : 0;
  const paragraphVariance = paragraphWordCounts.length
    ? paragraphWordCounts.reduce((sum, value) => sum + ((value - paragraphAverage) ** 2), 0) / paragraphWordCounts.length
    : 0;
  const paragraphBurstiness = paragraphAverage > 0 ? Math.sqrt(paragraphVariance) / paragraphAverage : 0;
  const paragraphSentenceCounts = content.trim().split(/\n\s*\n/u)
    .map((paragraph) => proposalSentences(paragraph).length)
    .filter((length) => length > 0);
  const paragraphStructures = content.trim().split(/\n\s*\n/u)
    .map((paragraph) => sentenceStructure(proposalSentences(paragraph)[0]?.text || ''))
    .filter(Boolean);
  const addressMatches = content.match(
    /(?:^|[^\p{L}])(?:у\s+вас|вы|вам|вас|вами|ваш[а-яё]*)(?=$|[^\p{L}])/gimu,
  ) || [];
  const shortSentenceCount = sentences.filter((sentence) => (
    sentence.words.length >= 2
    && sentence.words.length <= 5
    && !/^(?:добрый\s+день|здравствуйте|привет)[!,.]?$/iu.test(sentence.text)
  )).length;
  const emptyAccentCount = sentences.filter((sentence) => (
    sentence.words.length <= 5
    && /^(?:вс[её]\s+(?:понятно|прозрачно|просто|готово)|границы\s*(?:[—-]\s*сразу|закрепим)|откат\s+предусмотрю|риски?\s+(?:понятны|видны)|это\s+(?:главное|важно)|вот\s+и\s+вс[её])[.!]?$/iu.test(sentence.text.trim())
  )).length;
  const impersonalStartCount = sentences.filter((sentence) => (
    /^(?:важно|нужно|следует|необходимо|требуется|стоит|можно)(?:\s|[,:—-]|$)/iu.test(sentence.text)
  )).length;
  const allowedTerms = /^(?:организац|регистрац|авторизац|стоимост|безопасност|доступност|производительност|возможност)/iu;
  const nominalizationSuffix = /(?:ение|ения|ению|ением|ении|ание|ания|анию|анием|ании|ация|ации|ацию|ацией|ость|ости|остью)$/iu;
  const nominalizationLead = /^(?:для|после|перед|через|при|с|по|пут[её]м|провести|проведу|проводить|выполнить|осуществить|обеспечить)$/iu;
  const nominalizationCount = sentences.reduce((count, sentence) => {
    const words = sentence.words.map((word) => word.toLowerCase());
    return count + words.reduce((sentenceCount, word, index) => {
      if (!nominalizationSuffix.test(word) || allowedTerms.test(word) || /ностью$/iu.test(word)) return sentenceCount;
      const lead = words.slice(Math.max(0, index - 2), index);
      return sentenceCount + (index === 0 || lead.some((item) => nominalizationLead.test(item)) ? 1 : 0);
    }, 0);
  }, 0);
  const inlineNumberedPlan = content.split('\n').some((line) => (
    /(?:^|\s)1[.)]\s+.+(?:^|\s)2[.)]\s+/u.test(line)
  ));
  const negativeParallelismCount = (
    content.match(/(?:^|[^\p{L}])не\s+(?:(?:просто|только)(?:\s|[,:—-])[^.!?]{0,120}(?:а|но)|[^.!?]{1,80},\s*а)(?=$|[^\p{L}])/gimu) || []
  ).length;
  const sentenceStarts = sentences.map((sentence) => sentence.words.slice(0, 2).join(' ').toLowerCase());
  const repeatedSentenceStartCount = sentenceStarts.reduce((count, start, index) => (
    index > 0 && start.length > 0 && start === sentenceStarts[index - 1] ? count + 1 : count
  ), 0);
  const structures = sentences.map((sentence) => sentenceStructure(sentence.text));
  const parallelismPairCount = structures.reduce((count, structure, index) => {
    if (index === 0 || !structure || structure !== structures[index - 1]) return count;
    const left = sentenceLengths[index - 1];
    const right = sentenceLengths[index];
    return count + (Math.abs(left - right) / Math.max(left, right) <= 0.3 ? 1 : 0);
  }, 0);
  const longSentenceFollowupMissCount = sentenceLengths.reduce((count, length, index) => (
    length >= 25 && index < sentenceLengths.length - 1 && sentenceLengths[index + 1] > 8
      ? count + 1
      : count
  ), 0);
  const symmetricParagraphPairCount = paragraphWordCounts.reduce((count, words, index) => {
    if (index === 0
      || paragraphSentenceCounts[index] !== paragraphSentenceCounts[index - 1]
      || paragraphStructures[index] !== paragraphStructures[index - 1]) return count;
    const previous = paragraphWordCounts[index - 1];
    return count + (Math.abs(previous - words) / Math.max(previous, words) <= 0.2 ? 1 : 0);
  }, 0);
  const ruleOfThreeCount = sentences.filter((sentence) => (
    (sentence.text.match(/(?:^|[,;])\s*(?:я\s+)?[\p{L}-]+(?:ю|у|аю|яю|ем|им|ить|ать|ять)(?=\s|[,;]|$)/gimu) || []).length >= 3
  )).length;
  const capitalizedColonListCount = sentences.filter((sentence) => (
    /:\s*[А-ЯЁ][^.!?;]{1,80}[;,]\s*[А-ЯЁ]/u.test(sentence.text)
  )).length;
  const conclusionPhraseCount = (content.match(
    /(?:^|[^\p{L}])(?:таким\s+образом|подводя\s+итог)(?=$|[^\p{L}])/gimu,
  ) || []).length;
  const bureaucraticPhraseCount = (content.match(
    /(?:^|[^\p{L}])(?:важно\s+отметить|ключевой\s+момент|это\s+особенно\s+важно|в\s+современных\s+реалиях|является|осуществляет)(?=$|[^\p{L}])/gimu,
  ) || []).length;
  const protocolHonestyCount = (content.match(
    /(?:не\s+служит\s+подтверждением|не\s+является\s+гарантией)/gimu,
  ) || []).length;
  const tablePricingCount = (content.match(
    /(?:стоимость|цена)\s*[—-]\s*\d[^.!?]{0,80}срок\s*[—-]/gimu,
  ) || []).length;
  const firstPersonActionCount = (content.match(
    /(?:^|[^\p{L}])я\s+(?:делал|сделал|собрал|соберу|разработал|реализовал|спроектировал|настроил|подключил|внедрил|создал|проверю|покажу|сверю|опишу|зафиксирую|предусмотрю|продумаю|проведу|разведу|договорюсь)(?=$|[^\p{L}])/gimu,
  ) || []).length;
  const conversationalConnectorCount = (content.match(
    /(?:^|[^\p{L}])(?:кстати|скажу\s+честно|по\s+деньгам|на\s+практике|проще\s+говоря|сразу\s+скажу|если\s+коротко|самое\s+хитрое\s+было)(?=$|[^\p{L}])/gimu,
  ) || []).length;
  return {
    wordCount: allWords.length,
    sentenceLengths,
    averageSentenceWords: Number(average.toFixed(2)),
    burstiness: Number(burstiness.toFixed(2)),
    burstinessTargetMet: burstiness >= 0.6,
    burstinessHardFail: sentences.length >= 5 && burstiness < 0.55,
    paragraphWordCounts,
    paragraphBurstiness: Number(paragraphBurstiness.toFixed(2)),
    clientAddressCount: addressMatches.length,
    shortSentenceCount,
    longSentenceFollowupMissCount,
    emptyAccentCount,
    impersonalStartCount,
    nominalizationCount,
    inlineNumberedPlan,
    negativeParallelismCount,
    repeatedSentenceStartCount,
    parallelismPairCount,
    symmetricParagraphPairCount,
    ruleOfThreeCount,
    capitalizedColonListCount,
    conclusionPhraseCount,
    bureaucraticPhraseCount,
    protocolHonestyCount,
    tablePricingCount,
    firstPersonActionCount,
    conversationalConnectorCount,
    questionCount: (content.match(/\?/g) || []).length,
  };
}

function caseTokenStems(value: string): Set<string> {
  const generic = new Set([
    'проект', 'разработка', 'реализовать', 'сделал', 'делал', 'собрал', 'настроил', 'создал',
    'спроектировал', 'система', 'платформа', 'сервис', 'кабинет', 'пользователь', 'клиент', 'задача',
    'работа', 'логика', 'механика', 'интерфейс', 'frontend', 'backend', 'nextjs', 'nestjs', 'данные', 'сайт', 'приложение',
  ].map((word) => word.slice(0, 6)));
  return new Set((value.toLowerCase().match(/[а-яёa-z0-9]{5,}/gu) || [])
    .map((word) => word.slice(0, 6))
    .filter((stem) => !generic.has(stem)));
}

/** A linked case must contain one verifiable, non-generic detail from its stored card. */
export function portfolioHumanityIssues(content: string, portfolio: Record<string, unknown>[]): string[] {
  if (!content || !Array.isArray(portfolio) || !portfolio.length) return [];
  const selected = portfolio.find((item) => {
    const url = String(item.url || '').trim();
    return url && content.includes(url);
  });
  if (!selected) return [];
  const url = String(selected.url || '').trim();
  const paragraph = content.split(/\n\s*\n/u).find((item) => item.includes(url)) || content;
  const issues: string[] = [];
  if (!/(?:^|[^\p{L}])я\s+(?:делал|сделал|собрал|разработал|реализовал|спроектировал|настроил|подключил|внедрил|создал|отвечал|проектировал)(?=$|[^\p{L}])/iu.test(paragraph)) {
    issues.push('Опиши кейс от первого лица: «я делал/собрал/разработал», а не безличной справкой.');
  }
  const caseCard = selected.case_card && typeof selected.case_card === 'object'
    ? selected.case_card as Record<string, unknown>
    : selected;
  const descriptionStems = caseTokenStems([
    selected.description,
    caseCard.client_context,
    caseCard.task,
    caseCard.solution_details,
    caseCard.challenge,
    caseCard.result,
    caseCard.stack,
  ].filter(Boolean).join(' '));
  const paragraphStems = caseTokenStems(paragraph.replace(url, ''));
  let overlap = 0;
  for (const stem of descriptionStems) if (paragraphStems.has(stem)) overlap += 1;
  if (descriptionStems.size > 0 && overlap < 2) {
    issues.push('В кейсе нет живой проверяемой детали из его карточки: возьми 1–2 факта из portfolio.description и ничего не придумывай.');
  }
  return issues;
}

export function proposalHumanityWarnings(metrics: ProposalHumanityMetrics): string[] {
  const warnings: string[] = [];
  if (metrics.burstinessHardFail) {
    warnings.push(`Бёрстинесс ${metrics.burstiness}: ниже жёсткого порога 0,55; нужна синтаксическая ревизия.`);
  } else if (!metrics.burstinessTargetMet) {
    warnings.push(`Бёрстинесс ${metrics.burstiness}: ниже цели 0,60, но выше жёсткого порога 0,55.`);
  }
  return warnings;
}

export function proposalHumanRulePass(metrics: ProposalHumanityMetrics): boolean {
  const rhythmPass = !metrics.burstinessHardFail
    // The supplied handwritten reference has sentence burstiness 0.49 despite
    // claiming 0.77. Strong paragraph asymmetry plus real short beats is the
    // calibrated escape hatch; the raw metric is still logged and revised.
    || (metrics.paragraphBurstiness >= 0.5 && metrics.shortSentenceCount >= 2);
  return rhythmPass
    && metrics.clientAddressCount >= 2
    && metrics.nominalizationCount <= 3
    && metrics.impersonalStartCount === 0
    && metrics.parallelismPairCount === 0
    && metrics.negativeParallelismCount === 0
    && metrics.ruleOfThreeCount === 0
    && metrics.firstPersonActionCount >= 1
    && metrics.conversationalConnectorCount >= 1
    && metrics.conversationalConnectorCount <= 3;
}

export function proposalFinalBlockingIssues(content: string, issues: string[]): string[] {
  if (!proposalHumanRulePass(proposalHumanityMetrics(content))) return issues;
  return issues.filter((issue) => !/^Ритм провален/iu.test(issue));
}

function proposalRevisionGuidance(
  content: string,
  issues: string[],
  portfolio: Record<string, unknown>[],
) {
  const consequenceFor = (issue: string) => {
    if (/бёрстин|ритм|фраз|абзац|параллел|канцеляр|филлер/iu.test(issue)) {
      return 'Текст звучит собранным по шаблону и выдаёт AI-происхождение.';
    }
    if (/кейс|ссылк|факт|опыт|технолог|стек/iu.test(issue)) {
      return 'Заказчик не сможет проверить доказательство или увидит неподтверждённое обещание.';
    }
    if (/при[ёе]мк|план|вопрос|цен|срок|старт/iu.test(issue)) {
      return 'Заказчику непонятен следующий шаг или коммерческая граница.';
    }
    return 'Отклик теряет конкретность и доверие.';
  };
  const preserve: string[] = [];
  const first = proposalSentences(content)[0]?.text || '';
  if (first && (first.match(HUMANITY_WORD_PATTERN) || []).length <= 24
    && !/^(?:я|мы|внимательно|готов|задача\s+понятна)/iu.test(first)) {
    preserve.push(first);
  }
  const caseParagraph = content.split(/\n\s*\n/u).find((paragraph) => /https?:\/\//iu.test(paragraph));
  if (caseParagraph && portfolioHumanityIssues(content, portfolio).length === 0) {
    preserve.push(caseParagraph.trim());
  }
  const commercialSentence = proposalSentences(content).find((sentence) => (
    /(?:по\s+деньгам|стоимост|цена)[^.!?]*\d/iu.test(sentence.text)
  ));
  if (commercialSentence) preserve.push(commercialSentence.text);
  if ((content.match(/\?/g) || []).length === 1) {
    const question = content.split(/(?<=[?])\s+/u).find((part) => part.includes('?'));
    if (question) preserve.push(question.trim());
  }
  return {
    previous_content: content,
    issues,
    issue_plan: issues.map((error) => ({
      error,
      consequence: consequenceFor(error),
      fix: error,
    })),
    preserve: [...new Set(preserve)].slice(0, 4),
    instruction: 'Исправь только перечисленные причины. Фрагменты preserve оставь дословно, если они не противоречат issue_plan.',
  };
}

export function proposalResearchIssues(
  content: string,
  profile: ProposalProfile,
  commercial: ProposalCommercialContext = {},
): string[] {
  const issues: string[] = [];
  const limits = PROPOSAL_LIMITS[profile];
  const words = content.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
  if (words.length < limits.minWords || words.length > limits.maxWords) {
    issues.push(`Длина для режима ${profile}: нужно ${limits.minWords}–${limits.maxWords} слов, сейчас ${words.length}.`);
  }
  if (content.length < limits.minChars || content.length > limits.maxChars) {
    issues.push(`Объём для режима ${profile}: нужно ${limits.minChars}–${limits.maxChars} знаков, сейчас ${content.length}.`);
  }
  const paragraphs = content.trim().split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const substantiveParagraphs = paragraphs.filter((paragraph) => (
    !/^(?:добрый\s+день|здравствуйте|привет)(?:,?\s+[\p{L} -]{2,40})?[!.]?$/iu.test(paragraph)
  ));
  if (substantiveParagraphs.length > 5) issues.push('Оставь не более пяти содержательных абзацев.');
  if (substantiveParagraphs.length === 1 && content.length > 650) issues.push('Разбей стену текста на 2–3 сканируемых абзаца.');

  const humanity = proposalHumanityMetrics(content);
  // 0.60 is the editorial target. Only <0.55 is a hard generation failure;
  // 0.55–0.59 stays visible in metadata for calibration instead of blocking work.
  if (humanity.burstinessHardFail) {
    const targetSentences = profile === 'premium' ? '12–16' : profile === 'standard' ? '9–14' : '7–10';
    issues.push(
      `Ритм провален (бёрстинесс ${humanity.burstiness}, жёсткий порог 0,55; длины: ${humanity.sentenceLengths.join('/')}). `
      + `Сделай ${targetSentences} предложений: разбей две самые длинные фразы и добавь ещё один короткий смысловой акцент на 2–5 слов. Факты не меняй.`,
    );
  }
  if (humanity.clientAddressCount < 2) {
    issues.push(`Текст написан «в воздух»: естественно обратись к заказчику через «у вас», «вам» или «ваш» минимум дважды (сейчас ${humanity.clientAddressCount}).`);
  }
  if (humanity.sentenceLengths.length >= 5 && humanity.shortSentenceCount === 0) {
    issues.push('Нет короткого смыслового акцента на 2–5 слов: текст звучит одинаково плотным.');
  }
  if (humanity.emptyAccentCount > 0) {
    issues.push('Короткий акцент получился пустым филлером («Всё прозрачно»/«Это главное»): короткая фраза должна добавлять конкретный смысл.');
  }
  if (humanity.repeatedSentenceStartCount > 0) {
    issues.push('Соседние предложения начинаются одинаково: разрушь синтаксический параллелизм, не меняя факты.');
  }
  if (humanity.parallelismPairCount > 0) {
    issues.push(`Найдено ${humanity.parallelismPairCount} пар соседних фраз с одинаковой конструкцией и длиной: одну объедини, разбей или переставь.`);
  }
  if (humanity.longSentenceFollowupMissCount > 0) {
    issues.push(`После ${humanity.longSentenceFollowupMissCount} длинных фраз нет короткого продолжения до 8 слов: разбей ритм смысловым ударом.`);
  }
  if (humanity.paragraphWordCounts.length >= 3
    && humanity.paragraphWordCounts.reduce((sum, value) => sum + value, 0) >= 80
    && humanity.paragraphBurstiness < 0.18) {
    issues.push(`Абзацы слишком симметричны (${humanity.paragraphWordCounts.join('/')} слов): сделай их разной длины и подчинёнными ходу мысли.`);
  }
  if (humanity.symmetricParagraphPairCount > 0) {
    issues.push('Соседние абзацы получились симметричными по длине и числу предложений: измени подачу одного из них.');
  }
  if (humanity.impersonalStartCount > 0) {
    issues.push('Не начинай фразы безлично с «важно/нужно/следует/необходимо/можно»: назови, кто и что делает.');
  }
  const requiredFirstPersonActions = 1;
  if (humanity.firstPersonActionCount < requiredFirstPersonActions) {
    issues.push(`Назови свои действия от первого лица живыми глаголами минимум ${requiredFirstPersonActions} раза: «я соберу/покажу/проверю» (сейчас ${humanity.firstPersonActionCount}).`);
  }
  if (humanity.conversationalConnectorCount < 1) {
    issues.push('Добавь одну уместную разговорную связку вроде «по деньгам», «на практике» или «скажу честно» — только ту, которая звучит естественно в этом месте.');
  }
  if (humanity.conversationalConnectorCount > 3) {
    issues.push('Разговорных связок слишком много: оставь 1–3, иначе голос выглядит сыгранным.');
  }
  const nominalizationLimit = 3;
  if (humanity.nominalizationCount > nominalizationLimit) {
    issues.push(`Слишком много отглагольных существительных (${humanity.nominalizationCount}): замени канцелярские обороты прямыми глаголами.`);
  }
  if (humanity.inlineNumberedPlan) {
    issues.push('Не пиши «1) 2) 3)» внутри одного предложения: изложи план прозой или отдельными строками.');
  }
  if (humanity.negativeParallelismCount > 0) {
    issues.push('Убери машинную контрастивную конструкцию «не X, а Y» / «не просто» / «не только» и скажи мысль прямо.');
  }
  if (humanity.ruleOfThreeCount > 0) {
    issues.push('Убери «правило трёх»: три одинаково построенных действия подряд звучат как рекламный шаблон.');
  }
  if (humanity.capitalizedColonListCount > 0) {
    issues.push('После двоеточия получился формальный список с заглавных букв: скажи это нормальной фразой или одним коротким списком.');
  }
  if (humanity.conclusionPhraseCount > 0) {
    issues.push('Удали выводную формулу «таким образом/подводя итог»: закончи предметным вопросом.');
  }
  if (humanity.bureaucraticPhraseCount > 0) {
    issues.push('Убери канцелярские маркеры «важно отметить/ключевой момент/является/осуществляет» и назови действие прямо.');
  }
  if (humanity.protocolHonestyCount > 0) {
    issues.push('Замени протокольную честность «не служит подтверждением/не является гарантией» на разговорное «скажу честно».');
  }

  const withoutGreeting = content.trim().replace(/^(?:(?:[\p{L} -]{2,40},\s*)?(?:добрый день|здравствуйте|привет)[.!]?\s*)/iu, '');
  const firstSentence = withoutGreeting.split(/[.!?\n]/, 1)[0].trim().toLowerCase();
  const firstSentenceWords = firstSentence.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
  if (firstSentenceWords.length > 24) {
    issues.push(`Первая фраза перегружена: разбей её на две короткие, не более 24 слов в первой.`);
  }
  if (/^(?:я|мы|мне|мой|моя|мои|наш|наша)(?:\s|[,:—-]|$)/u.test(firstSentence)) {
    issues.push('Первая содержательная фраза должна быть о задаче или риске заказчика, а не об исполнителе.');
  }
  if (/^(?:внимательно (?:прочитал|изучил)|готов (?:выполнить|приступить)|задача понятна)/iu.test(firstSentence)) {
    issues.push('Первый экран занят шаблонным филлером: начни с конкретной детали этого заказа.');
  }
  // variation_plan suggests wording to avoid repetition; it is not a reason to
  // reject an otherwise natural acceptance scene with a different phrase.
  const acceptancePattern = /(?:при[ёе]мк|работа\s+готова|проверим\s+просто|этап\s+(?:закрываем|принят|считается)|финальная\s+проверка|если\s+(?:сможет|проходит|получится))/iu;
  if (!acceptancePattern.test(content)) {
    issues.push('Добавь измеримый критерий приёмки как живую проверку результата.');
  }
  const acceptanceScene = /(?:ваш[а-яё]*\s+(?:сотрудник|менеджер|администратор)|администратор|менеджер|пользователь|партн[её]р)[^.!?]{0,140}(?:добав|созда|редакт|проход|регистр|вход|откры|получ|провер|меня|оформ)/iu.test(content);
  if (!acceptanceScene) {
    issues.push('Покажи приёмку как сцену: ваш сотрудник, менеджер или пользователь сам выполняет проверяемое действие.');
  }
  if (/(?:…|\.{3})/u.test(content)) {
    issues.push('В готовом отклике осталось многоточие-заглушка: замени его конкретным текстом.');
  }
  const numberedPlan = /(?:^|\s)1[.)]\s+[\s\S]{0,700}(?:^|\s)2[.)]\s+/mu.test(content);
  const bulletSteps = (content.match(/(?:^|\n)\s*[-•]\s+/gmu) || []).length;
  const proseStepMarkers = content.match(
    /(?:^|[^\p{L}])(?:сначала|первым\s+шагом|затем|потом|после\s+этого|дальше|в\s+конце|наконец|после\s+показа)(?=$|[^\p{L}])/gimu,
  ) || [];
  const hasPlan = numberedPlan
    || bulletSteps >= 2
    || proseStepMarkers.length >= 2;
  if (!hasPlan) issues.push('Добавь микро-план из 2–3 последовательных шагов.');
  const questions = (content.match(/\?/g) || []).length;
  if (questions !== 1) issues.push(`В финале нужен ровно один лёгкий вопрос, сейчас вопросов: ${questions}.`);
  const urls = content.match(/https?:\/\/[^\s)]+/giu) || [];
  if (urls.length > 1) issues.push('Оставь ровно одно самое релевантное доказательство, без россыпи ссылок.');

  const exactNumberPattern = (value: number) => new RegExp(
    String(Math.round(value)).split('').join('[\\s\\u00a0\\u202f]*'),
    'u',
  );
  if (Number(commercial.price) > 0 && !exactNumberPattern(Number(commercial.price)).test(content)) {
    issues.push(`Назови в тексте цену ${Math.round(Number(commercial.price)).toLocaleString('ru-RU')} ₽.`);
  }
  if (humanity.tablePricingCount > 0) {
    issues.push('Цена и срок звучат как строка таблицы. Скажи их фразой: «По деньгам: 250 000 ₽ и 45 дней».');
  }
  if (Number(commercial.price) >= 10_000) {
    const rawPrice = String(Math.round(Number(commercial.price)));
    const ungroupedPrice = new RegExp(`(^|\\D)${rawPrice}(?=\\D|$)`, 'u');
    if (ungroupedPrice.test(content)) {
      issues.push(`Раздели разряды в сумме: ${Math.round(Number(commercial.price)).toLocaleString('ru-RU')} ₽, а не ${rawPrice} ₽.`);
    }
  }
  if (Number(commercial.days) > 0) {
    const daysPattern = new RegExp(`${Math.round(Number(commercial.days))}\\s*(?:рабоч(?:их|ие)?\\s*)?д(?:ень|ня|ней|\\.)`, 'iu');
    if (!daysPattern.test(content)) issues.push(`Назови в тексте срок ${Math.round(Number(commercial.days))} дней.`);
  }
  if (commercial.availability) {
    const availability = commercial.availability.replace(/^\s*старт\s*[:—-]?\s*/iu, '').trim().toLowerCase();
    if (availability && !content.toLowerCase().includes(availability)) {
      issues.push(`Укажи подтверждённую дату или условие старта дословно: «${commercial.availability}».`);
    }
  }
  if (commercial.availabilityConfigured === false
    && /старт\s*[—:-]\s*после\s+согласования\s+объ[её]ма.{0,100}(?:материал|доступ)/iu.test(content)) {
    issues.push('Удали системную заглушку старта: дата не настроена, выдумывать доступность нельзя.');
  }
  const clientName = String(commercial.clientName || '').trim().split(/\s+/)[0];
  if (clientName) {
    const escapedName = clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!(new RegExp(`^(?:(?:добрый\\s+день|здравствуйте|привет)[,!]?\\s+)?${escapedName}[,!]`, 'iu')).test(content.trim())) {
      issues.push(`Имя заказчика подтверждено: начни с короткого обращения «${clientName},».`);
    }
  }
  issues.push(...proposalTechnologyIssues(content, commercial.technologyFit));
  return issues;
}

const GENERIC_CASE_TITLES = new Set([
  'сайт', 'лендинг', 'магазин', 'приложение', 'дизайн', 'бот', 'сервис',
  'платформа', 'портал', 'система', 'каталог', 'маркетплейс', 'дашборд',
]);

/** Naming a case and then not linking it is the single most common miss in real drafts. */
export function portfolioLinkIssues(content: string, portfolio: Record<string, unknown>[]): string[] {
  if (!content || !Array.isArray(portfolio) || !portfolio.length) return [];
  if (/fl\.ru\/user[^\s]*\/portfolio\//i.test(content)) return [];
  const lower = content.toLowerCase();
  for (const item of portfolio) {
    const title = String((item || {}).title || '').trim();
    const url = String((item || {}).url || '').trim();
    if (!title || !url) continue;
    const name = title.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3).slice(0, 2).join(' ');
    // A generic word like "Сайт" would match almost any draft and drag in a wrong link.
    if (name.length < 6 || GENERIC_CASE_TITLES.has(name.toLowerCase())) continue;
    if (lower.includes(name.toLowerCase())) {
      return [`Назван кейс «${title}», но без ссылки. Приложи его адрес дословно: ${url}`];
    }
  }
  return [];
}

export function portfolioEvidenceIssues(content: string, portfolio: Record<string, unknown>[]): string[] {
  const relevant = portfolio.filter((item) => Number(item.relevance_score) > 0 && String(item.url || '').trim());
  if (!relevant.length) return [];
  const exactUrls = relevant.map((item) => String(item.url).trim());
  const used = exactUrls.filter((url) => content.includes(url));
  if (used.length === 0) {
    return ['Для заказа найден релевантный подтверждённый кейс: выбери один, объясни сходство и приложи его точную ссылку.'];
  }
  if (used.length > 1) return ['Оставь один самый релевантный кейс и одну ссылку, без портфолио-дампа.'];
  return [];
}

const RESPONSE_PRINCIPLES = [
  'Цель первого отклика — получить осмысленный ответ и снизить тревогу заказчика, а не пересказать бриф или показать весь стек.',
  'Первые 150–200 символов должны содержать конкретную проблему, наблюдение, результат или близкое доказательство именно по этому заказу. Не начинать с «я», стажа или приветствия-филлера.',
  'Пиши конкретному человеку, а не в пустоту: минимум два естественных обращения «у вас/вам/ваш». Это не повод пересказывать заказ фразой «вам нужно».',
  'Ритм должен быть неровным по смыслу: целевой бёрстинесс не ниже 0,60, жёсткий провал ниже 0,55. После фразы от 25 слов ставь короткую до 8 слов. Нужен один содержательный удар на 2–5 слов; соседние предложения одинаковой длины и конструкции запрещены.',
  'Действия называй глаголами и от первого лица: «я соберу», «покажу», «проверю». Безличные старты и канцелярские цепочки из слов на «-ение/-ация/-ость» переписывай.',
  'Добавь 1–3 разговорные связки только там, где они естественны: «по деньгам», «на практике», «скажу честно». Искусственная разговорность не нужна.',
  'Использовать минимум две уникальные детали задания и лексику клиента, но не перечислять уже написанные функции для вида.',
  'Структура: один из пяти вариативных хуков → понимание цели → микро-план 2–3 шага → приёмка как живая сцена с сотрудником или пользователем → один кейс → цена, срок и подтверждённый старт при его наличии → один простой вопрос.',
  'Техническая мысль допустима только когда объясняет пользу, риск, деньги или скорость. На дорогом проекте показать управляемость: этапность, QA, прозрачность или обратимость.',
  'Доверие строить одним сильным уместным сигналом: близкий реальный кейс с прямой ссылкой, подтверждённый опыт или конкретный способ снять главный риск. 6 лет и Яндекс не вставлять как заполнитель.',
  'Если называешь кейс из portfolio — сразу давай его ссылку из portfolio[].url. Не писать «могу показать» без ссылки: заказчик должен мочь открыть работу в один клик.',
  'Кейс упоминай по схеме «я делал → одна проверяемая деталь из portfolio.description → чем она совпадает с задачей клиента → точная ссылка». Нельзя дополнять карточку правдоподобными числами, ролями или результатами, которых в ней нет.',
  'У case_card есть поля client_context, task, solution_details, challenge, result, stack и stack_mismatch_note. Используй только заполненные факты; пустое поле не разрешает домысливать деталь.',
  'Ссылку брать только из portfolio[].url дословно. Никогда не выдумывать адрес и не ссылаться на кейс, которого нет в portfolio.',
  'Если заказ явно требует CMS или технологию, используй только доказательство из technology_fit. Словарь инфоблоков, компонентов и редакций не доказывает опыт сам по себе. При risk=elevated не заявляй, что работал с технологией: соседний кейс доказывает только механику проекта, а не стек.',
  'Завершать ровно одним лёгким вопросом или бинарным выбором, который двигает разговор на один шаг. Не превращать отклик в анкету.',
  'Не ругать постановку задачи, бюджет, конкурентов или выбранную технологию в первом сообщении.',
  'Не писать по обязательной формуле: структура и длина должны следовать брифу и выбранному углу.',
  'Цена и срок обязательны в самом тексте. Старт обязателен только когда подтверждён профилем продавца; при пустой настройке его нельзя выдумывать.',
  'Цену и срок писать живой фразой вроде «По деньгам: 250 000 ₽ и 45 дней», а не таблицей «Стоимость — …, срок — …». Суммы писать с разрядами.',
  'Запрещены «важно отметить», «ключевой момент», «в современных реалиях», «является», «осуществляет», выводы «таким образом/подводя итог», правило трёх и формальная честность «не служит подтверждением».',
  'Старт называть только когда он подтверждён профилем продавца; при пустой настройке не выдумывать дату и не вставлять системную заглушку.',
  'Если подтверждёно имя из FL-профиля или чата, обратиться по имени. Не угадывать имя по логину.',
  'Не использовать манипуляции, искусственную срочность и давление. Рабочая психология отклика — персонализация, конкретное доказательство, снижение риска и простой следующий шаг.',
];

export function selectVoiceprintExamples(examples: string[], leadText: string, limit = 3): string[] {
  const leadStems = caseTokenStems(leadText);
  return examples
    .map((content, index) => {
      const exampleStems = caseTokenStems(content);
      let overlap = 0;
      for (const stem of leadStems) if (exampleStems.has(stem)) overlap += 1;
      return { content, overlap, index };
    })
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((item) => item.content);
}

const PORTFOLIO_CONCEPTS: Array<{ lead: RegExp; item: RegExp }> = [
  { lead: /(?:telegram|телеграм|max|макс|мессендж|бот)/iu, item: /(?:telegram|телеграм|max|макс|мессендж|бот|чат)/iu },
  { lead: /(?:партн[её]р|реферал|дилер|агентск)/iu, item: /(?:партн[её]р|реферал|дилер|франшиз|нетворкинг|участник)/iu },
  { lead: /(?:регистрац|анкет|фио|телефон|профил)/iu, item: /(?:регистрац|анкет|онбординг|профил|участник|личн.{0,8}кабинет)/iu },
  { lead: /(?:документ|файл|скриншот|свидетельств)/iu, item: /(?:документ|файл|фото|скриншот|ocr|акт|сч[её]т)/iu },
  { lead: /(?:qr|qr-код|ссылк|partner_id)/iu, item: /(?:qr|qr-код|ссылк|код|билет|идентификатор)/iu },
  { lead: /(?:уведомлен|менеджер|crm|амо|битрикс)/iu, item: /(?:уведомлен|менеджер|crm|амо|битрикс|диспетчер|оператор)/iu },
];

/** Cheap semantic-ish portfolio routing used only after the owner asks for a draft. */
export function selectRelevantPortfolio(value: unknown, leadText: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const stopWords = new Set([
    'который', 'нужно', 'сайт', 'сайта', 'сайте', 'разработка', 'сделать', 'работа',
    'проект', 'через', 'будет', 'можно', 'также', 'данные', 'система', 'должен',
  ]);
  const tokens = (text: string) => new Set(
    text.toLowerCase().match(/[а-яёa-z0-9]{4,}/g)?.filter((word) => !stopWords.has(word)) || [],
  );
  const leadTokens = tokens(leadText);
  return value
    .map((item, index) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const itemText = `${row.title || ''} ${row.description || ''}`;
      const caseTokens = tokens(itemText);
      let score = 0;
      for (const word of leadTokens) if (caseTokens.has(word)) score += 1;
      for (const concept of PORTFOLIO_CONCEPTS) {
        if (concept.lead.test(leadText) && concept.item.test(itemText)) score += 3;
      }
      return { index, score, row };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter(({ score }) => score > 0)
    .slice(0, 6)
    .map(({ row, score }) => ({
      title: String(row.title || '').slice(0, 180),
      description: String(row.description || '').slice(0, 900),
      url: String(row.url || '').slice(0, 500),
      case_card: {
        client_context: String(row.client_context || row.title || '').slice(0, 500),
        task: String(row.task || row.description || '').slice(0, 900),
        solution_details: String(row.solution_details || '').slice(0, 900),
        challenge: String(row.challenge || '').slice(0, 700),
        result: String(row.result || '').slice(0, 500),
        stack: String(row.stack || '').slice(0, 300),
        stack_mismatch_note: String(row.stack_mismatch_note || '').slice(0, 300),
      },
      relevance_score: score,
    }));
}

const RESPONSE_CALIBRATION = [
  {
    kind: 'Сайт-витрина и будущий магазин',
    example: 'Здравствуйте!\n\nУ вас в задаче смешаны сайт-витрина клиники и будущий магазин с оплатой. Я бы развёл их по этапам. Витрину соберу сейчас, а под магазин заложу структуру каталога. Иначе смета расползётся ещё до старта.\n\nДизайн у вас готов — это сильно упрощает работу. Сначала я сверю редакцию CMS и границы кабинета. Потом соберу каталог на тестовом домене. В конце ваш сотрудник сам добавит товар и новость. Если сможет — этап принят.\n\nПохожую механику я делал для медицинской платформы: в кабинете были три роли, и самое хитрое было развести права доступа. У вас совпадает механика кабинета. Скажу честно: тот проект был на другом стеке. Ссылка на проект берётся только из карточки portfolio.\n\nПо деньгам: точная цена и срок из commercial_terms. Кабинет на первом этапе ограничиваем регистрацией и профилем или сразу нужна запись к врачу?',
    why: 'Конкретная реакция, неровный ритм, живая приёмка, честный стек и один предметный вопрос.',
  },
  {
    kind: 'Точечная адаптивная вёрстка',
    example: 'У вас повторяются SVG-элементы на нескольких экранах, поэтому я вынесу их в общие компоненты. Одна правка тогда не разъедется по страницам. Это экономит время.\n\nСначала сверю Figma и состояния. Потом соберу адаптив. В конце ваш дизайнер откроет согласованные ширины и сам проверит расхождения — если их нет, этап закрываем.\n\nПо деньгам: точная цена и срок из commercial_terms. Мобильные версии у вас уже нарисованы или поведение нужно определить по desktop?',
    why: 'Короткий живой отклик без искусственного риска и нумерованной строки.',
  },
  {
    kind: 'Интеграция с неизвестными ограничениями API',
    example: 'У вас поиск и AI-разбор должны остаться одним процессом, хотя внешний API может урезать часть данных. Я сначала проверю доступные методы на реальном аккаунте. Закрытый метод быстро всё меняет.\n\nПотом соберу один сквозной путь: пользователь запускает поиск, получает разбор и сохраняет решение. На приёмке ваш менеджер сам проведёт кандидата по этому сценарию. Если история не теряется, первый этап готов.\n\nНа практике такой короткий аудит дешевле переделки всей интеграции. По деньгам: точная цена и срок из commercial_terms. Тестовый доступ к действующему кабинету у вас уже есть?',
    why: 'Полезное наблюдение, действие от первого лица, сцена приёмки и простой следующий шаг.',
  },
];

const ANALYZER_VERSION = 'v3-single-pass-20260723';

type LocalFilterRule = {
  reason: string;
  pattern: RegExp;
  unless?: RegExp;
};

const LOCAL_FILTER_RULES: LocalFilterRule[] = [
  {
    reason: 'Вакансия или поиск сотрудника, а не проектная разработка',
    pattern: /музыкальн.{0,15}менеджер|ваканси|полная занятость|full[\s-]*time|резюме|собеседован|зарплат|в штат|должностн|график работы|удал[её]нн[аяой]+\s+работ/i,
    unless: /разработать|создать|сделать|доработать|исправить|настроить|интегрировать|подключить|перенести|сверстать|установить/i,
  },
  {
    reason: 'Продажи, поиск клиентов или партнёрство вместо разработки',
    pattern: /менеджер.{0,30}(продаж|заказ|клиент|проект)|помощь.{0,30}заказ|находит[ье].{0,30}заказ|поиск.{0,30}(клиент|заказ)|лидогенерац|бизнес[\s-]*партн[её]р|партн[её]р.{0,30}разработ|процент.{0,30}(продаж|заказ)|переда[её]те.{0,30}заказ/i,
  },
  {
    reason: 'Юридическая или патентная услуга',
    pattern: /патентн|роспатент|товарн.{0,10}знак|юрист|юридическ|арбитраж/i,
  },
  {
    reason: 'Инженерное проектирование вне IT',
    pattern: /раздел\s+(ов|кж|км|ар|вк)\b|вентиляц|кондиционирован|рабоч(ий|ая)\s+проект.{0,20}(здани|строител)|сметчик|кадастр/i,
  },
  {
    reason: 'Чисто визуальная, дизайнерская или контентная задача',
    pattern: /создать.{0,10}(3д|3d)[\s-]*тур|приглашени[ея].{0,20}(др|день рожден|свадьб)|сгенерировать.{0,20}(картин|изображ)|ретуш|баннер|листовк|логотип|иллюстрац|видеомонтаж|нарезк.{0,20}(видео|стрим)|копирайт|написать.{0,20}(стать|текст|сценари)/i,
    unless: /сайт|лендинг|интернет[\s-]*магазин|веб[\s-]*(сервис|прилож)|pwa|админк|личн.{0,10}кабинет/i,
  },
  {
    reason: 'Маркетинг и трафик без разработки',
    pattern: /нужен.{0,15}трафик|нагнать.{0,15}трафик|настройк.{0,20}реклам|привлечен.{0,20}трафик|продвижен.{0,20}(сайт|канал|соц)|таргет|контекстн.{0,20}реклам|вывод.{0,20}топ|smm|смм/i,
    unless: /техническ.{0,10}seo|исправить|доработать|скорост|core web vitals|schema\.org|микроразмет/i,
  },
  {
    reason: 'Учебная работа вместо коммерческой разработки',
    pattern: /курсов(ая|ую)|дипломн.{0,15}работ|лабораторн.{0,15}работ|контрольн.{0,15}работ|реферат|сдать.{0,20}(экзамен|зач[её]т)/i,
  },
  {
    reason: 'Бизнес-консалтинг или подготовка модели без разработки',
    pattern: /сформировать.{0,30}бизнес[\s-]*модел|разработать.{0,20}бизнес[\s-]*план|финансов(ая|ую).{0,20}модел|презентац.{0,20}для.{0,20}акселератор/i,
    unless: /автоматизац|сайт|веб[\s-]*(сервис|прилож)|платформ|бот|api|интеграц/i,
  },
  {
    reason: 'Узкоспециализированный стек вне профиля',
    pattern: /алгоритм.{0,30}\blua\b|терминал.{0,20}\bquik\b|архитектор\s+1с|win32 api|comsol/i,
  },
];

@Injectable()
export class AiService {
  constructor(
    private readonly settings: SettingsService,
    private readonly tasks: CodexTaskService,
    private readonly db: DatabaseService,
  ) {}

  async analyzeLead(lead: Record<string, unknown>): Promise<LeadAnalysis> {
    const seller = await this.settings.getPublic('seller_profile') || {};
    const pricingPolicy = await this.settings.getPublic('pricing_policy') || DEFAULT_PRICING_POLICY;
    const payload = {
      seller,
      pricing_policy: pricingPolicy,
      lead: {
        source: lead.source,
        title: lead.title,
        description: String(lead.description || '').slice(0, 12_000),
        budget_text: lead.budget_text,
        requirements: this.compactRequirements(lead.requirements),
      },
    };
    const result = await this.tasks.run<ModelCombinedLeadAnalysis>('lead_analysis_v2', payload);
    return this.calibrateAnalysis(lead, result, result.understanding);
  }

  analysisFingerprint(lead: Record<string, unknown>): string {
    const requirements = lead.requirements && typeof lead.requirements === 'object'
      ? lead.requirements as Record<string, unknown>
      : {};
    const project = requirements.project && typeof requirements.project === 'object'
      ? requirements.project as Record<string, unknown>
      : {};
    const stableRequirements = {
      ...requirements,
      project: {
        published_text: project.published_text || null,
        client_registered: project.client_registered || null,
        attachments: Array.isArray(project.attachments)
          ? project.attachments.map((item) => {
            const attachment = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return {
              name: attachment.name || null,
              sha256: attachment.sha256 || null,
              extracted_text: String(attachment.extracted_text || '').slice(0, 24_000),
              extraction: attachment.extraction || null,
            };
          })
          : [],
      },
    };
    return createHash('sha256').update(JSON.stringify({
      version: ANALYZER_VERSION,
      source: lead.source,
      external_id: lead.external_id,
      title: lead.title,
      description: lead.description,
      budget_text: lead.budget_text,
      requirements: stableRequirements,
    })).digest('hex');
  }

  prefilterLead(lead: Record<string, unknown>): LeadAnalysis | null {
    const title = String(lead.title || '').replace(/\s+/g, ' ').trim();
    const text = `${title}\n${lead.description || ''}`.replace(/\s+/g, ' ').trim();
    if (!text) return this.localRejection('Пустое описание проекта');
    const strongDevelopmentTitle = /^(разработка|создание|доработка|интеграция|настройка|перенос|в[её]рстка).{0,60}(сайт|магазин|сервис|систем|платформ|прилож|api|бот|crm|кабинет)/i.test(title);
    const match = LOCAL_FILTER_RULES.find((rule) => {
      if (strongDevelopmentTitle && rule.reason.startsWith('Продажи,')) return false;
      return rule.pattern.test(text) && !(rule.unless?.test(text));
    });
    return match ? this.localRejection(match.reason) : null;
  }

  async proposalReviewContext(lead: Record<string, unknown>, content = '') {
    const [sellerValue, portfolioValue, voiceprintResult, recentDraftResult] = await Promise.all([
      this.settings.getPublic('seller_profile'),
      this.settings.getPublic('fl_portfolio_cases'),
      this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM drafts
         WHERE (kind='initial_response' OR metadata->>'mode'='response')
           AND metadata->>'owner_edited'='true'`,
      ),
      this.db.query<{ content: string }>(
        `SELECT content FROM drafts
         WHERE (kind='initial_response' OR metadata->>'mode'='response')
           AND status IN ('pending','approved','sent')
         ORDER BY created_at DESC LIMIT 8`,
      ),
    ]);
    const seller = sellerValue && typeof sellerValue === 'object'
      ? sellerValue as Record<string, unknown>
      : {};
    const configuredAvailability = String(
      seller.available_from || seller.availability || '',
    ).trim().slice(0, 160);
    const portfolio = selectRelevantPortfolio(
      portfolioValue,
      `${lead.title || ''} ${lead.description || ''}`,
    );
    const metrics = content ? proposalHumanityMetrics(content) : null;
    const usedCase = content
      ? portfolio.find((item) => String(item.url || '').trim() && content.includes(String(item.url).trim()))
      : null;
    const similarity = content
      ? Math.max(0, ...recentDraftResult.rows.map((row) => this.textSimilarity(content, row.content)))
      : 0;
    return {
      technologyFit: proposalTechnologyFitContext(lead, seller, portfolioValue),
      availability: configuredAvailability,
      availabilityConfigured: Boolean(configuredAvailability),
      voiceprint: {
        sampleCount: Number(voiceprintResult.rows[0]?.count || 0),
        minimumSamples: 15,
        ready: Number(voiceprintResult.rows[0]?.count || 0) >= 15,
      },
      deliveryMetrics: metrics ? {
        ...metrics,
        warnings: proposalHumanityWarnings(metrics),
        recentSimilarity: Number(similarity.toFixed(3)),
        similarityLimit: 0.35,
        portfolioCaseUsed: Boolean(usedCase),
        portfolioDetailPresent: usedCase
          ? portfolioHumanityIssues(content, portfolio).length === 0
          : null,
        humanRulePass: proposalHumanRulePass(metrics),
      } : null,
    };
  }

  async draftReply(context: Record<string, unknown>): Promise<string> {
    const seller = await this.settings.getPublic('seller_profile') || {};
    const style = await this.settings.getPublic('style_profile') || DEFAULT_STYLE_PROFILE;
    const sourceLead = (context.lead || {}) as Record<string, unknown>;
    const allPortfolio = await this.settings.getPublic('fl_portfolio_cases') || [];
    const portfolio = selectRelevantPortfolio(
      allPortfolio,
      `${sourceLead.title || ''} ${sourceLead.description || ''}`,
    );
    const technologyFit = proposalTechnologyFitContext(
      sourceLead,
      seller && typeof seller === 'object' ? seller as Record<string, unknown> : {},
      allPortfolio,
    );
    const sourceMessages = Array.isArray(context.messages) ? context.messages : [];
    const mode = context.mode === 'chat' ? 'chat' : 'response';
    const proposalProfile = proposalProfileForLead(sourceLead);
    const [voiceResult, approvedResult, recentDraftResult] = await Promise.all([
      mode === 'chat'
        ? this.db.query<{ content: string }>(
          `SELECT content FROM messages
           WHERE direction='outbound' AND char_length(content) BETWEEN 8 AND 400
           ORDER BY created_at DESC LIMIT 16`,
        )
        : this.db.query<{ content: string }>(
          `SELECT content FROM drafts
           WHERE (kind='initial_response' OR metadata->>'mode'='response')
             AND metadata->>'owner_edited'='true'
           ORDER BY updated_at DESC LIMIT 30`,
        ),
      this.db.query<{ content: string }>(
        `SELECT content FROM drafts
         WHERE (kind='initial_response' OR metadata->>'mode'='response')
           AND (status IN ('approved','sent') OR metadata->>'owner_edited'='true')
         ORDER BY updated_at DESC LIMIT 10`,
      ),
      this.db.query<{ content: string }>(
        `SELECT content FROM drafts
         WHERE (kind='initial_response' OR metadata->>'mode'='response')
           AND status IN ('pending','approved','sent')
         ORDER BY created_at DESC LIMIT 8`,
      ),
    ]);
    const recentDrafts = recentDraftResult.rows.map((row) => row.content);
    const client = sourceLead.client && typeof sourceLead.client === 'object'
      ? sourceLead.client as Record<string, unknown>
      : {};
    const clientName = String(client.fl_name || client.name || '').trim().slice(0, 80);
    const configuredAvailability = String(
      (seller as Record<string, unknown>).available_from
      || (seller as Record<string, unknown>).availability
      || '',
    ).trim().slice(0, 160);
    const availability = configuredAvailability ? `Старт: ${configuredAvailability}` : '';
    const variationPlan = proposalVariationPlan(
      recentDrafts,
      String(sourceLead.external_id || sourceLead.id || sourceLead.title || ''),
    );
    const commercialTerms: ProposalCommercialContext = {
      price: Number(sourceLead.recommended_price) || undefined,
      days: Number(sourceLead.recommended_days) || undefined,
      availability: availability || undefined,
      availabilityConfigured: Boolean(configuredAvailability),
      clientName: clientName || undefined,
      hookPattern: variationPlan.hookPattern,
      acceptanceLabel: variationPlan.acceptanceLabel,
      technologyFit,
    };
    const voiceprintExamples = selectVoiceprintExamples(
      voiceResult.rows.map((row) => row.content),
      `${sourceLead.title || ''} ${sourceLead.description || ''}`,
      3,
    );
    const voiceprintReady = mode === 'chat' ? voiceprintExamples.length >= 2 : voiceResult.rows.length >= 15;
    const compactContext = {
      lead: {
        title: sourceLead.title,
        description: String(sourceLead.description || '').slice(0, 12_000),
        budget_text: sourceLead.budget_text,
        score: sourceLead.score,
        recommended_price: sourceLead.recommended_price,
        recommended_days: sourceLead.recommended_days,
        analysis: sourceLead.analysis,
        requirements: sourceLead.requirements,
        client: {
          name: clientName || null,
          username: client.fl_username || null,
        },
      },
      messages: sourceMessages.slice(-50).map((message: Record<string, unknown>) => ({
        direction: message.direction,
        author: message.author,
        content: String(message.content || '').slice(0, 4_000),
      })),
    };
    const payload = {
      seller,
      style,
      portfolio,
      mode,
      proposal_profile: {
        name: proposalProfile,
        ...PROPOSAL_LIMITS[proposalProfile],
        reason: proposalProfile === 'compact'
          ? 'Точечная задача: сохранить всю продающую логику, но не раздувать простой объём.'
          : proposalProfile === 'premium'
            ? 'Дорогой сложный проект: показать этапность, критерии приёмки и управляемое снижение риска.'
            : 'Обычный отклик FL.ru по исследовательской норме 100–200 слов.',
      },
      response_principles: RESPONSE_PRINCIPLES,
      calibration_examples: RESPONSE_CALIBRATION,
      variation_plan: {
        required_hook_pattern: variationPlan.hookPattern,
        required_acceptance_label: variationPlan.acceptanceLabel,
        required_acceptance_text: variationPlan.acceptanceText,
      },
      opening_seed: proposalOpeningSeed(
        String(sourceLead.external_id || sourceLead.id || sourceLead.title || ''),
        clientName,
      ),
      commercial_terms: {
        price_rub: commercialTerms.price,
        duration_days: commercialTerms.days,
        availability: availability || null,
        availability_configured: Boolean(configuredAvailability),
        availability_warning: configuredAvailability
          ? null
          : 'Дата старта не подтверждена владельцем. Не выдумывать и не вставлять системную заглушку; черновик требует ручной проверки доступности.',
        client_name: clientName || null,
        greeting_required: Boolean(clientName),
      },
      technology_fit: technologyFit,
      submission_fields: {
        price: 'FL.ru получает recommended_price отдельным числовым полем',
        days: 'FL.ru получает recommended_days отдельным числовым полем',
        cover_letter: 'Текст обязательно повторяет цену и срок. Старт добавляется только из подтверждённой настройки профиля',
      },
      owner_instructions: String(context.ownerInstructions || '').slice(0, 4_000),
      voiceprint: {
        source: mode === 'chat' ? 'Ручные исходящие сообщения владельца.' : 'Только отклики, которые владелец отредактировал вручную. Просто одобренные AI-черновики в voiceprint не попадают.',
        ready: voiceprintReady,
        sample_count: voiceResult.rows.length,
        minimum_samples: mode === 'chat' ? 2 : 15,
        rules: voiceprintReady
          ? 'Использовать только ритм, обращения и привычные связки. Факты, имена, цены, сроки и кейсы из примеров переносить запрещено.'
          : 'Корпус голоса ещё мал. Не выдавать approved_examples за голос владельца; писать по общим правилам живого делового сообщения.',
        examples: voiceprintExamples.map((content) => content.slice(0, 560)),
      },
      voice_examples: voiceprintExamples.map((content) => content.slice(0, 300)),
      approved_examples: approvedResult.rows.slice(0, 3).map((row) => row.content.slice(0, 560)),
      recent_drafts: recentDraftResult.rows.map((row) => row.content.slice(0, 560)),
      context: compactContext,
    };

    if (mode === 'chat') {
      let result = await this.tasks.run<{ content: string }>('draft_reply', payload);
      let content = String(result.content || '').trim();
      const issues = [...this.draftQualityIssues(content, mode), ...portfolioLinkIssues(content, portfolio)];
      if (issues.length) {
        result = await this.tasks.run<{ content: string }>('draft_reply', {
          ...payload,
          revision: proposalRevisionGuidance(content, issues, portfolio),
        });
        content = String(result.content || '').trim();
      }
      return content;
    }

    const strategy = await this.tasks.run<DraftStrategy>('draft_strategy', payload);
    const generated = await this.tasks.run<{ candidates: DraftCandidate[] }>('draft_candidates', { ...payload, strategy });
    const candidates = Array.isArray(generated.candidates) ? generated.candidates.slice(0, 3) : [];
    const candidateDiagnostics = candidates.map((candidate, index) => {
      const candidateContent = normalizeProposalFormatting(String(candidate.content || ''), commercialTerms);
      const candidateIssues = this.draftQualityIssues(
        candidateContent,
        mode,
        recentDraftResult.rows.map((row) => row.content),
        proposalProfile,
        commercialTerms,
      );
      candidateIssues.push(...portfolioLinkIssues(candidateContent, portfolio));
      candidateIssues.push(...portfolioEvidenceIssues(candidateContent, portfolio));
      candidateIssues.push(...portfolioHumanityIssues(candidateContent, portfolio));
      return {
        index,
        angle: String(candidate.angle || '').slice(0, 180),
        humanity_metrics: proposalHumanityMetrics(candidateContent),
        issues: candidateIssues,
      };
    });
    let reviewed = await this.tasks.run<DraftReview>('draft_review', {
      ...payload, strategy, candidates, candidate_diagnostics: candidateDiagnostics,
    });
    let content = normalizeProposalFormatting(String(reviewed.content || ''), commercialTerms);
    const issues = this.draftQualityIssues(
      content,
      mode,
      recentDraftResult.rows.map((row) => row.content),
      proposalProfile,
      commercialTerms,
    );
    issues.push(...portfolioLinkIssues(content, portfolio));
    issues.push(...portfolioEvidenceIssues(content, portfolio));
    issues.push(...portfolioHumanityIssues(content, portfolio));
    if (Number(reviewed.human_score) < 85) issues.push('Редактор оценил естественность ниже 85/100: перепиши как личное сообщение человека.');
    if (Number(reviewed.sales_score) < 85) issues.push('Редактор оценил причину ответить ниже 85/100: усили конкретную ценность следующего шага.');
    if (Number(reviewed.specificity_score) < 90) issues.push('Текст можно отправить другому заказчику почти без изменений: добавь один уникальный якорь именно этого проекта.');
    if (Number(reviewed.factual_score) < 100) issues.push('Есть неподтверждённое утверждение: оставь только факты из seller и portfolio.');
    if (issues.length) {
      reviewed = await this.tasks.run<DraftReview>('draft_review', {
        ...payload,
        strategy,
        candidates,
        candidate_diagnostics: candidateDiagnostics,
        revision: proposalRevisionGuidance(content, issues, portfolio),
      });
      content = normalizeProposalFormatting(String(reviewed.content || ''), commercialTerms);
    }
    const finalIssues = this.draftQualityIssues(
      content,
      mode,
      recentDraftResult.rows.map((row) => row.content),
      proposalProfile,
      commercialTerms,
    );
    finalIssues.push(...portfolioLinkIssues(content, portfolio));
    finalIssues.push(...portfolioEvidenceIssues(content, portfolio));
    finalIssues.push(...portfolioHumanityIssues(content, portfolio));
    if (Number(reviewed.human_score) < 85) finalIssues.push('Итоговый текст звучит как AI-шаблон.');
    if (Number(reviewed.sales_score) < 85) finalIssues.push('Итоговый текст не даёт достаточной причины ответить.');
    if (Number(reviewed.specificity_score) < 90) finalIssues.push('Итоговому тексту не хватает деталей конкретного заказа.');
    if (Number(reviewed.factual_score) < 100) finalIssues.push('Итоговый текст содержит неподтверждённый факт.');
    if (finalIssues.length) {
      reviewed = await this.tasks.run<DraftReview>('draft_review', {
        ...payload,
        strategy,
        candidates,
        candidate_diagnostics: candidateDiagnostics,
        revision: proposalRevisionGuidance(content, finalIssues, portfolio),
      });
      content = normalizeProposalFormatting(String(reviewed.content || ''), commercialTerms);
      finalIssues.length = 0;
      finalIssues.push(...this.draftQualityIssues(
        content,
        mode,
        recentDraftResult.rows.map((row) => row.content),
        proposalProfile,
        commercialTerms,
      ));
      finalIssues.push(...portfolioLinkIssues(content, portfolio));
      finalIssues.push(...portfolioEvidenceIssues(content, portfolio));
      finalIssues.push(...portfolioHumanityIssues(content, portfolio));
      if (Number(reviewed.human_score) < 85) finalIssues.push('Итоговый текст звучит как AI-шаблон.');
      if (Number(reviewed.sales_score) < 85) finalIssues.push('Итоговый текст не даёт достаточной причины ответить.');
      if (Number(reviewed.specificity_score) < 90) finalIssues.push('Итоговому тексту не хватает деталей конкретного заказа.');
      if (Number(reviewed.factual_score) < 100) finalIssues.push('Итоговый текст содержит неподтверждённый факт.');
    }
    const blockingFinalIssues = proposalFinalBlockingIssues(content, finalIssues);
    if (blockingFinalIssues.length) {
      throw new Error(`Отклик не прошёл финальную проверку качества: ${blockingFinalIssues.join(' ')}`);
    }
    return content.charAt(0).toUpperCase() + content.slice(1);
  }

  private draftQualityIssues(
    content: string,
    mode: 'response' | 'chat',
    recentDrafts: string[] = [],
    profile: ProposalProfile = 'standard',
    commercial: ProposalCommercialContext = {},
  ) {
    if (mode === 'chat') return [];
    const issues: string[] = proposalResearchIssues(content, profile, commercial);
    const lower = content.toLowerCase();
    const banned = [
      'ключевой риск', 'ключевой узел', 'ближайший по механике кейс',
      'доброго времени суток', 'уважаемый заказчик', 'я внимательно прочитал',
      'я внимательно изучил', 'готов приступить', 'готов реализовать',
      'имею большой опыт', 'качественно и в срок', 'сделаю качественно и в срок',
      'индивидуальный подход', 'современное решение', 'уже прикинул концепт',
      'в обозначенных границах', 'коммерческая рамка',
      'тут по описанию получается', 'я понял задачу как', 'вам нужно',
      'задача заключается', 'речь идет о', 'если речь о',
      'нужно уточнить границу', 'в описании есть', 'по описанию',
      'готов собрать', 'рабочий контур', 'первый контур',
      'в портфолио есть fullstack', 'сложная бизнес-логика',
      'обращайтесь, обсудим детали', 'fullstack',
      'важно отметить', 'ключевой момент', 'это особенно важно',
      'в современных реалиях', 'таким образом', 'подводя итог',
      'не служит подтверждением', 'не является гарантией',
    ];
    const found = banned.filter((phrase) => lower.includes(phrase));
    if (found.length) issues.push(`Шаблонные или AI-фразы: ${found.join(', ')}`);
    if (/(?:^|[^\p{L}])(?:лучше|стоит)(?=$|[^\p{L}])[^.!?]{0,160}(?:^|[^\p{L}])иначе(?=$|[^\p{L}])/imu.test(content)) {
      issues.push('Получилась заезженная формула «лучше сделать X, иначе Y»: перепиши как нормальное личное сообщение, без мини-лекции.');
    }
    if (/^(?:[^.!?\n]{0,80})(?:лучше|стоит|нужно)[^.!?\n]{0,100}(?:провер|фиксац|уточн)/iu.test(content.trim())) {
      issues.push('Не повторяй шаблонный заход «X стоит делать после проверки Y»: используй назначенный вариант хука.');
    }
    const similarity = Math.max(0, ...recentDrafts.map((draft) => this.textSimilarity(content, draft)));
    if (similarity >= 0.35) issues.push('Текст слишком похож на один из недавних откликов: поменяй тип захода, длину, синтаксис и доказательство.');
    const recentCredentialCount = recentDrafts.filter((draft) => /(?:6|шесть)\s+лет|яндекс/i.test(draft)).length;
    if (/(?:6|шесть)\s+лет|яндекс/i.test(content) && recentCredentialCount >= 2) {
      issues.push('Стаж или Яндекс уже повторялись в недавних откликах: замени этот заполнитель конкретным решением, кейсом или следующим шагом.');
    }
    const recentCaseCtaCount = recentDrafts.filter((draft) => /могу показать/i.test(draft)).length;
    if (/могу показать/i.test(content) && recentCaseCtaCount >= 3) {
      issues.push('Фраза «могу показать» уже повторяется: оставь её только при очень близком кейсе и сформулируй следующий шаг иначе.');
    }
    const recentMaterialCtaCount = recentDrafts.filter((draft) => /(?:пришлите|отправьте|покажите)(?=$|[^\p{L}])/iu.test(draft)).length;
    if (/(?:пришлите|отправьте|покажите)(?=$|[^\p{L}])/iu.test(content) && recentMaterialCtaCount >= 3) {
      issues.push('Просьба прислать материалы уже повторяется в недавних откликах: выбери другой естественный следующий шаг или один важный вопрос.');
    }
    return issues;
  }

  private textSimilarity(left: string, right: string): number {
    const shingles = (value: string) => {
      const words = value.toLowerCase().replace(/[^а-яёa-z0-9]+/gi, ' ').trim().split(/\s+/).filter(Boolean);
      return new Set(words.slice(0, -2).map((_, index) => words.slice(index, index + 3).join(' ')));
    };
    const a = shingles(left);
    const b = shingles(right);
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection += 1;
    return intersection / Math.min(a.size, b.size);
  }

  private calibrateAnalysis(lead: Record<string, unknown>, result: ModelLeadAnalysis, understanding: LeadUnderstanding): LeadAnalysis {
    const rawPrice = Math.max(0, Math.round(Number(result.recommended_price) || 0));
    const rawDays = Math.max(1, Math.round(Number(result.recommended_days) || 1));
    const selfContainedIntegrationCategories: PricingCategory[] = [
      'automation_or_bot',
      'store_complex',
      'crm_admin_analytics',
      'platform_mvp',
      'platform_large',
      'mobile_mvp',
    ];
    const pricingModifiers = selfContainedIntegrationCategories.includes(result.pricing_category)
      ? (Array.isArray(result.pricing_modifiers)
        ? result.pricing_modifiers.filter((modifier) => !String(modifier).startsWith('integration_'))
        : [])
      : result.pricing_modifiers;
    const catalog = calculateCatalogPrice({
      category: result.pricing_category,
      level: result.pricing_level,
      modifiers: pricingModifiers,
      estimatedDays: rawDays,
    });
    const price = catalog?.price ?? rawPrice;
    const days = catalog?.days ?? rawDays;
    const technicalFit = this.clampScore(result.technical_fit);
    let commercialFit = this.clampScore(result.commercial_fit);
    const briefQuality = this.clampScore(result.brief_quality);
    const deliveryRisk = this.clampScore(result.delivery_risk);
    const explicitBudget = this.extractExplicitBudget(lead.budget_text);
    const severeBudgetMismatch = explicitBudget !== null && price > explicitBudget * 2.5;
    if (severeBudgetMismatch) commercialFit = Math.min(commercialFit, 30);
    let score = Math.round(
      technicalFit * 0.55
      + commercialFit * 0.2
      + briefQuality * 0.1
      + (100 - deliveryRisk) * 0.15,
    );
    if (understanding.buyer_intent === 'irrelevant') score = Math.min(score, 25);
    if (understanding.buyer_intent === 'unrealistic') score = Math.min(score, 45);
    if (understanding.buyer_intent === 'contradictory') score = Math.min(score, 60);
    const blockedIntent = ['irrelevant', 'unrealistic'].includes(understanding.buyer_intent);
    const shouldRespond = Boolean(
      result.should_respond
      && !blockedIntent
      && !severeBudgetMismatch
      && technicalFit >= 60
      && commercialFit >= 35,
    );
    const confidence = Math.round((this.clampScore(result.confidence) + this.clampScore(understanding.confidence)) / 2);
    const modifierText = catalog?.modifiers.length ? `; модификаторы: ${catalog.modifiers.join(', ')}` : '';
    const assumption = understanding.assumption_for_quote.trim();
    return {
      ...result,
      score,
      confidence,
      technical_fit: technicalFit,
      commercial_fit: commercialFit,
      brief_quality: briefQuality,
      delivery_risk: deliveryRisk,
      should_respond: shouldRespond,
      recommended_price: price,
      recommended_days: days,
      pricing_category: catalog?.category ?? result.pricing_category,
      pricing_level: catalog?.level ?? result.pricing_level,
      pricing_modifiers: catalog?.modifiers ?? result.pricing_modifiers,
      understanding,
      client_value: catalog
        ? `Категория: ${catalog.label}, уровень ${catalog.level}${modifierText}. Цена ${price.toLocaleString('ru-RU')} ₽, срок ${days} дней. Допущение: ${assumption}`
        : result.client_value,
    };
  }

  private clampScore(value: unknown): number {
    return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  }

  private extractExplicitBudget(value: unknown): number | null {
    const text = String(value || '').toLowerCase().replace(/[\u00a0\u202f]/g, ' ');
    if (!text || /договор|обсужд|уточн/.test(text)) return null;
    const values = [...text.matchAll(/\d[\d\s]*/g)]
      .map((match) => Number(match[0].replace(/\s/g, '')))
      .filter((number) => Number.isFinite(number) && number >= 10_000);
    return values.length ? Math.max(...values) : null;
  }

  private understandingQualityIssues(value: LeadUnderstanding): string[] {
    const issues: string[] = [];
    const serialized = JSON.stringify(value).toLowerCase();
    const metaLeaks = ['actually', 'oops', 'need fix', 'cannot edit', "we're composing", 'json needed'];
    const found = metaLeaks.filter((phrase) => serialized.includes(phrase));
    if (found.length) issues.push(`В результат попали внутренние рассуждения или языковой мусор: ${found.join(', ')}`);
    if (!String(value.assumption_for_quote || '').trim()) issues.push('Нет одного ясного коммерческого допущения для цены.');
    if (value.project_kind !== 'non_development' && !value.confirmed_scope?.length) issues.push('Не выделен подтверждённый объём разработки.');
    if (value.project_kind === 'non_development' && value.buyer_intent !== 'irrelevant') issues.push('Чужая специализация должна быть помечена как irrelevant.');
    return issues;
  }

  private compactRequirements(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') return {};
    const requirements = value as Record<string, unknown>;
    if (!requirements.project || typeof requirements.project !== 'object') return requirements;
    const project = requirements.project as Record<string, unknown>;
    let remainingText = 24_000;
    const attachments = Array.isArray(project.attachments)
      ? project.attachments.slice(0, 6).map((item) => {
        const attachment = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        const excerpt = String(attachment.extracted_text || '').slice(0, Math.min(8_000, remainingText));
        remainingText -= excerpt.length;
        return {
          name: String(attachment.name || '').slice(0, 180),
          content_type: String(attachment.content_type || '').slice(0, 120),
          size: Number(attachment.size) || 0,
          sha256: String(attachment.sha256 || '').slice(0, 128),
          local_path: String(attachment.local_path || '').slice(0, 500),
          extraction: attachment.extraction,
          extracted_text: excerpt,
        };
      })
      : [];
    return {
      ...requirements,
      project: {
        published_at: project.published_at || null,
        published_text: String(project.published_text || '').slice(0, 2_000),
        client_registered: project.client_registered || null,
        response_count: project.response_count ?? null,
        attachments,
      },
    };
  }

  private localRejection(reason: string): LeadAnalysis {
    const understanding: LeadUnderstanding = {
      summary: reason,
      project_kind: 'non_development',
      buyer_intent: 'irrelevant',
      existing_system: 'unknown',
      confirmed_scope: [],
      wishlist_or_future_scope: [],
      separate_costs: [],
      critical_unknowns: [],
      assumption_for_quote: 'Отклик не формируется: задача вне профиля разработки.',
      pricing_category_hint: 'small_fix',
      pricing_level_hint: 'low',
      relevance_signals: [],
      mismatch_signals: [reason],
      confidence: 98,
    };
    return {
      score: 5,
      confidence: 98,
      technical_fit: 5,
      commercial_fit: 10,
      brief_quality: 70,
      delivery_risk: 20,
      recommended_price: 0,
      recommended_days: 1,
      fit_reason: reason,
      client_value: `Локальный предфильтр: ${reason}`,
      risks: [],
      questions: [],
      should_respond: false,
      pricing_category: 'small_fix',
      pricing_level: 'low',
      pricing_modifiers: [],
      understanding,
    };
  }

  async generateSpecification(context: Record<string, unknown>): Promise<string> {
    const result = await this.tasks.run<{ markdown: string }>('specification', { context });
    return String(result.markdown || '').trim();
  }

  async generateContractData(context: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.tasks.run<Record<string, unknown>>('contract_data', { context });
  }
}
