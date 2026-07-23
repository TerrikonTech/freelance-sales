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
  response_greeting: ['Добрый день.', 'Здравствуйте.'],
  response_sentences: '2–5 простых предложений',
  response_length: '90–440 знаков; длина и структура зависят от самого заказа',
  punctuation: 'Обычные точки и запятые; без типографских кавычек, длинных тире, точек с запятой и слишком идеальной литературной пунктуации',
  tone: 'Спокойное личное сообщение сильного разработчика. Без позы консультанта, рекламного пафоса и попытки доказать ум каждой фразой',
  rules: [
    'За первые две строки дать заказчику причину открыть диалог: точное попадание в результат, близкое доказательство или полезную ясность.',
    'Не выдавливать технический инсайт из каждого заказа. Для простого или короткого брифа лучше прямой человеческий отклик.',
    'Цена и срок уже заполняются отдельными полями FL.ru, поэтому в тексте их повторять только если нужно объяснить границу или заметное расхождение с ожиданиями.',
    'Доказательство, вопрос и цена не обязательны одновременно. Оставлять только то, что реально усиливает именно этот отклик.',
    'Менять не только слова, но сам ход сообщения: кейс, точное решение, важное решение по реализации, вопрос с порога или короткий следующий шаг.',
  ],
};

const RESPONSE_PRINCIPLES = [
  'Цель первого отклика — получить осмысленный ответ, а не уместить в него консультацию, смету и резюме.',
  'Показывать понимание конкретной деталью или результатом, но не повторять бриф другими словами.',
  'Техническая мысль допустима только когда она важна заказчику сейчас и объяснена через пользу, риск, деньги или скорость.',
  'Доверие строить самым сильным уместным сигналом: близкий реальный кейс, точное решение, разумный первый шаг, 6 лет опыта или Яндекс. Не вставлять стаж как заполнитель.',
  'Завершать лёгким действием: один вопрос, просьба прислать материал либо предложение показать близкий кейс. Не превращать каждый отклик в анкету.',
  'Не ругать постановку задачи, бюджет, конкурентов или выбранную технологию в первом сообщении.',
  'Не писать по обязательной формуле: структура и длина должны следовать брифу и выбранному углу.',
];

