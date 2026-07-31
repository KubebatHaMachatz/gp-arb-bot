/**
 * Single-writer lock, held as a bound TCP port on loopback.
 *
 * Two scanner processes on the same venue is not a loud failure — both connect, both
 * price the same books, and both write to `opportunities`. The table then double-counts
 * every row, which corrupts exactly the numbers the Phase 1 gate is decided on: the
 * opportunity *rate* doubles while nothing about the market changed. Nothing crashes, so
 * the only symptom is a dataset that reads as twice as good as reality.
 *
 * A bound port rather than a pidfile, because the failure modes differ where it matters:
 * a pidfile outlives the process that wrote it, so a `SIGKILL`, a panic, or a power cut
 * leaves a stale lock that blocks the next start until a human deletes it. The kernel
 * reclaims a listening socket when the process dies, however it dies. The lock is
 * therefore self-healing on crash, and false-negatives (refusing to start when nothing is
 * running) are impossible.
 *
 * Loopback only. A lock port answering on a routable interface is a service nobody
 * intended to publish, and `listen(port)` with the host argument omitted binds `0.0.0.0`
 * — the wrong default is one missing argument away, so the host is always explicit.
 */

import { createServer } from 'node:net';

/** The only interface a lock may bind. */
export const LOOPBACK = '127.0.0.1';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Is this error the kernel saying "someone else already holds that port"?
 *
 * Narrow on purpose. `EACCES` (a privileged port) and `EADDRNOTAVAIL` (an interface that
 * does not exist) are configuration problems, and reporting them as "already running"
 * sends the operator hunting for a process that was never there while the real cause goes
 * unmentioned.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAddressInUse(err) {
  return Boolean(err) && typeof err === 'object' && err.code === 'EADDRINUSE';
}

/**
 * Acquire the singleton lock for one writer process.
 *
 * @param {{port: number, label: string, host?: string, hint?: string|null,
 *          createServerImpl?: Function}} opts
 *   `label` names the process in the refusal message — it is the whole of what an
 *   operator sees when a start is refused, so it is required rather than defaulted.
 *   `hint` names the env var that would move the port, when there is one.
 *   `createServerImpl` is a test seam; production callers never pass it.
 * @returns {Promise<{port: number, host: string, released: boolean,
 *                    address: () => object, release: () => Promise<void>}>}
 * @throws {TypeError} on an unusable port or label
 * @throws {Error} `code: 'EADDRINUSE'` when another instance holds the port; any other
 *   listen error propagates with its original code and message
 */
export async function acquireLock({
  port,
  label,
  host = LOOPBACK,
  hint = null,
  createServerImpl = createServer,
}) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new TypeError(
      `port must be an integer in ${MIN_PORT}..${MAX_PORT}, got ${String(port)}`,
    );
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new TypeError(`label must be a non-empty string, got ${String(label)}`);
  }

  const server = createServerImpl();

  // Drop anything that connects. The port is a mutex, not an endpoint; without this a
  // probe or a port scanner parks an open socket on a process whose job is elsewhere.
  server.on('connection', (socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    let settled = false;

    const onError = (err) => {
      if (settled) return;
      settled = true;
      if (isAddressInUse(err)) {
        const suffix = hint ? ` Change ${hint} or stop the other process.` : '';
        const refusal = new Error(
          `${label} is already running: ${host}:${port} is held by another process.${suffix}`,
        );
        refusal.code = 'EADDRINUSE';
        refusal.cause = err;
        reject(refusal);
        return;
      }
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      // Past this point an error must not resurface as an unhandled 'error' event and
      // take the scanner down — the lock failing is never worth losing the measurement.
      server.on('error', () => {});
      resolve();
    });
  });

  // The lock must not be the reason a process stays alive. A scanner that has cleared
  // its timers and closed its socket should exit; if the lock held the event loop open
  // it would linger as a zombie, still holding the port, blocking every future start.
  server.unref();

  const handle = {
    port,
    host,
    released: false,
    address: () => server.address(),
    release() {
      if (handle.released) return Promise.resolve();
      handle.released = true;
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };

  return handle;
}
