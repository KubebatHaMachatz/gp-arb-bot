/**
 * Telegram alerting — the only outbound channel in Phase 1.
 *
 * Three properties, in priority order:
 *
 * 1. **Inert unless fully configured.** Both `GPA_TELEGRAM_BOT_TOKEN` and
 *    `GPA_TELEGRAM_CHAT_ID` must be present. A half-configured notifier says so once at
 *    construction, because silent inertness is the trap: the operator believes they are
 *    covered and discovers during the incident that no alert was ever going to arrive.
 * 2. **Never throws.** This module is what reports other failures. If it could throw it
 *    would become a new source of them, and an alerting bug would take down the watchdog
 *    whose whole purpose is to still be running when everything else is not.
 * 3. **Always reports its own failures.** A notifier that silently fails to notify is
 *    worse than no notifier — it converts "no alerts because nothing is wrong" and "no
 *    alerts because alerting is broken" into the same observation.
 *
 * The token lives in the request **URL path**, and fetch failures routinely quote the URL
 * they were attempting. Logging a raw error is therefore exactly how a bot token ends up
 * in a plaintext log — so every string this module logs goes through `redactSecret`
 * first, on both the error path and the response-body path.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Trim to null, matching `lib/config.mjs`: blank and whitespace-only mean UNSET. */
function trimmedOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Replace every occurrence of `secret` in `text` with a placeholder.
 *
 * The secret is matched **literally**. Compiling it into a RegExp would be a bug in two
 * directions: an unbalanced bracket throws, and a token containing `.` or `+` would match
 * a span other than itself — redacting the wrong characters while leaving the real secret
 * in place, which reads exactly like it worked.
 *
 * @param {unknown} text coerced to a string, so an Error may be passed directly
 * @param {string|null|undefined} secret
 * @returns {string}
 */
export function redactSecret(text, secret) {
  const subject = String(text);
  if (!secret) return subject;
  return subject.split(String(secret)).join('<redacted>');
}

/**
 * Build a notifier bound to one chat.
 *
 * @param {{botToken?: string, chatId?: string, log?: Function, fetchImpl?: Function,
 *          timeoutMs?: number, apiBase?: string}} [opts]
 * @returns {{enabled: boolean, send: (text: string) => Promise<boolean>}}
 */
export function createNotifier({
  botToken,
  chatId,
  log = console.error,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiBase = TELEGRAM_API_BASE,
} = {}) {
  const token = trimmedOrNull(botToken);
  const chat = trimmedOrNull(chatId);
  const enabled = token !== null && chat !== null;

  /** Log without ever becoming a failure itself, and never carrying the token. */
  const safeLog = (...parts) => {
    try {
      log(...parts.map((p) => redactSecret(p, token)));
    } catch {
      // A logger that throws must not escalate into an unhandled rejection inside the
      // watchdog. There is nowhere left to report this, which is precisely why it is
      // swallowed rather than rethrown.
    }
  };

  if (!enabled && (token !== null || chat !== null)) {
    const missing = token === null ? 'GPA_TELEGRAM_BOT_TOKEN' : 'GPA_TELEGRAM_CHAT_ID';
    safeLog(`notify: alerting is DISABLED — ${missing} is unset (the other half is set)`);
  }

  return {
    enabled,

    /**
     * Send one message. Resolves `true` only on a 2xx.
     *
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async send(text) {
      if (!enabled) return false;
      const body = trimmedOrNull(text);
      if (body === null) return false;

      try {
        const res = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: body }),
          // Without a deadline a hung Telegram parks the watchdog's send forever, and the
          // next staleness check never runs — the monitor stops monitoring.
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) return true;

        let detail = '';
        try {
          detail = await res.text();
        } catch {
          // The status alone is still worth reporting; an unreadable body is not a
          // reason to drop the whole failure on the floor.
          detail = '<unreadable body>';
        }
        safeLog(`notify: telegram rejected the send — HTTP ${res.status} ${detail}`);
        return false;
      } catch (err) {
        safeLog(`notify: send failed — ${err?.message ?? String(err)}`);
        return false;
      }
    },
  };
}
