import { evaluateAutonomy, AutonomyPolicyConfig, MissionRuntime } from './autonomy.service';
import {
  parseOwnerMissionStart,
  parseOwnerMissionStop,
  parseOwnerMissionStatus,
  stemRecipient,
  parseOwnerOutboundRequest,
  parseOwnerSendApproval,
  stripLeadIn,
  ownerDeliveryResultMessage,
  parseOwnerChoice,
  missionShouldStartNow,
} from './telegram.service';

const STRICT: AutonomyPolicyConfig = { mode: 'manual', globalPaused: false, minAutoConfidence: 0.99 };

const mission = (over: Partial<MissionRuntime> = {}): MissionRuntime => ({
  instruction: 'отвечай на эльфийском',
  turnsLeft: 5,
  expired: false,
  exhausted: false,
  ...over,
});

const base = {
  inbound: 'Привет, как продвигается?',
  outbound: 'Aiya! Работа идёт по плану.',
  mode: 'chat' as const,
};

describe('mission unlocks autonomy for one lead only', () => {
  it('without a mission strict approval still asks the owner', () => {
    const result = evaluateAutonomy(base, STRICT);
    expect(result.decision).toBe('ask_owner');
    expect(result.signals).toContain('manual_mode');
  });

  it('with an active mission the same message is sent automatically', () => {
    const result = evaluateAutonomy({ ...base, mission: mission() }, STRICT);
    expect(result.decision).toBe('auto_send');
    expect(result.signals).toContain('mission');
    expect(result.reason).toBe('Веду по вашей задаче');
  });

  it('MISSIONS_ENABLED=false is a global rollback', () => {
    const previous = process.env.MISSIONS_ENABLED;
    process.env.MISSIONS_ENABLED = 'false';
    try {
      expect(evaluateAutonomy({ ...base, mission: mission() }, STRICT).decision).toBe('ask_owner');
    } finally {
      if (previous === undefined) delete process.env.MISSIONS_ENABLED;
      else process.env.MISSIONS_ENABLED = previous;
    }
  });
});

describe('guardrails still win over a mission', () => {
  it.each([
    ['цена', 'Сколько это будет стоить?'],
    ['договор', 'Пришлите договор и реквизиты'],
    ['сроки', 'Какой срок и когда будет готово?'],
    ['обещания', 'Вы гарантируете что возьмёте в работу?'],
  ])('stop-topic %s goes to the owner even under a mission', (_label, inbound) => {
    const result = evaluateAutonomy({ ...base, inbound, mission: mission() }, STRICT);
    expect(result.decision).toBe('ask_owner');
  });

  it('spam is skipped, not answered', () => {
    const result = evaluateAutonomy(
      { ...base, inbound: 'казино быстрый заработок', mission: mission() },
      STRICT,
    );
    expect(result.decision).toBe('skip');
  });

  it('an already handled message is not answered twice', () => {
    const result = evaluateAutonomy({ ...base, duplicate: true, mission: mission() }, STRICT);
    expect(result.decision).toBe('skip');
  });

  it('a broken connector stops the mission', () => {
    const result = evaluateAutonomy(
      { ...base, runtimeSignals: ['fl: cookies expired'], mission: mission() },
      STRICT,
    );
    expect(result.decision).toBe('ask_owner');
  });

  it('an expired deadline returns control to the owner', () => {
    const result = evaluateAutonomy({ ...base, mission: mission({ expired: true }) }, STRICT);
    expect(result.decision).toBe('ask_owner');
    expect(result.signals).toContain('mission_expired');
  });

  it('the turn cap returns control to the owner', () => {
    const result = evaluateAutonomy(
      { ...base, mission: mission({ exhausted: true, turnsLeft: 0 }) },
      STRICT,
    );
    expect(result.decision).toBe('ask_owner');
    expect(result.signals).toContain('mission_turn_cap');
  });
});

describe('owner commands', () => {
  it('distinguishes a reactive mission from an explicit opening message', () => {
    expect(missionShouldStartNow('общайся с Олегом на эльфийском')).toBe(false);
    expect(missionShouldStartNow('общайся с Олегом и напиши ему сейчас как дела')).toBe(true);
  });

  it('understands «общайся с Олегом на эльфийском»', () => {
    const parsed = parseOwnerMissionStart('общайся с Олегом на эльфийском');
    expect(parsed).toMatchObject({ recipient: 'Олег', instruction: 'на эльфийском' });
    expect(parsed?.deadline).toBeNull();
  });

  it('understands «веди Олега до ТЗ до конца дня» with a deadline', () => {
    const parsed = parseOwnerMissionStart('веди Олега до ТЗ до конца дня');
    expect(parsed?.recipient).toBe('Олег');
    expect(parsed?.deadline).toBeInstanceOf(Date);
  });

  it('reads an explicit turn cap', () => {
    expect(parseOwnerMissionStart('веди Олега сам, максимум 3 хода')?.maxTurns).toBe(3);
  });

  it('strips Russian case endings so the lead is found', () => {
    expect(stemRecipient('Олегом')).toBe('Олег');
    expect(stemRecipient('Олега')).toBe('Олег');
    expect(stemRecipient('Олег')).toBe('Олег');
  });

  it('understands stop, both named and bare', () => {
    expect(parseOwnerMissionStop('стоп по Олегу')).toEqual({ recipient: 'Олег' });
    expect(parseOwnerMissionStop('стоп')).toEqual({ recipient: null });
    expect(parseOwnerMissionStop('отправь Олегу привет')).toBeNull();
  });

  it('understands status questions', () => {
    expect(parseOwnerMissionStatus('что там у Олега')).toEqual({ recipient: 'Олег' });
    expect(parseOwnerMissionStatus('задачи')).toEqual({ recipient: null });
  });

  it('does not swallow the existing send commands', () => {
    expect(parseOwnerMissionStart('отправь Олегу сообщение какой он молодец')).toBeNull();
    expect(parseOwnerMissionStart('напиши Олегу привет')).toBeNull();
    expect(parseOwnerOutboundRequest('отправь Олегу сообщение какой он молодец')).not.toBeNull();
    expect(parseOwnerSendApproval('отправь')).not.toBeNull();
  });
});

