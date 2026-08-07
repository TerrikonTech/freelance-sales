import { portfolioLinkIssues } from './ai.service';

const CASES = [
  {
    title: 'TERRA MARKET - маркетплейс фермерских продуктов',
    url: 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8057737/',
    description: 'каталог, фильтры, варианты товара',
  },
  {
    title: 'CORP HOLDING',
    url: 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8067027/',
    description: 'корпоративный сайт группы компаний',
  },
];

describe('a named case must come with its link', () => {
  it('flags the real draft that names CORP HOLDING but only promises to show it', () => {
    const draft = 'Добрый день. Для CORP HOLDING я сделал корпоративный сайт, где разделы '
      + 'редактируются без разработчика. Могу показать этот кейс после знакомства.';
    const issues = portfolioLinkIssues(draft, CASES);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CORP HOLDING');
    expect(issues[0]).toContain('https://www.fl.ru/user/sporyshevsaveli/portfolio/8067027/');
  });

  it('stays silent once the link is actually there', () => {
    const draft = 'Магазины такого уровня делал, вот TERRA MARKET: '
      + 'https://www.fl.ru/user/sporyshevsaveli/portfolio/8057737/';
    expect(portfolioLinkIssues(draft, CASES)).toEqual([]);
  });

  it('does not nag when no case is mentioned at all', () => {
    const draft = 'Добрый день. Пришлите Figma, посмотрю компоненты и назову срок.';
    expect(portfolioLinkIssues(draft, CASES)).toEqual([]);
  });

  it('matches the case even when only the first words are used', () => {
    const draft = 'Похожее делал — TERRA MARKET, там каталог и фильтры.';
    expect(portfolioLinkIssues(draft, CASES)[0]).toContain('8057737');
  });

  it('is safe with empty or malformed input', () => {
    expect(portfolioLinkIssues('', CASES)).toEqual([]);
    expect(portfolioLinkIssues('CORP HOLDING', [])).toEqual([]);
    expect(portfolioLinkIssues('CORP HOLDING', [{ title: 'CORP HOLDING' }])).toEqual([]);
    expect(portfolioLinkIssues('CORP HOLDING', null as never)).toEqual([]);
  });

  it('does not fire on a short generic word', () => {
    expect(portfolioLinkIssues('Сделаю сайт', [{ title: 'Сайт', url: 'https://x/portfolio/1/' }])).toEqual([]);
  });
});
