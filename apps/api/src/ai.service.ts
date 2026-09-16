import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CodexTaskService } from './codex-task.service';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';
import {
  calculateBottomUpPrice,
  calculateCatalogPrice,
  DEFAULT_DAILY_RATE_RUB,
  DEFAULT_MIN_DEAL_PRICE_RUB,
  DEFAULT_PRICING_POLICY,
  dealValueScore,
  PricingCategory,
  PricingLevel,
  PricingModifier,
  reconcileEstimate,
  sizeGrade,
  underpricingRatio,
  SizeGrade,
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
  /** What the order is worth to the business, 0…100; part of the score. */
  deal_value?: number;
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
  /** The list of work the price was built from, so a quote can be argued instead of asserted. */
  work_breakdown?: Array<Record<string, unknown>>;
  /** Honest spread of the same estimate; the buyer sees it, FL.ru fields keep the centre. */
  price_range?: [number, number];
  days_range?: [number, number];
  estimate_source?: 'breakdown' | 'catalog';
  /** Fair-price bucket: small / medium / large. Arithmetic, not another model opinion. */
  size_grade?: SizeGrade;
  /**
   * The client's named fixed budget is far below the fair price: replying with
   * the named number would quietly commit to a losing deal. The draft is held
   * and the owner is alerted instead of auto-replying.
   */
  underpriced?: { named_budget: number; fair_price: number; ratio: number } | null;
  /** The brief explicitly stages the project (этап 1, очереди) — a long-term client signal. */
  ltv_stage_signal?: boolean;
  /** A separately costed cheapest working path, when one honestly exists. */
  lean_breakdown?: Array<Record<string, unknown>>;
  lean_price?: number;
  lean_days?: number;
  lean_tradeoff?: string;
}

type ModelLeadAnalysis = Omit<LeadAnalysis, 'understanding'>;
type ModelCombinedLeadAnalysis = ModelLeadAnalysis & { understanding: LeadUnderstanding };

type DraftCompose = {
  content: string;
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

export type ProposalCommercialContext = {
  price?: number;
  days?: number;
  availability?: string;
  availabilityConfigured?: boolean;
  technologyFit?: ProposalTechnologyFit;
  contactTelegram?: string;
  estimateMode?: ProposalEstimateMode;
  /** Honest spread behind the single number, when the price came from a work breakdown. */
  priceRange?: [number, number];
  daysRange?: [number, number];
};

export type ProposalEstimateMode = 'grounded' | 'rough';

/** Only a real, ordered, positive spread is worth showing a buyer. */
export function proposalRangeFrom(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const low = Math.round(Number(value[0]));
  const high = Math.round(Number(value[1]));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low) return undefined;
  return [low, high];
}

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
  compact: { minWords: 35, maxWords: 85, minChars: 220, maxChars: 620 },
  standard: { minWords: 100, maxWords: 200, minChars: 650, maxChars: 2400 },
  premium: { minWords: 90, maxWords: 160, minChars: 600, maxChars: 1_150 },
};

/**
 * Phrases with a measured negative effect on reply rate, plus the ones the owner's own
 * naturalness review flagged.  Percentages in the comments are GigRadar's drift figures
 * from English Upwork proposals; the Russian wordings are the direct equivalents.
 */
export const PROPOSAL_CLICHES = [
  // Measured drift, strongest first.
  'спасибо за размещение', 'благодарю за публикацию', 'спасибо за ваш заказ', // −5.50pp
  'многие фрилансеры', 'в отличие от других исполнителей', 'в отличие от многих', // −4.03pp
  'доброго времени суток', // −3.68pp
  'у меня есть опыт работы с', 'имею опыт работы с', 'имею большой опыт', // −3.67pp
  'я помогу вам с', 'готов помочь вам решить', // −3.17pp
  'будете ли вы открыты', 'не хотели бы вы', // −2.74pp
  'предлагаю созвон', 'установочный звонок', 'обсудим детали в звонке', 'обсудить детали', // −2.17pp
  'этот отклик написан не нейросетью', 'написано не нейросетью', // −1.55pp
  'индивидуальный подход', 'решение под ваши задачи', 'современное решение', // −1.15pp
  'выберите меня', 'буду рад сотрудничеству', // −0.88pp
  'с уважением', 'с наилучшими пожеланиями', // −0.55pp
  'начнём завтра', 'начнем завтра', // −1.87pp
  'calendly',
  // Brief recital: the client wrote it and learns nothing from reading it back.
  'у вас в задаче', 'как я понял, вам', 'я понял задачу как', 'вы ищете специалиста',
  'вам нужно', 'задача заключается', 'если речь о', 'по описанию', 'в описании есть',
  // Competence-eroding hedges.
  'готов освоить', 'быстро учусь', 'разберусь по ходу', 'к сожалению, у меня нет опыта',
  // Vocabulary that belongs to the instructions, not to a letter a human writes.
  'по классу задачи', 'класс задачи', 'непереносимая деталь', 'микро-план', 'критерий приёмки:',
  'ключевая развилка', 'узкое место здесь не в', 'это ключевая развилка',
  // Owner's own naturalness blacklist, kept.
  'уважаемый заказчик', 'я внимательно прочитал', 'я внимательно изучил',
  'готов приступить', 'готов реализовать', 'качественно и в срок', 'сделаю качественно и в срок',
  'обращайтесь, обсудим детали', 'ключевой риск', 'ключевой узел', 'ближайший по механике кейс',
  'уже прикинул концепт', 'в обозначенных границах', 'коммерческая рамка',
  'тут по описанию получается', 'нужно уточнить границу', 'готов собрать',
  'рабочий контур', 'первый контур', 'в портфолио есть fullstack', 'сложная бизнес-логика',
  'важно отметить', 'ключевой момент', 'это особенно важно',
  'в современных реалиях', 'таким образом', 'подводя итог',
  'не служит подтверждением', 'не является гарантией',
];

/**
 * Anti-fingerprinting used to dictate one of five literal first phrases, which is why
 * every proposal opened with "У вас в задаче" and read as a brief recital.  Rotating the
 * *approach* and forbidding repeats gives variety without putting words in the mouth.
 */
export function proposalProfileForLead(lead: Record<string, unknown>): ProposalProfile {
  const description = String(lead.description || '').trim();
  const price = Number(lead.recommended_price) || 0;
  if (description.length <= 220 || (price > 0 && price <= 40_000)) return 'compact';
  if (price >= 500_000) return 'premium';
  // Two implementation paths with an honest downside for each cannot be said in 130
  // words: the letter either drops a path or drops the reason it matters. When the
  // task genuinely splits, buy the room instead of cutting the argument.
  if (proposalOffersOptions(lead)) return 'premium';
  return 'standard';
}

/**
 * A brief supports cheap-versus-proper options when the same outcome can be reached by
 * wiring existing services or by building the thing, and the buyer signalled that money
 * or speed is the constraint.
 */