const RESPONSE_CALIBRATION = [
  {
    kind: 'Сложная интеграция с неясной существующей основой',
    example: 'Добрый день. Тут по описанию получается не просто подключить hh и GPT, а связать поиск кандидатов, оценку, историю и аналитику в один процесс. Похожие кабинеты с ролями и внешними API делал, могу показать близкий по логике проект. Если основа у вас уже есть и нужно встроить именно поиск и AI-разбор, ориентир 250к и 35 дней. Подскажите, кабинет уже работает или интерфейс и базу тоже нужно делать с нуля?',
    why: 'Понравившаяся владельцу планка: живой язык, нормальное укрупнение задачи, правдоподобное доказательство, условная оценка и один вопрос о главной границе.',
  },
  {
    kind: 'Простая понятная задача по вёрстке',
    example: 'Добрый день. Если в макете много SVG-графики, повторяющиеся элементы сразу вынесу отдельно, чтобы потом не править каждый экран вручную. Пришлите полную Figma, посмотрю компоненты и скажу точный срок по всем страницам.',
    why: 'Одна деталь из брифа превращена в понятную пользу. Нет резюме, пересказа задания и вопроса ради вопроса.',
  },
  {
    kind: 'Продукт, для которого есть близкий реальный кейс',
    example: 'Добрый день. Магазины такого уровня делал, могу показать TERRA MARKET с каталогом, фильтрами, вариантами товара и оформлением заказа. Здесь сначала посмотрю шаблон и объём каталога, после этого зафиксирую этапы без сюрпризов по смете. Сколько товаров и вариантов планируется на запуске?',
    why: 'Кейс назван конкретно и связан с заказом по сути, а не общей фразой про портфолио.',
  },
  {
    kind: 'Лендинг услуги, где сначала нужно сформировать доверие',
    example: 'Добрый день. На ремонте рулевых реек я бы строил лендинг не вокруг обычного списка услуг, а вокруг реальных кейсов: с чем приехали, что нашли, что сделали и какую дали гарантию. Так ваши фото будут продавать доверие к сервису. Если дизайн нужен с нуля, ориентир 80к. Фото и отзывы уже собраны?',
    why: 'Не повторяет задание, а показывает сильную идею именно для этого бизнеса, объясняет пользу и даёт уместную коммерческую рамку.',
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

  async draftReply(context: Record<string, unknown>): Promise<string> {
    const seller = await this.settings.getPublic('seller_profile') || {};
    const style = await this.settings.getPublic('style_profile') || DEFAULT_STYLE_PROFILE;
    const sourceLead = (context.lead || {}) as Record<string, unknown>;
    const portfolio = this.compactPortfolio(
      await this.settings.getPublic('fl_portfolio_cases') || [],
      `${sourceLead.title || ''} ${sourceLead.description || ''}`,
    );
    const sourceMessages = Array.isArray(context.messages) ? context.messages : [];
    const mode = context.mode === 'chat' ? 'chat' : 'response';
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
             AND (status IN ('approved','sent') OR metadata->>'owner_edited'='true')
           ORDER BY updated_at DESC LIMIT 12`,
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
      response_principles: RESPONSE_PRINCIPLES,
      calibration_examples: RESPONSE_CALIBRATION,
      submission_fields: {
        price: 'FL.ru получает recommended_price отдельным числовым полем',
        days: 'FL.ru получает recommended_days отдельным числовым полем',
        cover_letter: 'content — только сопроводительное сообщение; не дублируй цену и срок без коммерческой причины',
      },
      owner_instructions: String(context.ownerInstructions || '').slice(0, 4_000),
      voice_examples: voiceResult.rows.map((row) => row.content.slice(0, 300)),
      approved_examples: approvedResult.rows.map((row) => row.content.slice(0, 560)),
      recent_drafts: recentDraftResult.rows.map((row) => row.content.slice(0, 560)),
      context: compactContext,
    };

    if (mode === 'chat') {
      let result = await this.tasks.run<{ content: string }>('draft_reply', payload);
      let content = String(result.content || '').trim();
      const issues = this.draftQualityIssues(content, mode);
      if (issues.length) {
        result = await this.tasks.run<{ content: string }>('draft_reply', {
          ...payload,
          revision: { previous_content: content, issues },
        });
        content = String(result.content || '').trim();
      }
      return content;
    }

    const generated = await this.tasks.run<{ candidates: DraftCandidate[] }>('draft_candidates', payload);
    const candidates = Array.isArray(generated.candidates) ? generated.candidates.slice(0, 3) : [];
    let reviewed = await this.tasks.run<DraftReview>('draft_review', { ...payload, candidates });
    let content = String(reviewed.content || '').trim();
    const issues = this.draftQualityIssues(content, mode, recentDraftResult.rows.map((row) => row.content));
    if (Number(reviewed.human_score) < 85) issues.push('Редактор оценил естественность ниже 85/100: перепиши как личное сообщение человека.');
    if (Number(reviewed.sales_score) < 85) issues.push('Редактор оценил причину ответить ниже 85/100: усили конкретную ценность следующего шага.');
    if (Number(reviewed.specificity_score) < 90) issues.push('Текст можно отправить другому заказчику почти без изменений: добавь один уникальный якорь именно этого проекта.');
    if (Number(reviewed.factual_score) < 100) issues.push('Есть неподтверждённое утверждение: оставь только факты из seller и portfolio.');
    if (issues.length) {
      reviewed = await this.tasks.run<DraftReview>('draft_review', {
        ...payload,
        candidates,
        revision: { previous_content: content, issues },
      });
      content = String(reviewed.content || '').trim();
    }
    return content.charAt(0).toUpperCase() + content.slice(1);
  }

  private draftQualityIssues(content: string, mode: 'response' | 'chat', recentDrafts: string[] = []) {
    if (mode === 'chat') return [];
    const issues: string[] = [];
    const lower = content.toLowerCase();
    const banned = [
      'ключевой риск', 'ключевой узел', 'ближайший по механике кейс',
      'готов реализовать', 'имею большой опыт', 'качественно и в срок',
      'индивидуальный подход', 'современное решение', 'уже прикинул концепт',
      'в обозначенных границах', 'коммерческая рамка',
      'тут по описанию получается', 'я понял задачу как', 'вам нужно',
      'задача заключается', 'речь идет о', 'если речь о',
      'нужно уточнить границу', 'в описании есть', 'по описанию',
      'готов собрать', 'рабочий контур', 'первый контур',
      'в портфолио есть fullstack', 'сложная бизнес-логика',
      'fullstack',
    ];
    const found = banned.filter((phrase) => lower.includes(phrase));
    if (found.length) issues.push(`Шаблонные или AI-фразы: ${found.join(', ')}`);
    if (!/^(?:добрый день|здравствуйте|добрый)(?:[,.!?\s]|$)/i.test(content)) issues.push('Начни с короткого человеческого приветствия.');
    if (content.length < 90) issues.push('Слишком коротко: не хватает конкретного якоря именно этого проекта.');
    if (content.length > 460) issues.push('Слишком длинно для первого касания: оставь только сильное попадание и простой следующий шаг.');
    const questions = (content.match(/\?/g) || []).length;
    if (questions > 1) issues.push('Оставь максимум один действительно важный вопрос.');
    const sentences = (content.match(/[.!?]+(?:\s|$)/g) || []).length;
    if (sentences < 2 || sentences > 6) issues.push('Сделай 2–5 естественных предложений, соразмерных брифу.');
    const listLike = (content.match(/[;•]|(?:^|\n)\s*[-–—]\s/g) || []).length;
    if (listLike > 0) issues.push('Не используй список, точку с запятой и длинное тире.');
    const typographicMarks = (content.match(/[«»—]/g) || []).length;
    if (typographicMarks > 0) issues.push('Убери типографские кавычки и длинные тире, пунктуация должна быть простой.');
    if (/\b(?:лучше|стоит)\b[^.!?]{0,160}\bиначе\b/i.test(content)) {
      issues.push('Получилась заезженная формула «лучше сделать X, иначе Y»: перепиши как нормальное личное сообщение, без мини-лекции.');
    }
    if ((lower.match(/\b(?:цена|стоимость|срок|ориентир)\b/g) || []).length > 2) {
      issues.push('Не превращай сопроводительный текст в повтор числовых полей FL.ru.');
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
    const recentMaterialCtaCount = recentDrafts.filter((draft) => /(?:пришлите|отправьте|покажите)\b/i.test(draft)).length;
    if (/(?:пришлите|отправьте|покажите)\b/i.test(content) && recentMaterialCtaCount >= 3) {
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

  private compactPortfolio(value: unknown, leadText: string): Record<string, unknown>[] {
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
        const caseTokens = tokens(`${row.title || ''} ${row.description || ''}`);
        let score = 0;
        for (const word of leadTokens) if (caseTokens.has(word)) score += 1;
        return { index, score, row };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 4)
      .map(({ row }) => ({
        title: String(row.title || '').slice(0, 180),
        description: String(row.description || '').slice(0, 900),
        url: String(row.url || '').slice(0, 500),
      }));
  }

  async generateSpecification(context: Record<string, unknown>): Promise<string> {
    const result = await this.tasks.run<{ markdown: string }>('specification', { context });
    return String(result.markdown || '').trim();
  }

  async generateContractData(context: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.tasks.run<Record<string, unknown>>('contract_data', { context });
  }
}
