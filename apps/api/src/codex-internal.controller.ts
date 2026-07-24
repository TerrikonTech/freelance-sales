import { Body, Controller, Headers, Param, Post, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { CodexTaskService } from './codex-task.service';

@Controller('api/internal/codex')
export class CodexInternalController {
  constructor(private readonly tasks: CodexTaskService) {}

  @Post('heartbeat')
  heartbeat(
    @Headers('x-sales-broker-token') token?: string,
    @Body() body: { provider?: string } = {},
  ) {
    this.authorize(token);
    return this.tasks.heartbeat(body.provider);
  }

  @Post('tasks/claim')
  claim(@Headers('x-sales-broker-token') token: string | undefined, @Body() body: { workerId?: string }) {
    this.authorize(token);
    return this.tasks.claim(body.workerId || 'sales-codex-broker').then((task) => ({ task }));
  }

  @Post('tasks/:id/complete')
  complete(
    @Headers('x-sales-broker-token') token: string | undefined,
    @Param('id') id: string,
    @Body() body: { result?: Record<string, unknown> },
  ) {
    this.authorize(token);
    if (!body.result || typeof body.result !== 'object') throw new UnauthorizedException('Нет результата');
    return this.tasks.complete(id, body.result);
  }

  @Post('tasks/:id/fail')
  fail(
    @Headers('x-sales-broker-token') token: string | undefined,
    @Param('id') id: string,
    @Body() body: { error?: string },
  ) {
    this.authorize(token);
    return this.tasks.fail(id, body.error || 'Codex завершился с ошибкой');
  }

  private authorize(token?: string) {
    const expected = process.env.SALES_BROKER_TOKEN || '';
    const left = Buffer.from(token || '');
    const right = Buffer.from(expected);
    if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) throw new UnauthorizedException();
  }
}