export function proposalOffersOptions(lead: Record<string, unknown>): boolean {
  const analysis = (lead.analysis && typeof lead.analysis === 'object'
    ? lead.analysis
    : {}) as Record<string, unknown>;
  const breakdown = Array.isArray(analysis.work_breakdown) ? analysis.work_breakdown : [];
  const range = Array.isArray(analysis.price_range) ? analysis.price_range : null;
  const spread = range && Number(range[0]) > 0 ? Number(range[1]) / Number(range[0]) : 0;
  const text = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
  // "бот" without a boundary also matches разраБОТка, раБОТа and обраБОТка, which is
  // most of the briefs on the board.
  const assemblable = /(?:интеграц|автоматизац|конвейер|(?<![а-яё])бот|парсинг|выгрузк|уведомлен|публикац|(?<![а-яё])сервис|(?<![а-яё])api)/iu.test(text);
  // Five or more separate pieces of work means there is something to trade away.
  return assemblable && breakdown.length >= 5 && spread >= 1.8;
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

/** Money amounts the reply names with a currency sign (₽ / руб). */
export function proposalNamedPrices(content: string): number[] {
  const amounts: number[] = [];
  for (const match of String(content || '').matchAll(/(\d[\d\s]{2,12})\s*(?:₽|руб\.?|р\.)/giu)) {
    const value = Number(match[1].replace(/\s+/g, ''));
    if (Number.isFinite(value) && value >= 10_000) amounts.push(value);
  }
  return [...new Set(amounts)];
}

/** Safe deterministic cleanup for formatting that should not consume an AI retry. */
export function normalizeProposalFormatting(
  content: string,
  commercial: ProposalCommercialContext = {},
): string {
  let normalized = content.trim();
  const price = Math.round(Number(commercial.price) || 0);
  if (price >= 10_000) {
    const raw = String(price);
    const grouped = priceWithSpaces(price);
    normalized = normalized.replace(
      new RegExp(`(^|[^\\d])${raw}(?=\\s*(?:₽|руб(?:\\.|лей|ля)?))`, 'gimu'),
      (_match, prefix: string) => `${prefix}${grouped}`,
    );
  }

  // The contact is a profile fact, not prose the model may choose to omit. Keep the
  // model instruction for a natural ending, but enforce the exact handle here so every
  // generated and regenerated FL.ru proposal gives the client a way to reach the owner.
  const contact = String(commercial.contactTelegram || '').trim();
  if (contact && !normalized.includes(contact)) {
    normalized += `\n\nЕсли появятся вопросы, готов ответить здесь в чате или в телеграме ${contact}.`;
  }
  return normalized;
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
  // A verbless short sentence that names nothing of the client's ("Риск под контролем",
  // "Это проверяемо") is the filler the generator reaches for when it needs a rhythm
  // break and has nothing left to say. A digit or a "у вас" makes it real content again.
  const verbEnding = /(?:ть|ти|чь|[юуеё]шь|[иеауяю]т|[иеаяу]м|[иеая]те|л[аои]?|ся|сь|ю|у)$/iu;
  const isHollowAccent = (sentence: { text: string; words: string[] }) => (
    sentence.words.length >= 2
    && sentence.words.length <= 4
    // Only demonstrative openers qualify. A verbless beat that names something concrete
    // ("Затык обычно в идентификаторе.") is the most valuable sentence in the letter.
    && /^(?:это|так|вс[её]|тут|здесь)(?=$|[^\p{L}])/iu.test(sentence.text.trim())
    && !/\d/u.test(sentence.text)
    && !/[?]/u.test(sentence.text)
    && !/(?:^|[^\p{L}])(?:у\s+вас|вам|ваш|ваше|ваши|вашего|вашу)(?=$|[^\p{L}])/iu.test(sentence.text)
    && !/^(?:добрый\s+день|здравствуйте|привет)/iu.test(sentence.text.trim())
    && !sentence.words.some((word) => verbEnding.test(word))
  );
  // "Так данные не расходятся." right after naming a risk reads as a non sequitur.
  // Every short sentence that opens with "Так" is the generator padding the rhythm.
  const isSoAssertion = (sentence: { text: string; words: string[] }) => (
    sentence.words.length <= 5
    && !/[?]/u.test(sentence.text)
    && /^так(?=$|[^\p{L}])/iu.test(sentence.text.trim())
  );
  const isListedFiller = (sentence: { text: string; words: string[] }) => (
    sentence.words.length <= 5
    && /^(?:вс[её]\s+(?:понятно|прозрачно|просто|готово)|границы\s*(?:[—-]\s*сразу|закрепим)|откат\s+предусмотрю|риски?\s+(?:понятны|видны)|это\s+(?:главное|важно)|вот\s+и\s+вс[её]|это\s+ключев[а-яё]+\s+развилк[а-яё]+|(?:вс[её]|риски?|сроки?|объ[её]м)\s+под\s+контролем|это\s+(?:проверяемо|решаемо|обратимо)|здесь\s+это\s+особенно\s+(?:важно|полезно)|это\s+(?:важно|полезно|критично)\s+здесь|так\s+надёжнее|так\s+честнее)[.!]?$/iu.test(sentence.text.trim())
  );
  // A sentence is filler once, however many rules recognise it.
  const emptyAccentCount = sentences.filter((sentence) => isHollowAccent(sentence) || isListedFiller(sentence) || isSoAssertion(sentence)).length;
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
  // The approved voice drops the pronoun like spoken Russian does: «сразу закладываю»,
  // «сниму парсером».  So «я» is optional here and the verb list covers the present and
  // future forms the owner actually writes, not just past-tense case reports.
  const firstPersonActionCount = (content.match(
    /(?:^|[^\p{L}])(?:я\s+)?(?:делал|делаю|сделал|сделаю|собрал|соберу|разработал|реализовал|реализую|спроектировал|настроил|настрою|подключил|подключу|внедрил|создал|проверю|покажу|сверю|опишу|зафиксирую|предусмотрю|продумаю|проведу|разведу|договорюсь|пишу|снимаю|сниму|закладываю|вынесу|набросаю|распишу|перенесу|напишу|посчитаю|прикручу|добавлю|выберу|разверну)(?=$|[^\p{L}])/gimu,
  ) || []).length;
  const conversationalConnectorCount = (content.match(
    // "скажу честно" was counted as a live connector while the cliché list bans it as an
    // apology marker; the rules were pulling against each other, so it is out.
    /(?:^|[^\p{L}])(?:кстати|по\s+деньгам|на\s+практике|проще\s+говоря|сразу\s+скажу|если\s+коротко|по\s+опыту|самое\s+хитрое\s+было|на\s+деле)(?=$|[^\p{L}])/gimu,
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
  // «Из похожего — делал X» drops the pronoun the same way the approved voice does.
  if (!/(?:^|[^\p{L}])(?:я\s+)?(?:делал|делаю|сделал|собрал|разработал|реализовал|спроектировал|настроил|подключил|внедрил|создал|отвечал|проектировал)(?=$|[^\p{L}])/iu.test(paragraph)) {
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

/**
 * A proposal that reached the end of the pipeline but failed the automatic style and
 * evidence checks.  It carries the text, because throwing away six minutes of work and
 * leaving the owner with nothing is worse than handing over a flagged draft the owner
 * can read, edit or regenerate.  Nothing is ever sent without approval anyway.
 */
export class ProposalQualityError extends Error {
  constructor(readonly content: string, readonly issues: string[]) {
    super(`Отклик не прошёл финальную проверку качества: ${issues.join(' ')}`);
    this.name = 'ProposalQualityError';
  }
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

  const humanity = proposalHumanityMetrics(content);
  // 0.60 is the editorial target. Only <0.55 is a hard generation failure;
  // 0.55–0.59 stays visible in metadata for calibration instead of blocking work.
  if (humanity.burstinessHardFail) {
    const targetSentences = profile === 'premium' ? '8–12' : profile === 'standard' ? '6–10' : '4–7';
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
    issues.push('Убери протокольное «не служит подтверждением/не является гарантией»: скажи то же самое обычными словами.');
  }

  const withoutGreeting = content.trim().replace(/^(?:(?:[\p{L} -]{2,40},\s*)?(?:добрый день|здравствуйте|привет)[.!]?\s*)/iu, '');
  const firstSentence = withoutGreeting.split(/[.!?\n]/, 1)[0].trim().toLowerCase();
  const firstSentenceWords = firstSentence.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
  if (firstSentenceWords.length > 24) {
    issues.push(`Первая фраза перегружена: разбей её на две короткие, не более 24 слов в первой.`);
  }
  if (/^(?:внимательно (?:прочитал|изучил)|готов (?:выполнить|приступить)|задача понятна)/iu.test(firstSentence)) {
    issues.push('Первый экран занят шаблонным филлером: начни с конкретной детали этого заказа.');
  }
  // The owner's own shape: greeting, a short take on the task, "делал похожее" with a
  // one-sentence description and the link, the gotcha he already knows about, done.
  // A staged micro-plan and an acceptance scene are what turned proposals into a wall of
  // text, so they are no longer required — only allowed.
  const firstLine = content.trim().split(/\n/u)[0].trim();
  if (!/^(?:добрый\s+день|здравствуйте|доброе\s+утро|добрый\s+вечер)/iu.test(content.trim())) {
    issues.push('Начни с обычного приветствия, «Добрый день!» или «Здравствуйте!».');
  } else if (firstLine.length > 20) {
    issues.push('Приветствие поставь отдельной строкой, а дальше с новой строки пиши, что готов взяться.');
  }
  if (!/(?:^|[^\p{L}])(?:делал|сделал|собирал|собрал|разрабатывал|разработал|реализовал|запускал|запустил)(?=$|[^\p{L}])|похожая\s+задача\s+была/iu.test(content)) {
    issues.push('Скажи прямо, что делал похожий проект: «делал похожее», «похожая задача была».');
  }
  if (!/https?:\/\//iu.test(content)) {
    issues.push('Дай ссылку на свой кейс из портфолио — без неё доказательства нет.');
  }
  // "Где могут быть затыки и косяки" — the one thing that proves the author has actually
  // built this before and is not guessing from the brief.
  const gotchaPattern = /(?:затык|подводн|грабл|косяк|нюанс|подвох|обычно\s+(?:лом|спотык|всплыва|упира)|чаще\s+всего\s+(?:лом|упира)|main\s+risk|споткн|упир[ае]|разъезж|рассыпа|отвалива|сюрприз|дублир|дубли|задво|повторн(?:ая|ой|ую)?\s+(?:достав|запис|отправ)|тонкое\s+место|узкое\s+место|сложност[ьи]\s+(?:будет|обычно|тут|здесь|в\b|во\b)|на\s+практике\s+(?:лом|упира|вылеза|всплыва)|вста(?:нет|[её]т|ла))/iu;
  if (!gotchaPattern.test(content)) {
    issues.push('Назови нюанс: где в такой задаче обычно сложность или косяк. Это и показывает, что ты её понимал.');
  }
  if (/(?:…|\.{3})/u.test(content)) {
    issues.push('В готовом отклике осталось многоточие-заглушка: замени его конкретным текстом.');
  }
  const numberedPlan = /(?:^|\s)1[.)]\s+[\s\S]{0,700}(?:^|\s)2[.)]\s+/mu.test(content);
  if (numberedPlan) issues.push('Убери нумерованный план: отклик короткий, план в нём не нужен.');
  // The owner's approved voice (2026-09-09) writes with dashes and colons like a live
  // letter: «упал — чиню в тот же день», «Первый: …».  Dashes, colons and a link wrapped
  // in parentheses are fine now; what still reads as typeset is «;» and «ёлочки».
  const withoutUrls = content.replace(/https?:\/\/[^\s)]+/giu, ' ссылка ');
  const fancyPunctuation = [
    ['точка с запятой', /;/u], ['кавычки-ёлочки', /[«»]/u], ['слеш', /(?<![\p{L}\p{N}])\/(?![\p{L}\p{N}])/u],
  ] as Array<[string, RegExp]>;
  // A link wrapped in parentheses is allowed: «(https://.../portfolio/8067050/)».
  const punctuationProbe = withoutUrls.replace(/\(\s*ссылка\s*\)/gu, ' ссылка ');
  const foundPunctuation = fancyPunctuation.filter(([, pattern]) => pattern.test(punctuationProbe)).map(([name]) => name);
  if (foundPunctuation.length) {
    issues.push(`Лишние знаки препинания: ${foundPunctuation.join(', ')}.`);
  }
  const contact = String(commercial.contactTelegram || '').trim();
  if (contact && !content.includes(contact)) {
    issues.push(`В конце оставь контакт для связи: ${contact}.`);
  }
  // The approved voice asks with a plain question or a plain nudge («напишите об этом
  // сразу»); the forced «… Верно?» diagnosis is gone, so only a ceiling remains.
  const questions = (content.match(/\?/g) || []).length;
  if (questions > 2) issues.push(`Вопросительных знаков больше двух, сейчас: ${questions}. Оставь максимум один-два живых вопроса.`);
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
    issues.push('Цена и срок звучат как строка таблицы. Скажи их обычной фразой, например «По деньгам выходит 250 000 рублей и 45 дней».');
  }
  if (Number(commercial.price) >= 10_000) {
    const rawPrice = String(Math.round(Number(commercial.price)));
    const ungroupedPrice = new RegExp(`(^|\\D)${rawPrice}(?=\\D|$)`, 'u');
    if (ungroupedPrice.test(content)) {
      issues.push(`Раздели разряды в сумме: ${Math.round(Number(commercial.price)).toLocaleString('ru-RU')} ₽, а не ${rawPrice} ₽.`);
    }
  }
  if (Number(commercial.days) > 0) {
    // The approved voice writes «дней 14» as often as «14 дней», so both orders count.
    const daysPattern = new RegExp(
      `(?:${Math.round(Number(commercial.days))}\\s*(?:рабоч(?:их|ие)?\\s*)?д(?:ень|ня|ней|\\.)|д(?:ень|ня|ней|\\.)\\s*\\u2116?\\s*${Math.round(Number(commercial.days))})`,
      'iu',
    );
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
  issues.push(...proposalEstimateIssues(content, commercial));
  issues.push(...proposalTechnologyIssues(content, commercial.technologyFit));
  return issues;
}

/**
 * The number comes out of a price catalogue, not out of a signed spec, and the owner was
 * getting замечания that it reads as a firm quote.  A price must always be offered as an
 * estimate; on a thin brief it must also say so out loud and invite a proper conversation.
 */
export function proposalEstimateIssues(content: string, commercial: ProposalCommercialContext = {}): string[] {
  if (!(Number(commercial.price) > 0)) return [];
  const issues: string[] = [];
  const hedge = /(?:примерно|ориентировочн|приблизительн|порядка|около|навскидк|в\s+районе|прикид|оцен[кио])/iu;
  if (!hedge.test(content)) {
    issues.push('Цена и срок звучат как готовая смета. Скажи, что это оценка: «примерно», «ориентировочно», «порядка».');
  }
  if (commercial.estimateMode === 'grounded') {
    const grounding = /(?:как\s+я\s+пон[ия]|из\s+того,?\s+что\s+опис|по\s+описанию\s+задачи|если\s+объ[ёе]м\s+так|исходя\s+из\s+(?:описан|задачи|того))/iu;
    if (!grounding.test(content)) {
      issues.push('Привяжи оценку к своему пониманию задачи: «исходя из того, как я понял задачу».');
    }
    return issues;
  }
  // rough
  const thinBrief = /(?:мало[^.!?]{0,25}(?:вводных|деталей|информации|данных|конкретики)|(?:вводных|деталей|информации|данных|конкретики)[^.!?]{0,25}мало|информации\s+немного|по\s+описанию\s+трудно|описание\s+короткое|деталей\s+в\s+заказе\s+немного)/iu;
  if (!thinBrief.test(content)) {
    issues.push('Вводных в заказе мало: скажи об этом прямо, иначе цифра выглядит выдуманной.');
  }
  const discuss = /(?:обсуд|уточн|разобра|посмотрю\s+(?:тз|техзадание|подробн)|детальнее|подробнее|когда\s+увижу)/iu;
  if (!discuss.test(content)) {
    issues.push('Предложи обсудить объём и уточнить цифры, раз информации не хватает.');
  }
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
  // Structure ethalon v14 (approved 2026-09-10 on the visa-bot draft): who I am with a
  // case first, the plan second, terms in one line, one non-obvious question, contact.
  'Структура эталона: приветствие → абзац «кто я»: «Шесть лет делаю …» под домен заказа и сразу похожий кейс было/стало с точной ссылкой → абзац «как сделаю»: 3–4 ключевых технических решения именно под этот заказ → условия одной-двумя строками → один вопрос → финальная строка с контактом.',
  'Длина 100–160 слов. Лаконичность и есть часть голоса: каждый абзац несёт один смысл, пустых фраз не оставлять. Писать больше только если заказчик прямо просит детали.',
  'После приветствия первый абзац — «кто я» со стажем и кейсом. Это не филлер, а доказательство. Филлер — пересказ ТЗ, «анализ главного риска» и любые слова о том, каким заказ виделся заказчику.',
  'Не начинать с пересказа ТЗ и наблюдений о заказе («по ТЗ главное», «главный риск для вас»). Заказчик своё ТЗ знает, открывая отклик он хочет понять, кто ты и что ты уже делал такого.',
  'Вопрос — ровно один, без анонсов: не «Уточню момент: …», а сразу вопрос с новой строки. Спрашивать только то, от чего зависит план работ или оценка: доступы, тестовые аккаунты, приоритет этапов. Очевидное для заказчика (его же решения, определённые на старте) не спрашивать. Конструкция «…, Верно?» запрещена.',
  'Запрещены подписи-ярлыки и связки-анонсы: «Стек.», «Сроки и стоимость.», «Кейсы в профиле.», «Скажу честно:», «Мой план такой:», «Приёмка простая:», «Уточню один момент:». Текст течёт обычными абзацами, без заголовков и списков.',
  'Условия — одной-двумя строками: ориентировочные цена и срок по commercial_terms, затем одна фраза про поддержку («Поддержка после сдачи — фиксом за месяц»). Не перечислять состав работ в цене, не обещать смету по модулям, договор и Безопасную сделку первым не поднимать.',
  'Финал: «Готов созвониться или перепишемся: @ник», ник из commercial_terms.contact_telegram дословно. Без «на пятнадцать минут» и без вариантов формулировки.',
  'Если называешь кейс из portfolio — сразу давай его ссылку из portfolio[].url. Не писать «могу показать» без ссылки: заказчик должен мочь открыть работу в один клик.',
  'Кейс упоминай по схеме «я делал → одна проверяемая деталь из portfolio.description → чем она совпадает с задачей клиента → точная ссылка». Нельзя дополнять карточку числами, которых нет в утверждённом списке ниже: там они есть, в карточке нет.',
  'МЕДСЕТЬ 24 (8057734): сеть из 24 филиалов, раньше администратор каждого филиала собирал отчёт по анализам вручную, на сеть уходило около 70 часов в месяц; после запуска отчёт собирается сам и уходит пациенту сразу после оплаты, повторные обращения выросли с 18 до 27 процентов.',
  'DEALER CATALOG (8067048): около 40 дилеров, раньше прайс рассылали Excel-файлами полдня и цены расходились с реальными в день отправки; теперь администратор обновляет цены за десять минут, дилер видит их сразу после входа, заявка на отгрузку идёт в CRM без почты.',
  'FLOW BRIDGE (8072067): раньше технические сбои теряли примерно каждый восьмой диалог, отвал замечали через неделю; после запуска отвал по технике упал до двух процентов, путь ученика от объявления до оплаты виден с датами, отвалы разбирают в тот же день.',
  'RECOVERY LOOP (8072073): около четырёх тысяч заявок в месяц, при сбоях интеграции терялось до семи процентов заявок; после запуска очередь доставляет все без потерь, сбой виден в Telegram за пять минут, а не на следующий день по письму клиента.',
  'TERRA MARKET (8057737): каталог на пять тысяч позиций, раньше остатки поставщиков велись в таблице и расходились с витриной раз в неделю, заказы брали то, чего нет; после запуска остатки в одной базе, витрина и заказы показывают одну цифру, заказ не берёт больше, чем есть на складе.',
  'Для кейсов вне этого списка готовых метрик нет: их придумывает владелец на этапе разбора, генератору числовые результаты выдумывать запрещено.',
  'У case_card есть поля client_context, task, solution_details, challenge, result, stack и stack_mismatch_note. Используй только заполненные факты; пустое поле не разрешает домысливать деталь.',
  'Ссылку брать только из portfolio[].url дословно. Никогда не выдумывать адрес и не ссылаться на кейс, которого нет в portfolio.',
  'Если заказ явно требует CMS или технологию, используй только доказательство из technology_fit. При risk=elevated не заявляй, что работал с технологией: соседний кейс доказывает только механику проекта, а не стек.',
  'Ритм должен быть неровным по смыслу: целевой бёрстинесс не ниже 0,60, жёсткий провал ниже 0,55. После фразы от 25 слов ставь короткую до 8 слов. Соседние предложения одинаковой длины и конструкции запрещены.',
  'Действия называй глаголами и от первого лица: «я соберу», «покажу», «проверю». Канцелярские цепочки из слов на «-ение/-ация/-ость» переписывай.',
  'Пиши конкретному человеку: минимум два естественных обращения «у вас/вам/ваш/вы». Это не повод пересказывать заказ фразой «вам нужно».',
  'Использовать минимум две уникальные детали задания и лексику клиента, но не перечислять уже написанные функции для вида.',
  'Техническая мысль допустима только когда объясняет пользу, риск, деньги или скорость. Управляемость (этапность, приёмка, обратимость) — одной строкой внутри плана, не отдельным блоком.',
  'В абзаце «как сделаю» назови и где задача обычно ломается: что будет самым тонким местом и что ты с этим делаешь. Это одна строка, показывающая, что задачу уже делал, а не читал в ТЗ.',
  'Не ругать постановку задачи, бюджет, конкурентов или выбранную технологию в первом сообщении.',
  'Не писать по обязательной формуле: структура и длина следуют эталону, а формулировки каждый раз живые, под заказ.',
  'Цена и срок обязательны в самом тексте, живой фразой вроде «Ориентировочно 600 000 ₽ и 90 дней, исходя из того, как я понял задачу», не таблицей. Суммы писать с разрядами.',
  'Запрещены «важно отметить», «ключевой момент», «в современных реалиях», «является», «осуществляет», выводы «таким образом/подводя итог», правило трёх и формальная честность «не служит подтверждением».',
  'Запрещено упоминать: Безопасную сделку, отзывы (у владельца их нет, любое упоминание врёт), «без подрядчиков» и «не агентство», дневные и часовые ставки, «Готов взяться», скидки и срочность «успейте».',
  'Старт называть только когда он подтверждён профилем продавца; при пустой настройке не выдумывать дату и не вставлять системную заглушку.',
  'Если подтверждёно имя из FL-профиля или чата, обратиться по имени. Не угадывать имя по логину.',
  'Интро под заказ: «Шесть лет делаю …» — называешь то, из чего состоит именно этот заказ. Магазин → «делаю интернет-магазины», заявки в CRM → «связываю сайты с CRM и мессенджерами», бот с мониторингом → «делаю телеграм-ботов и серверные движки». Ничего не выдумывать сверх реального стека и кейсов, но акцент смещать в домен заказа.',
  'Стек под заказ. Если проект новый или стек в брифе не указан: Nest на бэкенде, Next на фронте, база по задаче (обычно Postgres). Если это допил или интеграция: называешь стек заказчика из брифа и говоришь о нём уверенно. Node.js и React голыми как основную пару не называть.',
  'Если заказчик спрашивает про исходники или сервер: после сдачи исходники, схема БД и доступы остаются у заказчика.',
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

/**
 * These six were written against the bot-and-partner briefs of the time, so a video
 * pipeline brief matched on "telegram" and "анкета" and missed the one real video
 * case entirely.  The list now covers the mechanics the owner's portfolio actually
 * contains.
 */
const PORTFOLIO_CONCEPTS: Array<{ lead: RegExp; item: RegExp }> = [
  { lead: /(?:telegram|телеграм|max|макс|мессендж|бот)/iu, item: /(?:telegram|телеграм|max|макс|мессендж|бот|чат)/iu },
  { lead: /(?:партн[её]р|реферал|дилер|агентск)/iu, item: /(?:партн[её]р|реферал|дилер|франшиз|нетворкинг|участник)/iu },
  { lead: /(?:регистрац|анкет|фио|телефон|профил)/iu, item: /(?:регистрац|анкет|онбординг|профил|участник|личн.{0,8}кабинет)/iu },
  { lead: /(?:документ|файл|скриншот|свидетельств)/iu, item: /(?:документ|файл|фото|скриншот|ocr|акт|сч[её]т)/iu },
  { lead: /(?:qr|qr-код|ссылк|partner_id)/iu, item: /(?:qr|qr-код|ссылк|код|билет|идентификатор)/iu },
  { lead: /(?:уведомлен|менеджер|crm|амо|битрикс)/iu, item: /(?:уведомлен|менеджер|crm|амо|битрикс|диспетчер|оператор)/iu },
  { lead: /(?:видео|ролик|shorts|монтаж|субтитр|стрим|youtube|подкаст)/iu, item: /(?:видео|ролик|монтаж|субтитр|стрим|плеер|таймкод|ffmpeg|hls)/iu },
  { lead: /(?:нейросет|искусственн|llm|gpt|claude|распозна|транскриб)/iu, item: /(?:нейросет|llm|gpt|распозна|ocr|скрин[ие]р|rag|ии-)/iu },
  { lead: /(?:модерац|согласован|утвержд|ревью)/iu, item: /(?:модерац|согласован|утвержд|ревью|верси)/iu },
  { lead: /(?:оплат|плат[её]ж|эквайр|подписк|тариф)/iu, item: /(?:оплат|плат[её]ж|эквайр|подписк|тариф|биллинг)/iu },
  { lead: /(?:расписан|бронир|слот|календар)/iu, item: /(?:расписан|бронир|слот|календар)/iu },
  { lead: /(?:склад|остатк|каталог|номенклатур|поставщик)/iu, item: /(?:склад|остатк|каталог|номенклатур|поставщик|wms|маркетплейс)/iu },
  { lead: /(?:карт[аыу]|геолокац|маршрут|трекер)/iu, item: /(?:карт[аеы]|геолокац|маршрут|трекер|логист)/iu },
  { lead: /(?:отч[её]т|аналитик|дашборд|метрик|прогноз)/iu, item: /(?:отч[её]т|аналитик|дашборд|метрик|прогноз)/iu },
  { lead: /(?:интеграц|синхрониз|выгрузк|вебхук)/iu, item: /(?:интеграц|синхрониз|выгрузк|вебхук)/iu },
];

/**
 * The AI broker refuses any task whose context does not fit its input window, and it
 * decides that *after* the owner has already waited minutes in the queue.  These two
 * helpers move that decision here, where a payload can be shrunk in a quality-aware
 * order instead of failing outright.
 */
const BROKER_INPUT_BUDGET = 30_000;
const BROKER_STRING_LIMITS = [8_000, 4_000, 2_000, 1_000, 500, 200];

/** Mirrors the broker's own compaction so the estimate matches what it will measure. */
export function estimateBrokerContext(payload: unknown): number {
  const compact = (value: unknown, stringLimit: number, depth = 0): unknown => {
    if (depth >= 10) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => compact(item, stringLimit, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => [key.slice(0, 160), compact(item, stringLimit, depth + 1)]));
    }
    if (typeof value === 'string') return value.length <= stringLimit ? value : `${value.slice(0, stringLimit)}\n[truncated by broker]`;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    return String(value).slice(0, stringLimit);
  };
  let smallest = Number.POSITIVE_INFINITY;
  for (const limit of BROKER_STRING_LIMITS) {
    const size = JSON.stringify(compact(payload, limit))?.length ?? 0;
    if (size < smallest) smallest = size;
    if (size <= BROKER_INPUT_BUDGET) return size;
  }
  return smallest;
}

/**
 * Applies the given reductions one at a time, stopping as soon as the payload fits.
 * A payload that already fits is returned untouched, so nothing changes for the
 * requests that were working.
 */
export function fitAiPayload<T extends Record<string, unknown>>(
  payload: T,
  reductions: Array<{ label: string; apply: (value: T) => T }>,
): { payload: T; applied: string[]; size: number; fits: boolean } {
  let current = payload;
  const applied: string[] = [];
  let size = estimateBrokerContext(current);
  for (const reduction of reductions) {
    if (size <= BROKER_INPUT_BUDGET) break;
    current = reduction.apply(current);
    applied.push(reduction.label);
    size = estimateBrokerContext(current);
  }
  return { payload: current, applied, size, fits: size <= BROKER_INPUT_BUDGET };
}

const trimList = (value: unknown, keep: number) => (Array.isArray(value) ? value.slice(0, keep) : value);

/**
 * Least valuable first.  The reviewer picks and polishes one of the candidates it is
 * given, so style corpora and old drafts can go long before the lead itself does.
 */
export function proposalReviewReductions<T extends Record<string, unknown>>(): Array<{ label: string; apply: (value: T) => T }> {
  return [
    { label: 'calibration_examples', apply: (value) => ({ ...value, calibration_examples: trimList(value.calibration_examples, 1) }) },
    { label: 'voice_examples', apply: (value) => ({ ...value, voice_examples: trimList(value.voice_examples, 1), approved_examples: trimList(value.approved_examples, 1) }) },
    { label: 'recent_drafts', apply: (value) => ({ ...value, recent_drafts: trimList(value.recent_drafts, 1) }) },
    { label: 'response_principles', apply: (value) => ({ ...value, response_principles: trimList(value.response_principles, 12) }) },
    {
      label: 'portfolio',
      apply: (value) => ({
        ...value,
        portfolio: Array.isArray(value.portfolio)
          ? value.portfolio.slice(0, 3).map((item) => {
            const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
            return { title: row.title, description: String(row.description || '').slice(0, 400), url: row.url, case_card: row.case_card };
          })
          : value.portfolio,
      }),
    },
    {
      label: 'messages',
      apply: (value) => {
        const context = (value.context && typeof value.context === 'object' ? value.context : {}) as Record<string, unknown>;
        return { ...value, context: { ...context, messages: trimList(context.messages, 6) } };
      },
    },
    { label: 'style', apply: (value) => ({ ...value, style: trimList(value.style, 8) }) },
    {
      label: 'lead_description',
      apply: (value) => {
        const context = (value.context && typeof value.context === 'object' ? value.context : {}) as Record<string, unknown>;
        const lead = (context.lead && typeof context.lead === 'object' ? context.lead : {}) as Record<string, unknown>;
        return {
          ...value,
          context: { ...context, lead: { ...lead, description: String(lead.description || '').slice(0, 2_500) } },
        };
      },
    },
    { label: 'candidate_diagnostics', apply: (value) => ({ ...value, candidate_diagnostics: trimList(value.candidate_diagnostics, 2) }) },
  ];
}

/**
 * "TERRA MARKET - маркетплейс фермерских продуктов" → "маркетплейс фермерских продуктов".
 * The owner asked for the shortest possible sentence saying what the project was, and the
 * title already carries it after the brand name.
 */
export function caseOneLiner(row: Record<string, unknown>): string {
  const title = String(row.title || '').trim();
  const tail = title.split(/\s+[-—–]\s+/u).slice(1).join(' — ').trim();
  if (tail.length >= 8) return tail.slice(0, 160);
  const sentence = String(row.description || '').split(/(?<=[.!?])\s+/u)[0] || '';
  return (tail || sentence).slice(0, 160);
}

/**
 * Pulls quotable, concrete lines out of the owner's own portfolio text so the proof
 * paragraph can name a real mechanic instead of a generic one.
 */
export function caseConcreteDetails(row: Record<string, unknown>): string[] {
  const source = `${row.solution_details || ''} ${row.challenge || ''} ${row.result || ''}`.trim()
    || String(row.description || row.task || '');
  const concrete = /\d|фильтр|роли|статус|интеграц|расч[ёе]т|уведомл|оплат|остатк|каталог|корзин|карточк|кабинет|админк|синхрон|поиск|бронир|отчёт|экспорт|импорт|карт[аеу]|очеред|модер|рейтинг|чат|push|API|SLA/iu;
  return String(source)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 240 && concrete.test(sentence))
    .slice(0, 4);
}

