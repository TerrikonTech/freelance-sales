import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { QueueService } from './queue.service';
import { SettingsService } from './settings.service';
import { TelegramService } from './telegram.service';

@Controller('api/internal/telegram')
export class TelegramInternalController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
  ) {}

  @Post('configure')
  async configure(
    @Headers('x-sales-broker-token') token: string | undefined,
    @Body() body: {
      botToken?: string;
      connectionId?: string;
      ownerId?: string | number;
      contactUsername?: string;
      activate?: boolean;
    },
  ) {
    this.authorize(token);
    const botToken = String(body.botToken || '').trim();
    if (!botToken.includes(':')) throw new UnauthorizedException('Некорректный bot token');
    await this.settings.setSecret('telegram_bot_token', botToken);
    await this.settings.setSecret(
      'telegram_webhook_secret',
      randomBytes(32).toString('hex'),
    );
    if (body.connectionId) {
      await this.settings.setSecret(
        'telegram_business_connection_id',
        String(body.connectionId),
      );
    }
    if (body.ownerId) {
      await this.settings.setPublic('telegram_owner', {
        id: Number(body.ownerId),
        username: null,
      });
    }
    if (body.contactUsername) {
      const seller =
        await this.settings.getPublic<Record<string, unknown>>('seller_profile') || {};
      await this.settings.setPublic('seller_profile', {
        ...seller,
        telegram_username: String(body.contactUsername).replace(/^@/, ''),
      });
    }
    if (body.activate === true) return this.telegram.configureWebhook();
    await this.settings.setConnectorState('telegram', {
      enabled: false,
      healthy: false,
      statusText: 'Данные перенесены, webhook ещё не переключён',
    });
    return { ok: true, staged: true };
  }

  @Post('messages')
  async messages(
    @Headers('x-sales-broker-token') token: string | undefined,
    @Body() body: { messages?: Array<Record<string, unknown>> },
  ) {
    this.authorize(token);
    return this.telegram.ingestMtprotoMessages(body.messages || []);
  }

  @Post('owner-command')
  async ownerCommand(
    @Headers('x-sales-broker-token') token: string | undefined,
    @Body() body: {
      ownerId?: string | number;
      chatId?: string | number;
      messageId?: string | number;
      text?: string;
    },
  ) {
    this.authorize(token);
    const ownerId = Number(body.ownerId);
    const chatId = Number(body.chatId);
    const messageId = Number(body.messageId);
    const text = String(body.text || '').trim();
    if (!ownerId || !chatId || !messageId || !text) return { queued: false };
    await this.queue.add(
      'owner-command',
      {
        message: {
          from: { id: ownerId },
          chat: { id: chatId },
          message_id: messageId,
          text,
        },
      },
      `mtproto-owner-command-${chatId}-${messageId}`,
    );
    return { queued: true };
  }

  private authorize(token?: string) {
    const expected = process.env.SALES_BROKER_TOKEN || '';
    const left = Buffer.from(token || '');
    const right = Buffer.from(expected);
    if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException();
    }
  }
}
