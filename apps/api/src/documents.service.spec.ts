import { buildContractTemplateData, prepareContractTemplateXml, ruIntegerWords } from './documents.service';

describe('contract template', () => {
  test('turns the supplied plain legal form into a fillable template', () => {
    const source = [
      'ДОГОВОР № ______',
      '«___» __________ 20___ г.',
      'и _____________________________, именуемый в дальнейшем «Заказчик», в лице _____________________________, действующего на основании __________________,',
      'Контактные данные представителя Заказчика: ФИО __________________, телефон __________________, e-mail __________________.',
      'составляет ______ (____________) рабочих дней',
      'составляет ____________ (____________) рублей',
      'авансовый платёж 50%',
      'оставшиеся 50%',
      'Наименование / ФИО: _____________________________',
      'ИНН: ____________ ОГРН(ИП): ____________',
      'Телефон: __________________',
      'E-mail: __________________',
      'Подпись: ____________ / __________________ /',
    ].join('\n');
    const prepared = prepareContractTemplateXml(source);
    expect(prepared.missing).toEqual([]);
    expect(prepared.xml).toContain('ДОГОВОР № {contract_number}');
    expect(prepared.xml).toContain('{customer_representative}');
    expect(prepared.xml).toContain('{price_words}');
    expect(prepared.xml).toContain('{customer_signer}');
  });

  test('formats confirmed values and keeps visible blanks for unknown legal data', () => {
    expect(buildContractTemplateData({
      customer_status: 'ООО',
      customer_name: '«Ромашка»',
      customer_representative: 'Иванова И.И.',
      price: 250000,
      days: 32,
      advance_percent: 40,
    })).toEqual(expect.objectContaining({
      customer_name: 'ООО «Ромашка»',
      customer_contact_name: 'Иванова И.И.',
      customer_inn: '____________',
      price_formatted: '250 000',
      price_words: 'двести пятьдесят тысяч',
      days_words: 'тридцать два',
      advance_percent: 40,
      balance_percent: 60,
    }));
    expect(buildContractTemplateData({ price: null, days: null, advance_percent: null })).toEqual(expect.objectContaining({
      price_formatted: '____________',
      price_words: '____________',
      days: '______',
      days_words: '____________',
      advance_percent: 50,
      balance_percent: 50,
    }));
  });

  test('spells Russian integer groups deterministically', () => {
    expect(ruIntegerWords(0)).toBe('ноль');
    expect(ruIntegerWords(21001)).toBe('двадцать одна тысяча один');
    expect(ruIntegerWords(1250000)).toBe('один миллион двести пятьдесят тысяч');
    expect(ruIntegerWords('not-a-number')).toBe('');
  });
});