/**
 * The catalogue always returns a precise number, so the letter used to quote 750 000 ₽ off
 * a 266-character brief as if it were a estimate from a real spec.  This decides how much
 * the number is actually worth: with a thin brief it must be presented as a ballpark and
 * the letter must say the details still need to be talked through.
 */
export function proposalEstimateContext(
  lead: Record<string, unknown>,
  analysis: Record<string, unknown> = {},
): { mode: ProposalEstimateMode; reason: string; descriptionChars: number; confidence: number } {
  const description = String(lead.description || '').trim();
  const attachments = (lead.requirements as Record<string, any>)?.project?.attachments;
  const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
  const confidence = Math.round(Number(analysis.confidence ?? lead.confidence ?? 0)) || 0;
  const chars = description.length + attachmentCount * 400;
  if (chars >= 400 && confidence >= 65) {
    return {
      mode: 'grounded',
      reason: 'Описание достаточно подробное, чтобы прикинуть объём по нему.',
      descriptionChars: description.length,
      confidence,
    };
  }
  const reason = chars < 150
    ? 'В заказе почти нет вводных, назвать можно только очень грубый порядок цифр.'
    : confidence < 65
      ? 'Описание оставляет слишком много открытых вопросов для точной оценки.'
      : 'Описание короткое, объём работ по нему точно не считается.';
  return { mode: 'rough', reason, descriptionChars: description.length, confidence };
}

