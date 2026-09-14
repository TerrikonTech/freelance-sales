import {
  carryOverManualCases, flCookieHeader, flProfileIdentity, matchesExistingFlOffer,
} from './fl.service';

describe('FL portfolio sync keeps hand-written cases', () => {
  const manual = {
    title: 'FUNNEL OPS', url: '', source: 'manual', solution_details: 'сквозная метка до оплаты',
  };
  const scrapedCase = { title: 'HR BRAND SITE', url: 'https://www.fl.ru/user/x/portfolio/1/', source: 'fl' };

  test('carries an unpublished manual case through a sync that cannot see it', () => {
    expect(carryOverManualCases([scrapedCase], [scrapedCase, manual])).toEqual([manual]);
  });

  test('never carries a scraped case, so FL.ru stays the source of truth', () => {
    expect(carryOverManualCases([scrapedCase], [scrapedCase])).toEqual([]);
  });

  test('retires a manual case once FL.ru publishes the same title', () => {
    const published = { title: 'funnel ops', url: 'https://www.fl.ru/user/x/portfolio/2/', source: 'fl' };
    expect(carryOverManualCases([published], [published, manual])).toEqual([]);
  });

  test('does not collide two unpublished manual cases on their empty url', () => {
    const second = { title: 'WEBHOOK GUARD', url: '', source: 'manual' };
    expect(carryOverManualCases([], [manual, second])).toEqual([manual, second]);
  });
});

describe('FL scan session', () => {
  test('uses the configured FL session without malformed cookies', () => {
    expect(flCookieHeader([
      { name: 'PHPSESSID', value: 'session' },
      { name: '', value: 'ignored' },
    ])).toBe('PHPSESSID=session');
  });
});

describe('FL profile identity extraction', () => {
  test('extracts a verified username and visible name from an FL profile link', () => {
    expect(flProfileIdentity('/users/oleg-dev/', 'Олег')).toEqual({
      name: 'Олег',
      username: 'oleg-dev',
    });
  });

  test('accepts an absolute FL profile link', () => {
    expect(flProfileIdentity('https://www.fl.ru/users/kleftis30/portfolio/', '')).toEqual({
      name: null,
      username: 'kleftis30',
    });
  });

  test('rejects identities from non-FL links and generic labels', () => {
    expect(flProfileIdentity('https://example.com/users/oleg/', 'Олег')).toEqual({
      name: null,
      username: null,
    });
    expect(flProfileIdentity('/users/oleg/', 'Профиль')).toEqual({
      name: null,
      username: 'oleg',
    });
    expect(flProfileIdentity('/users/oleg/', 'Разработка сайта под ключ')).toEqual({
      name: null,
      username: 'oleg',
    });
  });
});


describe('FL existing offer reconciliation', () => {
  test('recognises the approved draft inside FL own-offer UI text', () => {
    const draft = [
      'Добрый день! За задачу возьмусь, опыт с такими системами есть.',
      'Делал похожий проект для логистики и хорошо знаю, где бывают проблемы с данными.',
      'Главный нюанс здесь в правилах проверки документов и правах сотрудников.',
      'Если остались вопросы, готов ответить в чате.'
    ].join(' ');
    const firstBreak = Math.floor(draft.length / 3);
    const secondBreak = Math.floor(draft.length * 2 / 3);
    const existing = [
      'Ваш отклик 180000 рублей, сделаю за 28 дней',
      draft.slice(0, firstBreak),
      'Показать полностью',
      draft.slice(firstBreak, secondBreak),
      'Свернуть',
      draft.slice(secondBreak),
      'Редактировать'
    ].join(' ');
    expect(matchesExistingFlOffer(existing, draft)).toBe(true);
  });

  test('does not confuse a different existing response with the approved draft', () => {
    const draft = 'Добрый день! ' + 'Нужный текст про парсинг судебных сайтов и проверку документов. '.repeat(8);
    const other = 'Ваш отклик Добрый день! ' + 'Совсем другой ответ про разработку интернет магазина. '.repeat(8);
    expect(matchesExistingFlOffer(other, draft)).toBe(false);
  });

  test('rejects a different middle even when greeting and footer are the same', () => {
    const draft = 'Добрый день! ' + 'Парсинг документов, судебные сайты, проверка данных и контроль ошибок. '.repeat(8)
      + ' Готов ответить на вопросы в чате.';
    const other = draft.slice(0, 100)
      + ' Разработка магазина, корзина, каталог и оплата. '.repeat(10)
      + draft.slice(-100);
    expect(matchesExistingFlOffer(other, draft)).toBe(false);
  });
});
