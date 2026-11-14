'use strict';
/* Safety tests for ai_overlay.js, ported from the Python prototype's SafetyTests. Run: node test/ai_overlay.test.js */
const assert = require('assert');
const overlay = require('../ai_overlay.js');

function demoSnapshot(now) {
  now = now == null ? Date.now() / 1000 : now;
  return {
    now, market_at: now, market_open: true, symbol: 'SPY', position_units: 2,
    position_revision: 'paper-position-v1', base_exit: false, entries_allowed: true, risk_budget_usd: 40,
    candidate: null,
    facts: [
      { id: 'price_action', observed_at: now, max_age_seconds: 30, text: 'SYNTHETIC: bullish spread, two failed tests of resistance; last completed bar closed below VWAP.' },
      { id: 'position', observed_at: now, max_age_seconds: 10, text: 'SYNTHETIC: two complete debit spreads; open gain $30 total. No verified news supplied.' },
    ],
  };
}

/* Only the pure-JS validation paths are exercised here (base_exit, staleness, risk-budget, missing fields) --
   those never reach the network. A live Claude API call is deliberately NOT part of this test (no network
   dependency, no API cost); the final case below only confirms the call-path fails SAFE (DEFER) when the API
   is unreachable or rejects the key, which is the one property that matters without needing a real key. */
(async () => {
  // These paths never call the network (fail before reaching callClaude), so they're safe to run for real.
  let r = await overlay.decide(Object.assign(demoSnapshot(1000), { base_exit: true, market_at: 0 }), { clock: () => 1000 });
  assert.strictEqual(r.action, 'BASE_EXIT'); assert.strictEqual(r.close_units, 2); console.log('ok - baseline priority');

  r = await overlay.decide(Object.assign(demoSnapshot(1000), { market_at: 900 }), { clock: () => 1000 });
  assert.strictEqual(r.action, 'DEFER'); console.log('ok - stale quote defers');

  r = await overlay.decide(Object.assign(demoSnapshot(1000), { position_units: 0, entries_allowed: false }), { clock: () => 1000 });
  assert.strictEqual(r.action, 'BLOCK_ENTRY'); console.log('ok - risk flag blocks entry');

  r = await overlay.decide(Object.assign(demoSnapshot(1000), {
    position_units: 0, candidate: { id: 'a', description: 'prevalidated spread', risk_usd: 50 },
  }), { clock: () => 1000 });
  assert.strictEqual(r.action, 'BLOCK_ENTRY'); console.log('ok - over-budget candidate blocked');

  r = await overlay.decide({}, { clock: () => 1000 });
  assert.strictEqual(r.action, 'DEFER'); console.log('ok - missing fields defers');

  r = await overlay.decide(Object.assign(demoSnapshot(1000), { risk_budget_usd: NaN }), { clock: () => 1000 });
  assert.strictEqual(r.action, 'DEFER'); console.log('ok - NaN budget defers');

  // Model-call path: point at a non-routable host via a bad apiKey/short timeout so the HTTPS call itself
  // fails fast and we confirm it DEFERs rather than throwing uncaught -- doesn't hit the real API.
  r = await overlay.decide(demoSnapshot(1000), { apiKey: 'bad', model: 'bad', clock: () => 1000, httpTimeoutMs: 50 });
  assert.strictEqual(r.action, 'DEFER');
  console.log('ok - unreachable/failing API call defers (no live network dependency in this test), reason:', r.reason);

  console.log('\nAll ai_overlay.js safety checks passed.');
})().catch((e) => { console.error('TEST SUITE FAILED:', e); process.exit(1); });
