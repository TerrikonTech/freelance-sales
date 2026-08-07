import { flProfileIdentity } from './fl.service';

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