const PORTFOLIO_STOP_WORDS = new Set([
  'который', 'нужно', 'сайт', 'сайта', 'сайте', 'разработка', 'сделать', 'работа',
  'проект', 'через', 'будет', 'можно', 'также', 'данные', 'система', 'должен',
  // Words that sit in almost every card and in almost every brief, so a match on
  // them says nothing about whether the case actually fits.
  'сервис', 'создание', 'создать', 'нужен', 'нужна', 'есть', 'этом', 'этот',
  'чтобы', 'после', 'более', 'такие', 'такой', 'было', 'быть', 'может', 'сразу',
]);

/** Wide enough that the right case is almost never ranked out before the model reads it. */
export const PORTFOLIO_SHORTLIST = 40;
/** Full cards are expensive in the prompt; the picker decides which ones earn a slot. */
export const PORTFOLIO_IN_PROMPT = 5;

function portfolioTokens(text: string): Set<string> {
  return new Set(
    String(text).toLowerCase().match(/[а-яёa-z0-9]{4,}/g)?.filter((word) => !PORTFOLIO_STOP_WORDS.has(word)) || [],
  );
}

/**
 * Counting shared words made every long card win: "ГОРОД.ONLINE" matched a video
 * brief on "создание" and "обработка" while the one real video case lost.  Rare
 * words carry the signal, so each match is weighted by how unusual it is across
 * the portfolio, and only the strongest few matches count — otherwise a card wins
 * by sheer description length instead of by fit.
 */