describe('real owner phrasing from Telegram', () => {
  it('understands the exact message that failed today', () => {
    const parsed = parseOwnerMissionStart(
      'Так, смотри, общайся с Олегом только на эльфийском и напиши ему сейчас какое-то первое сообщение',
    );
    expect(parsed?.recipient).toBe('Олег');
    expect(parsed?.instruction).toContain('эльфийском');
  });

  it.each([
    'Слушай, веди Олега сам',
    'Ну давай, общайся с Олегом на эльфийском',
    'Вот смотри веди Олега до ТЗ',
  ])('survives the lead-in: %s', (text) => {
    expect(parseOwnerMissionStart(text)?.recipient).toBe('Олег');
  });

  it('strips only lead-ins, not the command', () => {
    expect(stripLeadIn('Так, смотри, стоп по Олегу')).toBe('стоп по Олегу');
    expect(stripLeadIn('общайся с Олегом')).toBe('общайся с Олегом');
  });

  it('stop and status also survive the lead-in', () => {
    expect(parseOwnerMissionStop('Так, стоп по Олегу')).toEqual({ recipient: 'Олег' });
    expect(parseOwnerMissionStatus('Слушай, что там у Олега')).toEqual({ recipient: 'Олег' });
  });
});

describe('owner is told the truth about the owner-session handoff', () => {
  it('does not claim failure on BUSINESS_PEER_INVALID', () => {
    const message = ownerDeliveryResultMessage({
      status: 'failed',
      leadTitle: 'Олег Зотов',
      channel: 'telegram',
      error: 'Bad Request: BUSINESS_PEER_INVALID',
    });
    expect(message).toContain('с вашего аккаунта');
    expect(message).not.toMatch(/^Не отправлено/);
  });

  it('still reports a genuine failure as a failure', () => {
    const message = ownerDeliveryResultMessage({
      status: 'failed',
      leadTitle: 'Клиент',
      channel: 'telegram',
      error: 'Forbidden: bot was blocked by the user',
    });
    expect(message).toMatch(/^Не отправлено/);
  });
});

describe('picking the right Oleg out of several', () => {
  it('keeps the surname instead of throwing it away', () => {
    const parsed = parseOwnerMissionStart('общайся с Олегом Зотовым на эльфийском');
    expect(parsed?.recipient).toBe('Олег Зотов');
    expect(parsed?.instruction).toBe('на эльфийском');
  });

  it('offers the full name first and the bare first name as a fallback', () => {
    const parsed = parseOwnerMissionStart('общайся с Олегом Зотовым на эльфийском');
    expect(parsed?.candidates.map((c) => c.recipient)).toEqual(['Олег Зотов', 'Олег']);
  });

  it('handles the exact phrase from the screenshot', () => {
    const parsed = parseOwnerMissionStart(
      'Так, смотри, общайся с Олегом Зотов только на эльфийском и напиши ему сейчас',
    );
    expect(parsed?.recipient).toBe('Олег Зотов');
    expect(parsed?.instruction).toContain('эльфийском');
  });

  it('does not swallow instruction words into the name', () => {
    expect(parseOwnerMissionStart('веди Олега до ТЗ до конца дня')?.recipient).toBe('Олег');
    expect(parseOwnerMissionStart('общайся с Олегом только на эльфийском')?.recipient).toBe('Олег');
    expect(parseOwnerMissionStart('веди Олега сам, максимум 3 хода')?.maxTurns).toBe(3);
  });
});

describe('answering with a number', () => {
  it.each([['1', 1], ['2', 2], ['Так, 3', 3], ['1.', 1]])('reads %s', (text, expected) => {
    expect(parseOwnerChoice(text as string)).toBe(expected);
  });

  it('ignores anything that is not a plain number', () => {
    expect(parseOwnerChoice('отправь')).toBeNull();
    expect(parseOwnerChoice('1 и 2')).toBeNull();
    expect(parseOwnerChoice('')).toBeNull();
    expect(parseOwnerChoice('100')).toBeNull();
  });
});
