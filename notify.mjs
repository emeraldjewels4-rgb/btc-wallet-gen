/**
 * Slack alerting shared by the treasury tools.
 *
 * Alerts go to Slack incoming webhooks. One webhook is enough
 * (SLACK_WEBHOOK_URL), but refusals and low-treasury warnings can each be sent
 * to their own channel by setting SLACK_ALERT_WEBHOOK_URL and
 * SLACK_WARNING_WEBHOOK_URL - a Slack incoming webhook is bound to one channel,
 * so "a separate channel" means a separate URL.
 *
 * Routing is derived from the alert key, so call sites cannot disagree:
 *   refused:*  -> alert channel   (high severity)
 *   stale:*    -> alert channel   (high severity, dead-man's switch)
 *   low:*      -> warning channel (medium severity)
 *   anything   -> default channel (refill sent, daily summary)
 *
 * A dedicated URL that is not set falls back to the default webhook, so existing
 * single-webhook setups keep working. With no webhook at all the notifier is
 * disabled and every call is a no-op. A failing or slow webhook never blocks or
 * fails a refill: notification problems are logged and swallowed.
 *
 * Each URL can also come from a file: set SLACK_WEBHOOK_FILE,
 * SLACK_ALERT_WEBHOOK_FILE or SLACK_WARNING_WEBHOOK_FILE to a path holding just
 * the URL. A *_FILE value wins over the inline URL, and the file is read at run
 * time so the secret can live outside the project. Paths are safe to report; the
 * URL inside is never logged.
 *
 * Identical alerts are suppressed for a cooldown window (default 15 minutes) so
 * a --watch loop stuck on the same refusal does not spam the channel. Webhook
 * URLs are secrets and are never logged.
 */

import { readFileSync } from 'node:fs';

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

// Resolve one webhook URL: SLACK_X_FILE (a path) wins over SLACK_X. Throws with
// the path, never the value, when the file cannot be read or is empty.
export function resolveWebhook(env, urlVar) {
  // SLACK_WEBHOOK_URL -> SLACK_WEBHOOK_FILE (drop the _URL suffix).
  const fileVar = `${urlVar.replace(/_URL$/, '')}_FILE`;
  const filePath = env[fileVar];
  if (filePath) {
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`cannot read ${fileVar} (${filePath}): ${err?.code ?? err?.message ?? err}`);
    }
    const value = raw.trim();
    if (!value) throw new Error(`${fileVar} (${filePath}) is empty`);
    return value;
  }
  return env[urlVar] || null;
}

export function resolveSlackWebhooks(env = process.env) {
  return {
    webhookUrl: resolveWebhook(env, 'SLACK_WEBHOOK_URL'),
    alertWebhookUrl: resolveWebhook(env, 'SLACK_ALERT_WEBHOOK_URL'),
    warningWebhookUrl: resolveWebhook(env, 'SLACK_WARNING_WEBHOOK_URL'),
  };
}

function routeFor(key) {
  if (key.startsWith('refused:') || key.startsWith('stale:')) return 'alert';
  if (key.startsWith('low:')) return 'warning';
  return 'default';
}

export function createSlackNotifier({
  webhookUrl,
  alertWebhookUrl,
  warningWebhookUrl,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  log = () => {},
} = {}) {
  const routes = {
    alert: alertWebhookUrl || webhookUrl || null,
    warning: warningWebhookUrl || webhookUrl || null,
    default: webhookUrl || null,
  };
  const enabled = Boolean(routes.alert || routes.warning || routes.default);
  const lastSentAt = new Map();

  function channelName(route) {
    if (!routes[route]) return 'off';
    if (route === 'alert') return alertWebhookUrl ? 'alert channel' : 'default channel';
    if (route === 'warning') return warningWebhookUrl ? 'warning channel' : 'default channel';
    return 'default channel';
  }

  function describe() {
    if (!enabled) return 'slack alerts disabled (no webhook configured)';
    return (
      `slack alerts enabled (refusals -> ${channelName('alert')}, ` +
      `low treasury -> ${channelName('warning')}, sends/summary -> ${channelName('default')})`
    );
  }

  async function alert(key, text) {
    const route = routeFor(key);
    const url = routes[route];
    if (!url) {
      log(`alert skipped: no ${route} channel configured (${key})`);
      return 'disabled';
    }

    const now = Date.now();
    const previous = lastSentAt.get(key) ?? 0;
    if (now - previous < cooldownMs) {
      log(`alert suppressed by cooldown: ${key} (${route})`);
      return 'suppressed';
    }
    lastSentAt.set(key, now);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        log(`alert failed: ${route} webhook returned HTTP ${res.status}`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      log(`alert failed: ${route} webhook ${err?.message ?? err}`);
      return 'failed';
    }
  }

  return { enabled, describe, alert };
}
