import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier, redactSecret } from '../lib/notify.mjs';

const TOKEN = '123456789:AAHfake-Token-Value-For-Tests';
const CHAT = '-1001234567890';

/** Collect log lines so a test can assert on what an operator would have seen. */
function recorder() {
  const lines = [];
  return { lines, log: (...parts) => lines.push(parts.map(String).join(' ')) };
}

/** A fetch stub that records calls and replies however the test wants. */
function fetchStub(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return { calls, impl };
}

const ok = () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });

// ── redactSecret ────────────────────────────────────────────────────────────

test('redactSecret removes every occurrence of the secret', () => {
  assert.equal(redactSecret(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a <redacted> b <redacted>');
});

test('redactSecret is a no-op when there is no secret to hide', () => {
  assert.equal(redactSecret('plain text', null), 'plain text');
  assert.equal(redactSecret('plain text', ''), 'plain text');
  assert.equal(redactSecret('plain text', undefined), 'plain text');
});

test('redactSecret treats the secret literally, not as a pattern', () => {
  // A token is arbitrary bytes. Building a RegExp from it unescaped would either throw
  // on an unbalanced bracket or, worse, match the wrong span and leave the real secret
  // in the log while looking like it redacted something.
  assert.equal(redactSecret('a b.c d', 'b.c'), 'a <redacted> d');
  assert.equal(redactSecret('a bXc d', 'b.c'), 'a bXc d', 'the dot is a dot, not "any char"');
  assert.equal(redactSecret('keep (a) here', '(a)'), 'keep <redacted> here');
});

test('redactSecret coerces a non-string subject rather than throwing', () => {
  assert.equal(redactSecret(undefined, TOKEN), 'undefined');
  assert.equal(redactSecret(new Error('boom'), TOKEN), 'Error: boom');
});

// ── inertness ───────────────────────────────────────────────────────────────

test('the notifier is inert unless BOTH the token and the chat id are set', async () => {
  for (const [botToken, chatId, why] of [
    [undefined, undefined, 'neither'],
    [TOKEN, undefined, 'token only'],
    [undefined, CHAT, 'chat only'],
    [TOKEN, '', 'blank chat'],
    ['', CHAT, 'blank token'],
    ['   ', CHAT, 'whitespace token'],
    [TOKEN, '   ', 'whitespace chat'],
  ]) {
    const { calls, impl } = fetchStub(ok());
    const n = createNotifier({ botToken, chatId, fetchImpl: impl, log: () => {} });
    assert.equal(n.enabled, false, why);
    assert.equal(await n.send('hello'), false, why);
    assert.equal(calls.length, 0, `${why}: must not call out`);
  }
});

test('half-configured alerting says so once, at construction', () => {
  // Silent inertness is the trap: the operator believes they are covered and finds out
  // during the incident that no alert was ever going to arrive.
  const rec = recorder();
  createNotifier({ botToken: TOKEN, chatId: undefined, fetchImpl: async () => ok(), log: rec.log });
  assert.equal(rec.lines.length, 1);
  assert.match(rec.lines[0], /GPA_TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(rec.lines[0], /AAHfake/, 'and never quotes the token while doing it');
});

test('fully unconfigured alerting is silent — that is a deliberate choice, not a mistake', () => {
  const rec = recorder();
  const n = createNotifier({ fetchImpl: async () => ok(), log: rec.log });
  assert.equal(n.enabled, false);
  assert.deepEqual(rec.lines, []);
});

// ── the configured path ─────────────────────────────────────────────────────

test('a configured notifier posts the message to the right chat', async () => {
  const { calls, impl } = fetchStub(ok());
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: () => {} });

  assert.equal(n.enabled, true);
  assert.equal(await n.send('feed stalled'), true);
  assert.equal(calls.length, 1);

  const { url, init } = calls[0];
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { chat_id: CHAT, text: 'feed stalled' });
});

test('the request carries an abort signal so a hung Telegram cannot wedge the watchdog', async () => {
  const { calls, impl } = fetchStub(ok());
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: () => {} });
  await n.send('x');
  assert.ok(calls[0].init.signal, 'no signal means an unbounded wait');
});

test('an empty message is refused rather than sent as a blank alert', async () => {
  const { calls, impl } = fetchStub(ok());
  const rec = recorder();
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: rec.log });
  assert.equal(await n.send('   '), false);
  assert.equal(calls.length, 0);
});

// ── failure reporting: never throw, always report ───────────────────────────

test('an HTTP error is reported and returns false, never throws', async () => {
  const rec = recorder();
  const { impl } = fetchStub({ ok: false, status: 401, text: async () => 'Unauthorized' });
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: rec.log });

  assert.equal(await n.send('hi'), false);
  assert.equal(rec.lines.length, 1);
  assert.match(rec.lines[0], /401/);
  assert.match(rec.lines[0], /Unauthorized/);
});

test('a thrown fetch is reported and returns false, never throws', async () => {
  const rec = recorder();
  const n = createNotifier({
    botToken: TOKEN,
    chatId: CHAT,
    log: rec.log,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED api.telegram.org');
    },
  });

  assert.equal(await n.send('hi'), false);
  assert.match(rec.lines[0], /ECONNREFUSED/);
});

test('a notifier failure is reported even when its own logger throws', async () => {
  // The notifier is what reports other failures; it must not become a new source of them.
  const n = createNotifier({
    botToken: TOKEN,
    chatId: CHAT,
    log: () => {
      throw new Error('logger exploded');
    },
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(await n.send('hi'), false);
});

// ── the token must never reach a log ────────────────────────────────────────

test('the bot token never appears in a log line, even when the error quotes the URL', async () => {
  // fetch failures routinely embed the request URL, and the Telegram token lives IN the
  // URL path. Logging the raw error is therefore how a token ends up in a plaintext log
  // file, or in a screenshot of one.
  const rec = recorder();
  const n = createNotifier({
    botToken: TOKEN,
    chatId: CHAT,
    log: rec.log,
    fetchImpl: async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
    },
  });

  await n.send('hi');
  assert.equal(rec.lines.length, 1);
  assert.doesNotMatch(rec.lines[0], /AAHfake/);
  assert.match(rec.lines[0], /<redacted>/);
});

test('a token echoed in the response body is redacted too', async () => {
  const rec = recorder();
  const { impl } = fetchStub({ ok: false, status: 404, text: async () => `bad token ${TOKEN}` });
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: rec.log });
  await n.send('hi');
  assert.doesNotMatch(rec.lines[0], /AAHfake/);
});

test('an unreadable response body still yields a reported failure', async () => {
  const rec = recorder();
  const { impl } = fetchStub({
    ok: false,
    status: 500,
    text: async () => {
      throw new Error('stream already consumed');
    },
  });
  const n = createNotifier({ botToken: TOKEN, chatId: CHAT, fetchImpl: impl, log: rec.log });
  assert.equal(await n.send('hi'), false);
  assert.match(rec.lines[0], /500/);
});
