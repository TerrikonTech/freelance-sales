import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('api/connectors/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Post('webhook')
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: Record<string, any>,
  ) {
    if (!(await this.telegram.verifyWebhookSecret(secret))) throw new UnauthorizedException();
    await this.telegram.processUpdate(update);
    return { ok: true };
  }
}