export function selectRelevantPortfolio(
  value: unknown,
  leadText: string,
  limit = 6,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const rows = value.map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : {}));
  const caseTokens = rows.map((row) => portfolioTokens(`${row.title || ''} ${row.description || ''}`));
  const titleTokens = rows.map((row) => portfolioTokens(String(row.title || '')));
  const documentFrequency = new Map<string, number>();
  for (const set of caseTokens) for (const word of set) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  const total = Math.max(1, rows.length);
  const weightOf = (word: string) => Math.log(1 + total / (1 + (documentFrequency.get(word) || 0)));
  const averageSize = caseTokens.reduce((sum, set) => sum + set.size, 0) / total || 1;
  // The brief's own title names the job; a word from it is worth more than one
  // buried in the twelfth paragraph.
  const headline = portfolioTokens(String(leadText).split(/\n/u)[0] || '');
  const leadTokens = portfolioTokens(leadText);
  const STRONGEST_MATCHES = 6;
  return rows
    .map((row, index) => {
      const itemText = `${row.title || ''} ${row.description || ''}`;
      const matches: number[] = [];
      for (const word of leadTokens) {
        if (!caseTokens[index].has(word)) continue;
        let weight = weightOf(word);
        if (headline.has(word)) weight *= 1.8;
        if (titleTokens[index].has(word)) weight *= 1.4;
        matches.push(weight);
      }
      matches.sort((left, right) => right - left);
      let score = matches.slice(0, STRONGEST_MATCHES).reduce((sum, weight) => sum + weight, 0);
      score /= 0.4 + 0.6 * (caseTokens[index].size / averageSize);
      let concepts = 0;
      for (const concept of PORTFOLIO_CONCEPTS) {
        if (concept.lead.test(leadText) && concept.item.test(itemText)) concepts += 1;
      }
      score += Math.min(concepts, 2) * 0.8;
      return { index, score: Number(score.toFixed(2)), row };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter(({ score }) => score > 0)
    .slice(0, Math.max(1, limit))
    .map(({ row, score }) => ({
      title: String(row.title || '').slice(0, 180),
      description: String(row.description || '').slice(0, 900),
      url: String(row.url || '').slice(0, 500),
      // The owner's 87 cases carry only title, description and url; every structured
      // field is empty. Without ready-to-quote concrete lines the model falls back to
      // "спроектировал структуру базы данных" — true, but worthless as proof.
      what_it_is: caseOneLiner(row),
      concrete_details: caseConcreteDetails(row),
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

/**
 * The exact shape the owner dictated: greeting, "готов взяться, опыт есть", the similar
 * project with its link, the gotchas, then the price offered as an estimate rather than a
 * quote, one question and his Telegram.  Plain punctuation only.  The first two examples
 * show the two estimate modes, because a number pulled off a two-line brief has to admit
 * what it is.
 */
const RESPONSE_CALIBRATION = [
  {
    // Ethalon v14, approved 2026-09-10. Numbers in examples are shape only: the real
    // letter must take price, days and telegram from commercial_terms of that lead.
    kind: 'Эталон v14: кто я с кейсом, как сделаю, условия строкой, один вопрос, контакт. 100–160 слов',
    example: 'Добрый день!\n\nШесть лет делаю телеграм-ботов и серверные движки на Python: aiogram, Playwright, PostgreSQL, Docker. Похожая задача была — отказоустойчивый слой интеграций для сервиса на GetCourse: при сбоях терялось до семи процентов из четырёх тысяч заявок в месяц, после запуска очередь доставляет всё без потерь, а сбой виден в Telegram за пять минут. https://www.fl.ru/user/sporyshevsaveli/portfolio/8072073/\n\nПредлагаю так. Telegram-бот с личным кабинетом и мониторингом — как первый этап, чтобы вы увидели работающую систему у себя. Дальше адаптеры под ваши сайты: селекторы выношу в конфиги, правка при смене вёрстки занимает минуты, сессии с шифрованием токенов, прокси с авторотацией. Если интеграция встала — задачи поднимаются сами, алерт прилетает мне в Telegram. Финал — нагрузочный прогон и документация.\n\nОриентировочно 600 000 ₽ и 90 дней, исходя из того, как я понял задачу. Поддержка после сдачи — фиксом за месяц.\n\nЕсть ли у вас тестовые аккаунты в этих кабинетах? От этого зависит, на чём гонять приёмку.\n\nГотов созвониться или перепишемся: @saveliissdd',
    why: 'Эталон утверждён владельцем. Первый абзац доказывает опытом, второй снимает главный риск заказа, условия не раздуты, вопрос один и неочевидный.',
  },
  {
    kind: 'Мало вводных: цена как ориентир, вопрос про объём',
    example: 'Добрый день!\n\nШесть лет делаю интернет-магазины: каталог, корзина, оплата, интеграции доставки. Похожее делал в TERRA MARKET: каталог на пять тысяч позиций, раньше остатки поставщиков расходились с витриной раз в неделю, теперь витрина и заказы показывают одну цифру. https://www.fl.ru/user/sporyshevsaveli/portfolio/8057737/\n\nВ вашем заказе вводных пока мало, поэтому скажу порядок: базовый магазин выйдет в районе 255 000 ₽ и 40 дней, точнее посчитаю, как увижу список страниц и способы оплаты. Собирать буду на WordPress, минимум платных плагинов, чтобы вы сами правили контент без разработчика. Обычно узкое место здесь оплата и доставка: карточка тарифов у вас своя, поэтому уточню ниже.\n\nПоддержка после сдачи — фиксом за месяц.\n\nСколько товаров будет в каталоге и нужна ли онлайн-оплата?\n\nГотов созвониться или перепишемся: @saveliissdd',
    why: 'При малых вводных цифра как ориентир и обещание пересчитать, состав работ не перечисляется, вопрос двигает к смете.',
  },
  {
    kind: 'Интеграция в чужой стек: уверенное владение, цена потери',
    example: 'Добрый день!\n\nШесть лет связываю сайты с CRM и мессенджерами: WordPress, amoCRM, Telegram. Похожая задача была в DEALER CATALOG: сорок дилеров получали прайс Excel-рассылкой и работали с устаревшими ценами, теперь обновление занимает десять минут, заявка идёт в CRM без почты. https://www.fl.ru/user/sporyshevsaveli/portfolio/8067048/\n\nС вашим WordPress работаю уверенно, ничего без нужды не переписываю. Формы сохраню в базу до страницы благодарности, доставка заявок через очередь с повторами — это как раз то место, где интеграция обычно встаёт. Если форма отвалится, заявка не потеряется, а зайдёт при восстановлении, вы увидите это в журнале.\n\nОриентировочно 125 000 ₽ и 20 дней, исходя из того, как я понял задачу. Поддержка после сдачи — фиксом за месяц.\n\nСколько у вас форм покрыть, и на поддоменах один обработчик или свой у каждого?\n\nГотов созвониться или перепишемся: @saveliissdd',
    why: 'Стек заказчика назван с уверенностью, риск повторной отправки назван и закрыт механикой, вопрос один с развилкой.',
  },
];

// Prompts live in ./prompts (mounted into the container) so the owner can edit the
// wording without a rebuild. Built-in constants stay as the fallback: a missing or
// unparsable file changes nothing.
const PROMPTS_DIR = process.env.PROMPTS_DIR || '/app/prompts';
const promptFileCache = new Map<string, { mtimeMs: number; value: string }>();

function readPromptFile(relPath: string): string | null {
  try {
    const fullPath = `${PROMPTS_DIR}/${relPath}`;
    const stat = statSync(fullPath);
    const cached = promptFileCache.get(fullPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const value = readFileSync(fullPath, 'utf8');
    promptFileCache.set(fullPath, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

const promptSources = new Map<string, string>();

function loadProposalRules(): string[] {
  const raw = readPromptFile('response_principles.md');
  if (!raw) return RESPONSE_PRINCIPLES;
  const rules = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/\\n/g, '\n'));
  return rules.length >= 3 ? rules : RESPONSE_PRINCIPLES;
}

function loadResponseCalibration(): Array<{ kind: string; example: string; why: string }> {
  const raw = readPromptFile('response_calibration.md');
  if (!raw) return RESPONSE_CALIBRATION;
  const examples: Array<{ kind: string; example: string; why: string }> = [];
  for (const block of raw.split(/^## /m).slice(1)) {
    const lines = block.split('\n');
    const kind = (lines.shift() || '').trim();
    let example = '';
    let why = '';
    let mode: 'example' | 'why' | null = null;
    for (const line of lines) {
      const text = line.trim();
      if (/^Пример:$/.test(text)) { mode = 'example'; continue; }
      if (/^Почему:/.test(text)) { why = text.replace(/^Почему:\s*/, ''); mode = 'why'; continue; }
      if (mode === 'example') example += (example ? '\n' : '') + text;
    }
    if (kind && example) examples.push({ kind, example: example.replace(/\\n/g, '\n'), why: why.replace(/\\n/g, '\n') });
  }
  return examples.length ? examples : RESPONSE_CALIBRATION;
}

function promptSourceNote(name: string, fromFile: boolean): void {
  if (promptSources.get(name) === (fromFile ? 'file' : 'builtin')) return;
  promptSources.set(name, fromFile ? 'file' : 'builtin');
  new Logger('Prompts').log(`${name}: ${fromFile ? 'читаю из prompts/' : 'файл нет, использую встроенный текст'}`);
}

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
  private readonly logger = new Logger(AiService.name);

  /**
   * The broker rejects an oversized context outright, and the owner only learns that
   * after the whole queue wait.  Shrinking the least valuable parts here keeps the
   * draft coming instead: a payload that already fits is passed through unchanged.
   */
  private fitForBroker<T extends Record<string, unknown>>(kind: string, payload: T): T {
    const fitted = fitAiPayload(payload, proposalReviewReductions<T>());
    if (fitted.applied.length) {
      this.logger.log(`${kind}: контекст ужат до ${fitted.size} знаков (${fitted.applied.join(', ')})`);
    }
    if (!fitted.fits) {
      this.logger.warn(`${kind}: контекст ${fitted.size} знаков всё ещё выше бюджета брокера`);
    }
    return fitted.payload;
  }

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
    const dailyRate = Number((seller as Record<string, unknown>).daily_rate_rub) || DEFAULT_DAILY_RATE_RUB;
    return this.calibrateAnalysis(lead, result, result.understanding, dailyRate);
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
    // The picker can legitimately choose a case the word ranking put 12th, so the
    // review has to look at the same shortlist or it reports "кейс не использован".
    const portfolio = selectRelevantPortfolio(
      portfolioValue,
      `${lead.title || ''}\n${lead.description || ''}`,
      PORTFOLIO_SHORTLIST,
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

  // OpenRouter occasionally answers with prose instead of the JSON envelope
  // (BrokerError). One short retry turns that flake into a delay instead of a
  // permanently failed draft.
  private async runComposeWithRetry(task: string, payload: Record<string, unknown>): Promise<DraftCompose> {
    try {
      return await this.tasks.run<DraftCompose>(task, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/BrokerError|did not return a JSON/i.test(message)) throw error;
      this.logger.warn(`Broker flake on ${task} (${message}); retrying once in 15s`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return await this.tasks.run<DraftCompose>(task, payload);
    }
  }

  private proposalRules(): string[] {
    const rules = loadProposalRules();
    promptSourceNote('response_principles', rules !== RESPONSE_PRINCIPLES);
    return rules;
  }

  private responseCalibration(): Array<{ kind: string; example: string; why: string }> {
    const examples = loadResponseCalibration();
    promptSourceNote('response_calibration', examples !== RESPONSE_CALIBRATION);
    return examples;
  }

  async draftReply(context: Record<string, unknown>): Promise<string> {
    const seller = (await this.settings.getPublic('seller_profile') || {}) as Record<string, unknown>;
    const allPortfolio = await this.settings.getPublic('fl_portfolio_cases') || [];
    const sourceLead = (context.lead || {}) as Record<string, unknown>;
    const leadText = String(sourceLead.title || '') + '\n' + String(sourceLead.description || '');
    const mode = context.mode === 'chat' ? 'chat' : 'response';
    // One deterministic shortlist; the model picks the case itself under proposal_rules.
    const portfolio = selectRelevantPortfolio(allPortfolio, leadText, PORTFOLIO_IN_PROMPT);
    // Anti-repeat compares against OTHER leads only: regenerating a draft for the
    // same lead would otherwise collide with its own earlier version.
    const recentDraftResult = await this.db.query<{ content: string }>(
      `SELECT content FROM drafts
       WHERE (kind='initial_response' OR metadata->>'mode'='response')
         AND status IN ('pending','approved','sent')
         AND lead_id <> $1
       ORDER BY created_at DESC LIMIT 8`,
      [String(sourceLead.id || '')],
    );
    const recentDrafts = recentDraftResult.rows.map((row) => row.content);
    const client = sourceLead.client && typeof sourceLead.client === 'object'
      ? sourceLead.client as Record<string, unknown>
      : {};
    const clientName = String(client.fl_name || client.name || '').trim().slice(0, 80);
    const leadAnalysis = (sourceLead.analysis && typeof sourceLead.analysis === 'object'
      ? sourceLead.analysis
      : {}) as Record<string, unknown>;
    const estimate = proposalEstimateContext(sourceLead, leadAnalysis);
    const priceOverride = Math.max(0, Math.round(Number(context.priceOverride) || 0));
    // Fast pre-pass: a structured read of the order (price kind, the client's own
    // questions, engagement type, traps) so the draft reacts to what is actually
    // written.  Purely additive: on any failure the draft runs exactly as before.
    const orderPassport = mode === 'response'
      ? await this.buildOrderPassport(sourceLead)
      : null;
    const configuredAvailability = String(seller.available_from || seller.availability || '').trim().slice(0, 160);
    const contactTelegram = String(seller.contact_telegram || '').trim() || undefined;
    const commercialTerms: ProposalCommercialContext = {
      price: priceOverride || Number(sourceLead.recommended_price) || undefined,
      days: Number(sourceLead.recommended_days) || undefined,
      availability: configuredAvailability ? 'Старт: ' + configuredAvailability : undefined,
      availabilityConfigured: Boolean(configuredAvailability),
      contactTelegram,
      estimateMode: estimate.mode,
    };
    const payload = {
      seller,
      mode,
      portfolio,
      // The ethalon: owner's structure, tone, bans and approved case metrics.
      proposal_rules: this.proposalRules(),
      calibration_examples: this.responseCalibration(),
      commercial_terms: {
        price_rub: commercialTerms.price ?? null,
        duration_days: commercialTerms.days ?? null,
        estimate_mode: estimate.mode,
        estimate_rule: estimate.mode === 'grounded'
          ? 'Цену и срок называй как ориентировочную оценку, а не готовую смету: обязательно скажи, что цифра примерная и исходит из твоего понимания задачи. Например: «Ориентировочно 250 000 ₽ и 45 дней, объём я понял из вашего текста». Оборот «по описанию» не используй.'
          : 'Информации в заказе мало (' + estimate.reason + '). Назови только грубый порядок цифр и прямо скажи, что вводных мало, поэтому это очень приблизительно, а точные цену и срок посчитаешь, когда разберётесь в деталях. Например: «Навскидку это порядка 250 000 рублей и около 45 дней, но вводных пока мало, так что цифра очень примерная. Посмотрю задачу подробнее и посчитаю точнее».',
        fixed_budget_rule: priceOverride
          ? 'У заказа фиксированный бюджет ровно ' + priceWithSpaces(priceOverride) + ' ₽. В тексте называй цену ровно ' + priceWithSpaces(priceOverride) + ' ₽ — не ниже, не выше и без диапазона.'
          : null,
        availability: configuredAvailability ? 'Старт: ' + configuredAvailability : null,
        availability_configured: Boolean(configuredAvailability),
        client_name: clientName || null,
        contact_telegram: contactTelegram || null,
        contact_rule: contactTelegram
          ? 'Финальная строка дословно: «Готов созвониться или перепишемся: ' + contactTelegram + '». Ник пиши дословно.'
          : 'Контакт для связи не настроен: не выдумывай ник и не зови в мессенджеры.',
      },
      lead: {
        title: sourceLead.title,
        description: String(sourceLead.description || '').slice(0, 12_000),
        budget_text: sourceLead.budget_text,
        score: sourceLead.score,
        recommended_price: sourceLead.recommended_price,
        recommended_days: sourceLead.recommended_days,
        analysis: sourceLead.analysis,
        requirements: sourceLead.requirements,
        client: { name: clientName || null, username: client.fl_username || null },
      },
      order_passport: orderPassport,
      messages: (Array.isArray(context.messages) ? context.messages : []).slice(-50).map((message: Record<string, unknown>) => ({
        direction: message.direction,
        author: message.author,
        content: String(message.content || '').slice(0, 4_000),
      })),
      recent_drafts: recentDrafts.slice(0, 5).map((row) => row.slice(0, 560)),
      owner_instructions: String(context.ownerInstructions || '').slice(0, 4_000),
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

    // Gate removed (owner decision): one compose, ship as-is.  The deterministic
    // review still runs at draft creation and records warnings in metadata, and
    // nothing is auto-sent without the owner.
    const composePayload: Record<string, unknown> = this.fitForBroker('draft_compose', payload);
    const attempt = await this.runComposeWithRetry('draft_compose', composePayload);
    const content = normalizeProposalFormatting(String(attempt.content || ''), commercialTerms);
    if (priceOverride >= 10_000) {
      const mismatched = proposalNamedPrices(content).filter((named) => named !== priceOverride);
      if (mismatched.length) {
        this.logger.warn(`draft_compose price mismatch: ${mismatched.join(', ')} vs ${priceOverride}`);
      }
    }
    return content.charAt(0).toUpperCase() + content.slice(1);
  }

  private async buildOrderPassport(_lead: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    // Disabled (owner, 2026-09-09): the passport pre-pass stalled drafts for minutes.
    // Compose starts immediately, like before the pre-pass existed.
    return null;
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
    const found = PROPOSAL_CLICHES.filter((phrase) => lower.includes(phrase));
    if (found.length) {
      // GigRadar measured reply rate against cliché count over 133 872 proposals:
      // 0 → 7.55%, 1 → 6.84%, 3+ → 4.17%, 4+ → 0.00%. They do not just dilute, they nullify.
      issues.push(found.length >= 3
        ? `Штампов ${found.length} — на таком количестве отклик перестаёт получать ответы. Убери каждый: ${found.join(', ')}`
        : `Шаблонные или AI-фразы: ${found.join(', ')}`);
    }
    if (/(?:^|[^\p{L}])(?:лучше|стоит)(?=$|[^\p{L}])[^.!?]{0,160}(?:^|[^\p{L}])иначе(?=$|[^\p{L}])/imu.test(content)) {
      issues.push('Получилась заезженная формула «лучше сделать X, иначе Y»: перепиши как нормальное личное сообщение, без мини-лекции.');
    }
    if (/^(?:[^.!?\n]{0,80})(?:лучше|стоит|нужно)[^.!?\n]{0,100}(?:провер|фиксац|уточн)/iu.test(content.trim())) {
      issues.push('Не повторяй шаблонный заход «X стоит делать после проверки Y»: используй назначенный вариант хука.');
    }
    const similarity = Math.max(0, ...recentDrafts.map((draft) => this.textSimilarity(content, draft)));
    if (similarity >= 0.55) issues.push('Текст слишком похож на один из недавних откликов: поменяй тип захода, длину, синтаксис и доказательство.');
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

  private calibrateAnalysis(
    lead: Record<string, unknown>,
    result: ModelLeadAnalysis,
    understanding: LeadUnderstanding,
    dailyRate = DEFAULT_DAILY_RATE_RUB,
  ): LeadAnalysis {
    const rawPrice = Math.max(0, Math.round(Number(result.recommended_price) || 0));
    const rawDays = Math.max(1, Math.round(Number(result.recommended_days) || 1));
    const selfContainedIntegrationCategories: PricingCategory[] = [
      'automation_or_bot',
      'parsing_scraping',
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
    // Price the actual list of work when the analyzer produced one, and keep the
    // catalogue as the sanity check rather than as the answer.
    const bottomUp = calculateBottomUpPrice(result.work_breakdown, dailyRate);
    const estimate = reconcileEstimate(bottomUp, catalog);
    // The cheap path is only worth offering when it is genuinely cheaper; a "lean"
    // option that costs 80% of the full build just makes the letter longer.
    const leanRaw = calculateBottomUpPrice(result.lean_breakdown, dailyRate);
    const lean = leanRaw && leanRaw.price < estimate.price * 0.7 ? leanRaw : null;
    const price = estimate.price || rawPrice;
    const days = estimate.days || rawDays;
    const technicalFit = this.clampScore(result.technical_fit);
    let commercialFit = this.clampScore(result.commercial_fit);
    const briefQuality = this.clampScore(result.brief_quality);
    const deliveryRisk = this.clampScore(result.delivery_risk);
    const explicitBudget = this.extractExplicitBudget(lead.budget_text);
    const severeBudgetMismatch = explicitBudget !== null && price > explicitBudget * 2.5;
    if (severeBudgetMismatch) commercialFit = Math.min(commercialFit, 30);
    // An order that cannot pay for itself is not a fit, however well it matches
    // the stack: a favicon and a 245 000 ₽ site used to score the same.
    const minDealPrice = Math.max(0, Number(process.env.MIN_DEAL_PRICE_RUB || DEFAULT_MIN_DEAL_PRICE_RUB));
    const belowMinDeal = price < minDealPrice || (explicitBudget !== null && explicitBudget < minDealPrice);
    const dealValue = dealValueScore(price);
    let score = Math.round(
      technicalFit * 0.45
      + commercialFit * 0.18
      + briefQuality * 0.07
      + (100 - deliveryRisk) * 0.1
      + dealValue * 0.2,
    );
    if (understanding.buyer_intent === 'irrelevant') score = Math.min(score, 25);
    if (understanding.buyer_intent === 'unrealistic') score = Math.min(score, 45);
    if (understanding.buyer_intent === 'contradictory') score = Math.min(score, 60);
    if (belowMinDeal) score = Math.min(score, 45);
    const blockedIntent = ['irrelevant', 'unrealistic'].includes(understanding.buyer_intent);
    const shouldRespond = Boolean(
      result.should_respond
      && !blockedIntent
      && !severeBudgetMismatch
      && !belowMinDeal
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
      deal_value: dealValue,
      should_respond: shouldRespond,
      recommended_price: price,
      recommended_days: days,
      size_grade: sizeGrade(price),
      underpriced: severeBudgetMismatch
        ? { named_budget: Number(explicitBudget), fair_price: price, ratio: underpricingRatio(price, Number(explicitBudget)) ?? 0 }
        : null,
      ltv_stage_signal: (result as { project_staging?: boolean }).project_staging === true,
      pricing_category: catalog?.category ?? result.pricing_category,
      pricing_level: catalog?.level ?? result.pricing_level,
      pricing_modifiers: catalog?.modifiers ?? result.pricing_modifiers,
      understanding,
      work_breakdown: Array.isArray(result.work_breakdown)
        ? result.work_breakdown.slice(0, 14) as Array<Record<string, unknown>>
        : undefined,
      price_range: bottomUp
        ? [bottomUp.priceLow, bottomUp.priceHigh]
        : undefined,
      days_range: bottomUp
        ? [bottomUp.daysLow, bottomUp.daysHigh]
        : undefined,
      estimate_source: estimate.source,
      lean_price: lean?.price,
      lean_days: lean?.days,
      lean_tradeoff: lean ? String(result.lean_tradeoff || '').slice(0, 240) : undefined,
      client_value: catalog
        ? `Категория: ${catalog.label}, уровень ${catalog.level}${modifierText}. Рыночная цена ${price.toLocaleString('ru-RU')} ₽, срок ${days} дней${
          bottomUp
            ? `, вилка по разбору работ ${bottomUp.priceLow.toLocaleString('ru-RU')}–${bottomUp.priceHigh.toLocaleString('ru-RU')} ₽${estimate.gap && estimate.gap >= 1.5 ? `, смета расходилась с рынком в ${estimate.gap} раза, проверь категорию и уровень` : ''}`
            : ''
        }. Допущение: ${assumption}`
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
