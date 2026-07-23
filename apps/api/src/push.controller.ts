import { Body, Controller, Delete, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { PushService } from './push.service';

@Controller('api/push')
@UseGuards(AuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('status')
  status() {
    return this.push.status();
  }

  @Post('subscribe')
  subscribe(
    @Body() subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    @Headers('user-agent') userAgent = '',
  ) {
    return this.push.subscribe(subscription, userAgent);
  }

  @Delete('subscribe')
  unsubscribe(@Body() body: { endpoint?: string }) {
    return this.push.unsubscribe(String(body.endpoint || ''));
  }

  @Post('test')
  async test() {
    return this.push.notify('Sales Control работает', 'Push-уведомления подключены.', '/sales/');
  }
}
