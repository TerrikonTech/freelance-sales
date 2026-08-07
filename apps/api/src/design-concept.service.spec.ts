import {
  DesignConceptService,
  designEngine,
  isBlockedIpAddress,
  validateReferenceUrlSyntax,
} from './design-concept.service';

describe('Design concept safety', () => {
  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fd00::1',
    'fe80::1',
  ])('blocks private address %s', (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  test.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isBlockedIpAddress(address)).toBe(false);
  });

  test('rejects local hosts, credentials and unexpected ports', () => {
    expect(() => validateReferenceUrlSyntax('http://localhost/page')).toThrow('Локальные');
    expect(() => validateReferenceUrlSyntax('http://127.0.0.1/page')).toThrow('Приватные');
    expect(() => validateReferenceUrlSyntax('https://user:pass@example.com/')).toThrow('логином');
    expect(() => validateReferenceUrlSyntax('https://example.com:8443/')).toThrow('порт');
    expect(validateReferenceUrlSyntax('https://example.com/project').hostname).toBe('example.com');
  });

  test('creates an expiring signed URL and verifies it fail-closed', async () => {
    const previous = {
      DOCUMENTS_DIR: process.env.DOCUMENTS_DIR,
      PUBLIC_URL: process.env.PUBLIC_URL,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    };
    process.env.DOCUMENTS_DIR = '/tmp/freelance-sales-design-test';
    process.env.PUBLIC_URL = 'https://example.com/sales';
    process.env.ENCRYPTION_KEY = 'test-only-encryption-key-32-bytes';
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [{ file_path: '/tmp/freelance-sales-design-test/design-concepts/asset.png', content_type: 'image/png' }],
      }),
    };
    const service = new DesignConceptService(db as never, {} as never, {} as never);
    const url = new URL(service.publicAssetUrl('4b99902e-2fc4-4dc8-92b4-8a20c8d9897b', 120));
    await expect(service.publicAsset(
      '4b99902e-2fc4-4dc8-92b4-8a20c8d9897b',
      url.searchParams.get('expires') || '',
      url.searchParams.get('signature') || '',
    )).resolves.toEqual(expect.objectContaining({ contentType: 'image/png' }));
    await expect(service.publicAsset(
      '4b99902e-2fc4-4dc8-92b4-8a20c8d9897b',
      url.searchParams.get('expires') || '',
      '00'.repeat(32),
    )).rejects.toThrow('Некорректная подпись');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

describe('Design engine selection', () => {
  const previous = process.env.DESIGN_ENGINE;
  afterEach(() => {
    if (previous === undefined) delete process.env.DESIGN_ENGINE;
    else process.env.DESIGN_ENGINE = previous;
  });

  test('defaults to Codex so no image API key is required', () => {
    delete process.env.DESIGN_ENGINE;
    expect(designEngine()).toBe('codex');
  });

  test('Codex needs no OpenAI key and costs nothing extra', async () => {
    delete process.env.DESIGN_ENGINE;
    const settings = { getSecret: jest.fn().mockResolvedValue(null) };
    const service = new DesignConceptService({} as never, settings as never, {} as never);
    await expect(service.configured()).resolves.toBe(true);
    expect(service.estimate(4)).toBe(0);
    expect(settings.getSecret).not.toHaveBeenCalled();
  });

  test('the OpenAI engine still demands its key and reports a price', async () => {
    process.env.DESIGN_ENGINE = 'openai';
    const settings = { getSecret: jest.fn().mockResolvedValue(null) };
    const service = new DesignConceptService({} as never, settings as never, {} as never);
    await expect(service.configured()).resolves.toBe(false);
    expect(service.estimate(4)).toBeGreaterThan(0);
  });
});
