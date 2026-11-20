import { fetch } from 'undici';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const THROTTLE_MS = 30 * 60 * 1000; // 30 minutes

export type NotifyEvent =
  | { type: 'low_balance'; balanceTrx: number; threshold: number }
  | { type: 'webhook_failed'; orderId: string }
  | { type: 'sweep_failed'; orderId: string; reason: string }
  | { type: 'wallet_uninitialized' }
  | { type: 'late_payment'; orderId: string; txHash: string; amount: string }
  | { type: 'stuck_detected'; orderId: string; hours: number }
  | { type: 'unmatched_payment'; address: string; txHash: string; amount: string };

export class Notifier {
  private readonly telegramEnabled: boolean;
  private readonly emailEnabled: boolean;
  private readonly lastSent = new Map<string, number>();
  private readonly transporter: Transporter | null;

  constructor() {
    this.telegramEnabled = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    this.emailEnabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.ALERT_EMAIL_TO);

    if (this.emailEnabled) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      });
    } else {
      this.transporter = null;
    }

    if (this.telegramEnabled) logger.info('Notifier: Telegram channel enabled');
    if (this.emailEnabled) logger.info('Notifier: Email channel enabled');
    if (!this.telegramEnabled && !this.emailEnabled) {
      // In production, a silent alerting pipeline is a real operational risk —
      // low-balance and sweep-failed events would only surface in logs. In
      // dev/test this is the normal default, so we keep the softer level there.
      const msg =
        'Notifier: No channels configured — alerts will be log-only. ' +
        'Set TELEGRAM_* or SMTP_* env vars to enable delivery.';
      if (env.NODE_ENV === 'production') {
        logger.warn(msg);
      } else {
        logger.info(msg);
      }
    }
  }

  async notify(event: NotifyEvent): Promise<void> {
    const dedupKey = this.getDedupKey(event);
    if (this.shouldThrottle(dedupKey)) return;

    const { subject, message } = this.formatEvent(event);

    const results: PromiseSettledResult<boolean>[] = await Promise.allSettled([
      this.telegramEnabled ? this.sendTelegram(message) : Promise.resolve(false),
      this.emailEnabled ? this.sendEmail(subject, message) : Promise.resolve(false),
    ]);

    // Only record dedup timestamp if at least one channel delivered successfully,
    // otherwise a transient outage would silence the alert for 30 minutes.
    const anyDelivered = results.some((r) => r.status === 'fulfilled' && r.value === true);
    if (anyDelivered) {
      this.lastSent.set(dedupKey, Date.now());
    }
  }

  private getDedupKey(event: NotifyEvent): string {
    switch (event.type) {
      case 'low_balance':
        return 'low_balance';
      case 'webhook_failed':
        return `webhook_failed:${event.orderId}`;
      case 'sweep_failed':
        return `sweep_failed:${event.orderId}`;
      case 'wallet_uninitialized':
        return 'wallet_uninitialized';
      case 'late_payment':
        return `late_payment:${event.txHash}`;
      case 'stuck_detected':
        return `stuck_detected:${event.orderId}`;
      case 'unmatched_payment':
        return `unmatched_payment:${event.txHash}`;
    }
  }

  private shouldThrottle(dedupKey: string): boolean {
    const last = this.lastSent.get(dedupKey);
    if (!last) return false;
    return Date.now() - last < THROTTLE_MS;
  }

  private formatEvent(event: NotifyEvent): { subject: string; message: string } {
    switch (event.type) {
      case 'low_balance':
        return {
          subject: 'PayWarden: Hot wallet balance low',
          message:
            `Hot wallet balance low: ${event.balanceTrx.toFixed(2)} TRX ` +
            `(threshold: ${event.threshold} TRX). Please top up.`,
        };
      case 'webhook_failed':
        return {
          subject: 'PayWarden: Webhook delivery permanently failed',
          message:
            `Webhook delivery permanently failed for order ${event.orderId}. ` +
            `Manual retry required via admin dashboard.`,
        };
      case 'sweep_failed':
        return {
          subject: 'PayWarden: Fund sweep failed',
          message:
            `Fund sweep permanently failed for order ${event.orderId}. ` +
            `Reason: ${event.reason}. Address remains allocated for manual review.`,
        };
      case 'wallet_uninitialized':
        return {
          subject: 'PayWarden: Wallet not initialized',
          message:
            'Wallet is not initialized. Call POST /api/v1/wallet/init to set up the HD wallet.',
        };
      case 'late_payment':
        return {
          subject: 'PayWarden: Late payment received',
          message:
            `Payment of ${event.amount} USDT (tx ${event.txHash}) arrived for order ` +
            `${event.orderId} which is no longer pending. Funds are recorded but not ` +
            `credited — manual review required.`,
        };
      case 'stuck_detected':
        return {
          subject: 'PayWarden: Order stuck awaiting confirmations',
          message:
            `Order ${event.orderId} has been in detected state for over ${event.hours}h ` +
            `without reaching the confirmation threshold. The transaction may have been ` +
            `reorged out — manual review required.`,
        };
      case 'unmatched_payment':
        return {
          subject: 'PayWarden: Unmatched payment received',
          message:
            `${event.amount} USDT (tx ${event.txHash}) arrived at ${event.address} but no ` +
            `order can be credited automatically. Review the unmatched transfer ` +
            `through the admin API and claim it to the correct order manually.`,
        };
    }
  }

  private async sendTelegram(message: string): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: message,
          // plain text: no parse_mode, avoids Markdown escaping pitfalls with
          // unpredictable content like order IDs and error messages.
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error({ status: res.status, body }, 'Telegram notification failed');
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, 'Telegram notification error');
      return false;
    }
  }

  private async sendEmail(subject: string, body: string): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({
        from: env.SMTP_FROM ?? env.SMTP_USER,
        to: env.ALERT_EMAIL_TO,
        subject,
        text: body,
      });
      return true;
    } catch (err) {
      logger.error({ err }, 'Email notification error');
      return false;
    }
  }
}
