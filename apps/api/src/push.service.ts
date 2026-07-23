import { Injectable, Logger } from '@nestjs/common';
import webpush, { PushSubscription } from 'web-push';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';

type BrowserSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(private readonly db: DatabaseService, private readonly settings: SettingsService) {}

  async status() {
    const publicKey = await this.configure();
    const count = Number((await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM push_subscriptions')).rows[0]?.count || 0);
    return { supported: true, publicKey, subscriptions: count };
  }

  async subscribe(subscription: BrowserSubscription, userAgent = '') {
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      throw new Error('Некорректная push-подписка');
    }
    await this.configure();
    await this.db.query(
      `INSERT INTO push_subscriptions(endpoint,p256dh,auth,user_agent,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,
       user_agent=EXCLUDED.user_agent,updated_at=now()`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent.slice(0, 500)],
    );
    return { ok: true };
  }

  async unsubscribe(endpoint: string) {
    await this.db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    return { ok: true };
  }

  async notify(title: string, body: string, url = '/sales/') {
    const subscriptions = (await this.db.query<{ endpoint: string; p256dh: string; auth: string }>(
      'SELECT endpoint,p256dh,auth FROM push_subscriptions ORDER BY updated_at DESC',
    )).rows;
    if (!subscriptions.length) return { sent: 0 };
    await this.configure();
    const payload = JSON.stringify({ title, body, url, tag: `sales-${Date.now()}` });
    let sent = 0;
    for (const item of subscriptions) {
      const subscription: PushSubscription = {
        endpoint: item.endpoint,
        keys: { p256dh: item.p256dh, auth: item.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 300, urgency: 'high' });
        sent += 1;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await this.db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [item.endpoint]);
        } else {
          this.logger.warn(`Push delivery failed: ${statusCode || 'unknown'}`);
        }
      }
    }
    return { sent };
  }

  private async configure(): Promise<string> {
    let publicKey = await this.settings.getPublic<string>('push_vapid_public');
    let privateKey = await this.settings.getSecret('push_vapid_private');
    if (!publicKey || !privateKey) {
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      await this.settings.setPublic('push_vapid_public', publicKey);
      await this.settings.setSecret('push_vapid_private', privateKey);
    }
    if (!this.configured) {
      webpush.setVapidDetails('mailto:admin@31-77-76-226.sslip.io', publicKey, privateKey);
      this.configured = true;
    }
    return publicKey;
  }
}
