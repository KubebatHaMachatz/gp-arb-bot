import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Socket, createServer } from 'node:net';

import { LOOPBACK, acquireLock, isAddressInUse } from '../lib/singleton.mjs';

/** Bind an ephemeral port and report it, so tests never guess a free number. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ── isAddressInUse ──────────────────────────────────────────────────────────

test('isAddressInUse recognises EADDRINUSE and nothing else', () => {
  assert.equal(isAddressInUse({ code: 'EADDRINUSE' }), true);
  // EACCES is a PERMISSION problem, not a second instance. Treating it as "already
  // running" would tell an operator to go kill a process that does not exist, while the
  // real cause -- a privileged port -- stays hidden.
  assert.equal(isAddressInUse({ code: 'EACCES' }), false);
  assert.equal(isAddressInUse({ code: 'EADDRNOTAVAIL' }), false);
  assert.equal(isAddressInUse(new Error('boom')), false);
  assert.equal(isAddressInUse(null), false);
  assert.equal(isAddressInUse(undefined), false);
});

// ── acquiring ───────────────────────────────────────────────────────────────

test('acquireLock binds the requested port and reports it back', async () => {
  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test' });
  try {
    assert.equal(lock.port, port);
    assert.equal(lock.host, LOOPBACK);
  } finally {
    await lock.release();
  }
});

test('the lock binds loopback only, never a routable interface', async () => {
  // A lock port reachable from the network is a service nobody meant to expose. The
  // address is asserted rather than assumed because `listen(port)` with no host binds
  // 0.0.0.0 -- the wrong default is one omitted argument away.
  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test' });
  try {
    assert.equal(lock.address().address, LOOPBACK);
  } finally {
    await lock.release();
  }
});

test('a second acquire on a held port is refused', async () => {
  const port = await freePort();
  const first = await acquireLock({ port, label: 'scan-polymarket' });
  try {
    await assert.rejects(
      () => acquireLock({ port, label: 'scan-polymarket' }),
      (err) => {
        assert.match(err.message, /already running/);
        assert.match(err.message, new RegExp(String(port)));
        assert.match(err.message, /scan-polymarket/);
        return true;
      },
    );
  } finally {
    await first.release();
  }
});

test('the refusal message carries the hint that names the knob to change', async () => {
  const port = await freePort();
  const first = await acquireLock({ port, label: 'scan-kalshi' });
  try {
    await assert.rejects(
      () => acquireLock({ port, label: 'scan-kalshi', hint: 'GPA_LOCK_PORT_KALSHI' }),
      /GPA_LOCK_PORT_KALSHI/,
    );
  } finally {
    await first.release();
  }
});

test('releasing frees the port for the next process', async () => {
  const port = await freePort();
  const first = await acquireLock({ port, label: 'scan-test' });
  await first.release();

  // The whole point of a port lock over a pidfile: the OS reclaims it, so a crashed
  // process leaves nothing stale behind for the next start to trip over.
  const second = await acquireLock({ port, label: 'scan-test' });
  try {
    assert.equal(second.port, port);
  } finally {
    await second.release();
  }
});

test('release is idempotent, so a shutdown path may call it twice', async () => {
  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test' });
  await lock.release();
  await lock.release();
  assert.equal(lock.released, true);
});

// ── failure modes that are NOT a second instance ─────────────────────────────

test('a non-EADDRINUSE listen error propagates unchanged, not as "already running"', async () => {
  const failing = () => {
    const handlers = new Map();
    return {
      on(event, fn) {
        handlers.set(event, fn);
        return this;
      },
      once(event, fn) {
        handlers.set(event, fn);
        return this;
      },
      removeListener() {
        return this;
      },
      unref() {
        return this;
      },
      listen() {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        queueMicrotask(() => handlers.get('error')(err));
      },
      close(cb) {
        if (cb) cb();
      },
    };
  };

  await assert.rejects(
    () => acquireLock({ port: 1, label: 'scan-test', createServerImpl: failing }),
    (err) => {
      assert.equal(err.code, 'EACCES');
      assert.doesNotMatch(err.message, /already running/);
      return true;
    },
  );
});

test('the lock server is unref-ed so holding it alone cannot keep a process alive', async () => {
  // A process whose only remaining handle is its own lock is a zombie that blocks the
  // next start forever. The lock exists to exclude a second writer, not to be work.
  let unrefCalls = 0;
  const spying = () => {
    const real = createServer();
    const wrapped = Object.create(real);
    wrapped.unref = () => {
      unrefCalls += 1;
      real.unref();
      return wrapped;
    };
    return wrapped;
  };

  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test', createServerImpl: spying });
  try {
    assert.equal(unrefCalls, 1);
  } finally {
    await lock.release();
  }
});

test('a connection to the lock port is dropped rather than accumulated', async () => {
  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test' });
  try {
    // Anything that probes the port -- a health check, a port scanner, a stale client --
    // must not leave a socket parked on a process whose real job is elsewhere.
    const closed = await new Promise((resolve, reject) => {
      const client = new Socket();
      client.on('close', () => resolve(true));
      client.on('error', reject);
      client.connect(port, LOOPBACK);
    });
    assert.equal(closed, true);
  } finally {
    await lock.release();
  }
});

// ── argument validation ──────────────────────────────────────────────────────

test('acquireLock rejects a port that is not a usable integer', async () => {
  for (const bad of [undefined, null, 'a', 1.5, Number.NaN, -1, 0, 70000]) {
    await assert.rejects(
      () => acquireLock({ port: bad, label: 'scan-test' }),
      /port/,
      String(bad),
    );
  }
});

test('acquireLock rejects a missing label, which is what the operator reads on failure', async () => {
  const port = await freePort();
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(() => acquireLock({ port, label: bad }), /label/, String(bad));
  }
});

test('a socket error AFTER the lock is held does not take the process down', async () => {
  // net.Server emits 'error' as an EventEmitter error event: with no listener attached,
  // Node rethrows it as an uncaught exception and the process dies. Losing the lock's
  // socket is never worth losing the measurement run the process is collecting, so the
  // listener stays attached for the lifetime of the lock.
  let captured = null;
  const capturing = () => {
    captured = createServer();
    return captured;
  };

  const port = await freePort();
  const lock = await acquireLock({ port, label: 'scan-test', createServerImpl: capturing });
  try {
    const late = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    assert.doesNotThrow(() => captured.emit('error', late));
    assert.equal(lock.released, false, 'and the lock is still held afterwards');
  } finally {
    await lock.release();
  }
});
