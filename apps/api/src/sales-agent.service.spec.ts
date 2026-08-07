import { SalesAgentService } from './sales-agent.service';

describe('Sales agent outbound target safety', () => {
  const lead = {
    id: 'lead-1',
    source: 'fl',
    external_id: 'project-123',
    title: 'Проект FL',
    client: {},
  };

  test('does not mistake an FL project id for a chat id', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new SalesAgentService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      (service as any).preferredOutboundTarget(lead),
    ).resolves.toBeNull();
  });

  test('uses only an explicitly registered FL dialog', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ channel: 'fl', external_id: 'dialog-456' }] }) };
    const service = new SalesAgentService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      (service as any).preferredOutboundTarget(lead),
    ).resolves.toEqual({ channel: 'fl', externalId: 'dialog-456' });
    expect(db.query.mock.calls[0][0]).toContain("metadata->>'kind'='dialog'");
  });

  test('rejects a project-title word as recipient before asking AI to draft', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ ...lead, title: 'Разработка сайта под ключ' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const ai = { draftReply: jest.fn() };
    const service = new SalesAgentService(db as never, {} as never, {} as never, ai as never, {} as never, {} as never);
    await expect(
      service.prepareOwnerOutbound('owner-1', 'в работу', 'разработку'),
    ).rejects.toThrow('Ничего не отправлено');
    expect(ai.draftReply).not.toHaveBeenCalled();
  });

  test('selects a unique named client without a previous active selection', async () => {
    const matchedLead = { ...lead, client: { fl_name: 'Олег', fl_username: 'oleg-dev' } };
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ ...matchedLead, recipient_aliases: [] }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const service = new SalesAgentService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      (service as any).resolveOwnerRecipient('owner-1', 'олегу', null),
    ).resolves.toMatchObject({ id: 'lead-1' });
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('owner_agent_sessions'), ['owner-1', 'lead-1']);
  });

  test('fails closed when a recipient name is ambiguous', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          { ...lead, id: 'lead-1', client: { name: 'Олег' }, recipient_aliases: [] },
          { ...lead, id: 'lead-2', client: { name: 'Олег' }, recipient_aliases: [] },
        ],
      }),
    };
    const service = new SalesAgentService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      (service as any).resolveOwnerRecipient('owner-1', 'олегу', null),
    ).rejects.toThrow('несколько клиентов');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
