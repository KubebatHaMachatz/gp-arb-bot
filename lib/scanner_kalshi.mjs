/**
 * Kalshi live scanner — poll the public events feed, price every complete set.
 *
 * READ-ONLY against the venue: no credentials, no path to an order.
 *
 * **Kalshi's measurement is structurally weaker than Polymarket's, and the numbers must
 * be read with that in mind.** Polymarket pushes book updates over a public WebSocket,
 * so a set is priced within a second of the quote changing. Kalshi's WebSocket requires
 * authentication even to connect, so the public path is a REST crawl — and a full crawl
 * of the open universe measured **54 seconds** live. The venue publishes no
 * book-freshness field (`updated_time` is the market record's mtime, seen a month old),
 * so the only honest age is when that row's page was fetched.
 *
 * The consequence is deliberate and should not be tuned away: most Kalshi sets will be
 * gated out as stale, because on a 54-second-old book they genuinely are. That is the
 * finding, not a bug — it says public REST polling cannot support this strategy here.
 * Comparing Kalshi's skip rate against Polymarket's is therefore comparing two different
 * things, which is why `docs/adapters.md` records it explicitly.
 */

/**
 * A point-in-time book store built from one crawl.
 *
 * Presents the same `top(tokenId)` surface as the Polymarket WebSocket store, so
 * `scanSets` consumes either without knowing which venue produced it.
 *
 * @param {ReadonlyArray<object>} rows normalized adapter rows carrying `fetchedAtMs`
 * @param {Map<string, object>} tops token id → `asksFromMarket` output
 * @returns {{top: Function, tokens: Function, size: number}}
 */
export function createPollStore(rows, tops) {
  const byToken = new Map();
  for (const row of rows) {
    const t = tops.get(row.tokenId);
    if (!t) continue;
    byToken.set(row.tokenId, {
      bestBid: null,
      bidSize: null,
      bestAsk: t.ask,
      askSize: t.askSize,
      // The page's own arrival time — see the module banner for why this is the only
      // defensible number, and why it makes most sets read as stale.
      ts: row.fetchedAtMs ?? null,
    });
  }
  return {
    top: (tokenId) => byToken.get(tokenId) ?? null,
    tokens: () => [...byToken.keys()],
    get size() {
      return byToken.size;
    },
  };
}

/**
 * Build the token → ask map for one event's markets.
 *
 * @param {object} event a raw event with nested markets
 * @param {(m: object) => object} asksFromMarket the adapter's reducer
 * @returns {Map<string, {ask: number|null, askSize: number|null}>}
 */
export function topsFromEvent(event, asksFromMarket) {
  const tops = new Map();
  if (event === null || typeof event !== 'object') return tops;
  const markets = Array.isArray(event.markets) ? event.markets : [];
  for (const market of markets) {
    if (typeof market?.ticker !== 'string' || market.ticker === '') continue;
    const a = asksFromMarket(market);
    tops.set(`${market.ticker}:YES`, { ask: a.yesAsk, askSize: a.yesAskSize });
    tops.set(`${market.ticker}:NO`, { ask: a.noAsk, askSize: a.noAskSize });
  }
  return tops;
}
