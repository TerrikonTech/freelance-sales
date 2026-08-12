import { AppController } from './app.controller';

function controllerWith(db: { query: jest.Mock }) {
  return new AppController(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('Dashboard live event boundaries', () => {
  test('only FL drafts and FL messages can become page alarms', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const controller = controllerWith(db);

    await controller.liveEvents();

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[1][0])).toContain("d.channel='fl'");
    expect(String(db.query.mock.calls[2][0])).toContain("m.channel='fl'");
  });
});

describe('FL publication time in the lead list', () => {
  test('returns and sorts by the project publication time, not analysis updated_at', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const controller = controllerWith(db);

    await controller.leads();

    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toContain("requirements->'project'->>'published_at'");
    expect(sql).toContain('AS published_at');
    expect(sql).toContain('ORDER BY published_at DESC');
    expect(sql).not.toContain('ORDER BY updated_at DESC');
  });
});
