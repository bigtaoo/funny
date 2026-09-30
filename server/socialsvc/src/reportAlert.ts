// UGC report → ops webhook alert (App Store Review Guideline 1.2: "the developer must act on objectionable
// content reports within 24 hours", and blocking must also notify the developer). Every new ReportDoc —
// player report or block — is posted to NW_ALERT_WEBHOOK_URL, the same Slack/Discord/WeCom hook metaserver's
// crash alerts use. Fire-and-forget: the report is already persisted before this runs, and a webhook outage
// must never fail (or slow down) the player's request — the admin queue remains the source of truth.
import { postAlertWebhook } from '@nw/shared';
import type { ReportDoc } from './db';

/** Chars of the content snapshot quoted in the alert (the full snapshot is in the admin queue). */
export const ALERT_SNAPSHOT_PREVIEW = 200;

export interface ReportAlertInfo {
  report: ReportDoc;
  targetPublicId?: string;
  targetName?: string;
  reporterPublicId?: string;
}

export interface ReportAlerter {
  /** Never throws; returns immediately (delivery happens in the background). */
  notify(info: ReportAlertInfo): void;
}

export const nullReportAlerter: ReportAlerter = { notify: () => {} };

export function formatReportAlert(info: ReportAlertInfo): string {
  const r = info.report;
  const kind = r.source === 'block' ? 'Player blocked' : 'Player report';
  const who = info.targetPublicId
    ? `${info.targetName ?? '?'} (${info.targetPublicId})`
    : r.targetId;
  const lines = [
    `[NW socialsvc] ${kind} ${r._id} — act within 24h (remove content / ban) in ops → Reports`,
    `target: ${who}` + (info.reporterPublicId ? `  reporter: ${info.reporterPublicId}` : ''),
    `category: ${r.category ?? '-'}  channel: ${r.contentRef?.kind === 'content' ? r.contentRef.channel : r.contentRef?.kind ?? '-'}`,
  ];
  if (r.reason) lines.push(`reason: ${r.reason.slice(0, ALERT_SNAPSHOT_PREVIEW)}`);
  const snap = r.contentRef?.kind === 'content' || r.contentRef?.kind === 'name' ? r.contentRef.snapshot : undefined;
  if (snap) {
    const clipped = snap.length > ALERT_SNAPSHOT_PREVIEW ? `${snap.slice(0, ALERT_SNAPSHOT_PREVIEW)}…` : snap;
    lines.push(`content: "${clipped}"`);
  }
  return lines.join('\n');
}

export function createReportAlerter(opts: {
  webhookUrl: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ReportAlerter {
  const { webhookUrl } = opts;
  if (!webhookUrl) return nullReportAlerter;
  return {
    notify(info) {
      let text: string;
      try {
        text = formatReportAlert(info);
      } catch {
        return;
      }
      void postAlertWebhook(webhookUrl, text, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    },
  };
}
