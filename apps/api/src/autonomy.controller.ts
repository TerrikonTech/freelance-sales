import { BadRequestException, Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AutonomyPolicyConfig, AutonomyService } from './autonomy.service';
import { DatabaseService } from './database.service';

@Controller('api/autonomy')
@UseGuards(AuthGuard)
export class AutonomyController {
  constructor(
    private readonly autonomy: AutonomyService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  async status() {
    const [policy, pausedClients, recentDecisions, uncertainDeliveries] = await Promise.all([
      this.autonomy.getPolicy(),
      this.db.query(
        `SELECT s.lead_id,l.title,s.reason,s.updated_at
         FROM autonomy_client_state s JOIN leads l ON l.id=s.lead_id
         WHERE s.paused=true ORDER BY s.updated_at DESC LIMIT 100`,
      ),
      this.db.query(
        `SELECT d.*,l.title AS lead_title
         FROM autonomy_decisions d JOIN leads l ON l.id=d.lead_id
         ORDER BY d.created_at DESC LIMIT 100`,
      ),
      this.db.query(
        `SELECT o.*,l.title AS lead_title
         FROM outbound_deliveries o JOIN leads l ON l.id=o.lead_id
         WHERE o.status='send_unknown' ORDER BY o.updated_at DESC LIMIT 100`,
      ),
    ]);
    return {
      policy,
      pausedClients: pausedClients.rows,
      recentDecisions: recentDecisions.rows,
      uncertainDeliveries: uncertainDeliveries.rows,
    };
  }

  @Patch('policy')
  async policy(@Body() body: Partial<AutonomyPolicyConfig>) {
    if (body.mode !== undefined && body.mode !== 'manual' && body.mode !== 'smart') {
      throw new BadRequestException('mode должен быть manual или smart');
    }
    if (body.minAutoConfidence !== undefined && !Number.isFinite(Number(body.minAutoConfidence))) {
      throw new BadRequestException('minAutoConfidence должен быть числом');
    }
    return this.autonomy.setPolicy(body);
  }

  @Patch('leads/:id/pause')
  async pauseClient(@Param('id') id: string, @Body() body: { paused?: boolean; reason?: string }) {
    if (typeof body.paused !== 'boolean') throw new BadRequestException('paused должен быть boolean');
    await this.autonomy.pauseClient(id, body.paused, String(body.reason || ''));
    return { ok: true, paused: body.paused };
  }
}
