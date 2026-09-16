import { leadCaseTypes, portfolioCaseKey } from './portfolio-tags';
import { selectRelevantPortfolio } from './ai.service';

const CASES = [
  {
    title: 'MES LITE - учет производства',
    description: 'Данные с оборудования подтягиваются автоматически, дашборд на PostgreSQL держит события',
    url: 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8061000/',
  },
  {
    title: 'SHELF SCAN - слежение за объявлениями',
    description: 'Сервис ищет новые объявления и присылает уведомления в телеграм',
    url: 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8067033/',
  },
];

const TAGS = {
  '8061000': { job_types: ['crm_admin_analytics'], stack: 'Nest, PostgreSQL', domain: 'производство', facts: ['данные с оборудования без оператора'] },
  '8067033': { job_types: ['parsing_scraping'], stack: 'Playwright', domain: 'ритейл', facts: ['слежение за новыми объявлениями и алерт в телеграм'] },
};

const PARSER_LEAD = 'Разработать отслеживание новых объявлений по ключевым словам. Уведомления о нужных объявлениях должны приходить в телеграм.';

describe('portfolio case tags', () => {
  it('reads the portfolio id out of the case url', () => {
    expect(portfolioCaseKey(CASES[1].url)).toBe('8067033');
    expect(portfolioCaseKey('')).toBe('');
  });

  it('takes the analyzer category first and widens it with wording hints', () => {
    const types = leadCaseTypes({ pricing_category: 'parsing_scraping' }, PARSER_LEAD);
    expect(types[0]).toBe('parsing_scraping');
    expect(types).toContain('automation_or_bot');
  });

  it('prefers a case of the same job type over a keyword match', () => {
    const picked = selectRelevantPortfolio(CASES, PARSER_LEAD, 2, {
      leadTypes: ['parsing_scraping'],
      tags: TAGS,
    });
    expect(picked[0].url).toContain('8067033');
    expect(picked[0].matches_order_type).toBe(true);
    expect(picked[0].job_types).toEqual(['parsing_scraping']);
  });

  it('still returns a case when no type matches, so a stretched case stays available', () => {
    const picked = selectRelevantPortfolio(CASES, PARSER_LEAD, 5, {
      leadTypes: ['mobile_mvp'],
      tags: TAGS,
    });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((item) => item.matches_order_type === false)).toBe(true);
  });

  it('keeps working without any tags at all', () => {
    const picked = selectRelevantPortfolio(CASES, PARSER_LEAD, 2, { leadTypes: ['parsing_scraping'] });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked[0].job_types).toEqual([]);
  });
});
