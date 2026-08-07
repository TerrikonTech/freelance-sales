import { TelegramService } from './telegram.service';

/**
 * The owner speaks freely; anything the cheap patterns miss goes to the model,
 * which either commands the bot or asks one question and remembers the unfinished
 * command so the plain-language answer completes it.
 */
describe('AI intent routing with clarification memory', () => {
  const build = (intent: Record<string, unknown>, agentPatch: Record<string, jest.Mock> = {}) => {
    const settings = { getPublic: jest.fn().mockResolvedValue({ id: 42 }) };
    const tasks = { run: jest.fn().mockResolvedValue(intent) };
    const agent = {
      ownerLead: jest.fn().mockResolvedValue({ id: 'lead-1', title: 'Олег Зотов' }),
      answerOwner: jest.fn().mockResolvedValue({ answer: 'ответ' }),
      answerOwnerOverview: jest.fn().mockResolvedValue({ answer: 'сводка' }),
      recentLeads: jest.fn().mockResolvedValue([]),
      prepareOwnerOutbound: jest.fn().mockResolvedValue({
        leadTitle: 'Олег Зотов', channel: 'telegram', content: 'Текст',
      }),
      approveOwnerOutbound: jest.fn().mockResolvedValue({ draftId: 'd1' }),
      selectOwnerLead: jest.fn().mockResolvedValue({ selected: null, matches: [] }),
      selectOwnerLeadByCandidates: jest.fn().mockResolvedValue({
        selected: { id: 'lead-1', title: 'Олег Зотов' }, used: null, matches: [],
      }),
      setPendingIntent: jest.fn().mockResolvedValue(undefined),
      takePendingIntent: jest.fn().mockResolvedValue(null),
      setPendingChoice: jest.fn().mockResolvedValue(undefined),
      takePendingChoice: jest.fn().mockResolvedValue(null),
      ...agentPatch,
    };
    const autonomy = {
      activeMissions: jest.fn().mockResolvedValue([]),
      setMission: jest.fn().mockResolvedValue({
        instruction: 'на эльфийском', max_turns: 10, deadline: null,
      }),
      stopMission: jest.fn().mockResolvedValue(true),
      getMission: jest.fn().mockResolvedValue(null),
    };
    const service = new TelegramService(
      {} as never, settings as never, {} as never,
      agent as never, autonomy as never, tasks as never,
    );
    const sendControlMessage = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { sendControlMessage: jest.Mock }).sendControlMessage = sendControlMessage;
    return { service, agent, autonomy, tasks, sendControlMessage };
  };

  const send = (service: TelegramService, text: string) =>
    service.processOwnerMessage({ from: { id: 42 }, chat: { id: 42 }, text });

  test('an unrecognised phrase reaches the model instead of dying in analysis', async () => {
    const { service, tasks } = build({
      intent: 'question', recipient: null, instruction: null,
      question: null, confidence: 0.9, restated: 'вопрос',
    });
    await send(service, 'а чё там вообще по делам-то у нас');
    expect(tasks.run).toHaveBeenCalledWith('owner_intent', expect.objectContaining({
      message: 'а чё там вообще по делам-то у нас',
    }), expect.any(Number));
  });

  test('an unclear command asks one question and keeps the unfinished command', async () => {
    const { service, agent, sendControlMessage } = build({
      intent: 'clarify', recipient: null, instruction: 'про сроки',
      question: 'Кому именно написать?', confidence: 0.4, restated: 'неясно',
    });
    await send(service, 'ну напиши там про сроки');
    expect(sendControlMessage).toHaveBeenCalledWith('42', 'Кому именно написать?');
    expect(agent.setPendingIntent).toHaveBeenCalledWith('42', expect.objectContaining({
      text: 'ну напиши там про сроки',
      question: 'Кому именно написать?',
    }));
  });

  test('the answer to that question is resolved together with it', async () => {
    const pending = {
      text: 'ну напиши там про сроки',
      question: 'Кому именно написать?',
      intent: { intent: 'clarify' },
      askedAt: new Date().toISOString(),
    };
    const { service, agent, tasks } = build(
      {
        intent: 'draft_message', recipient: 'Олег Зотов', instruction: 'про сроки',
        question: null, confidence: 0.9, restated: 'черновик Олегу про сроки',
      },
      { takePendingIntent: jest.fn().mockResolvedValue(pending) },
    );
    await send(service, 'Олегу Зотову');
    expect(tasks.run).toHaveBeenCalledWith('owner_intent', expect.objectContaining({
      pending: expect.objectContaining({ question: 'Кому именно написать?' }),
    }), expect.any(Number));
    expect(agent.prepareOwnerOutbound).toHaveBeenCalledWith('42', 'про сроки', 'Олег Зотов');
    expect(agent.approveOwnerOutbound).not.toHaveBeenCalled();
  });

  test('a stale question is dropped instead of hijacking a new command', async () => {
    const stale = {
      text: 'старое', question: 'Кому?', intent: { intent: 'clarify' },
      askedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    };
    const { service, tasks } = build(
      {
        intent: 'overview', recipient: null, instruction: null,
        question: null, confidence: 0.9, restated: 'сводка',
      },
      { takePendingIntent: jest.fn().mockResolvedValue(stale) },
    );
    await send(service, 'а что там вообще интересного');
    expect(tasks.run).toHaveBeenCalledWith('owner_intent', expect.objectContaining({ pending: null }), expect.any(Number));
  });

  test('the model can start a mission from free phrasing', async () => {
    const { service, autonomy, sendControlMessage } = build({
      intent: 'start_mission', recipient: 'Олег Зотов', instruction: 'на эльфийском',
      question: null, confidence: 0.95, restated: 'вести Олега на эльфийском', max_turns: 3,
    });
    await send(service, 'пусть теперь сам болтает с Зотовым по-эльфийски');
    expect(autonomy.setMission).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-1', instruction: 'на эльфийском', maxTurns: 3,
    }));
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('веду сам'));
  });

  test('a conditional send never reaches the model', async () => {
    const { service, tasks, agent, sendControlMessage } = build({
      intent: 'send_message', recipient: 'Олег', instruction: 'привет',
      question: null, confidence: 0.9, restated: 'отправить',
    });
    await send(service, 'отправь Олегу Зотову когда он ответит');
    expect(tasks.run).not.toHaveBeenCalled();
    expect(agent.approveOwnerOutbound).not.toHaveBeenCalled();
    expect(sendControlMessage).toHaveBeenCalledWith('42', expect.stringContaining('Ничего не отправлено'));
  });

  test('a clear pattern still costs no tokens', async () => {
    const { service, tasks, agent } = build({ intent: 'question', recipient: null, instruction: null, question: null, confidence: 1, restated: '-' });
    await send(service, 'отправь Олегу сообщение привет');
    expect(tasks.run).not.toHaveBeenCalled();
    expect(agent.prepareOwnerOutbound).toHaveBeenCalledWith('42', 'привет', 'Олегу');
  });
});
