# ORB15 live-vs-backtest review and exit study (proposed `bt27`) — DRAFT

Status: **study proposal only, not approved, not built.** Drafted 2026-11-18 after the first review of live ORB results. The two engineering fixes in section 4 (signal detection, bid/spread logging) were approved and deployed the same day (commit `7d78f9b`); ORB entry/exit rules are unchanged. Verified facts, assumptions and proposals are kept separate below.

## 1. Verified facts (from Supabase journal, `bt13`, repo code, Alpaca bars, Render deploys)

**Live ORB trades (Nov 11-18): 7 trades, net -$279.** Two (Nov 11) are the old 5-minute version. The 5 on the 15-minute version net -$51: -107 (QQQ premium stop), -76 (SPY "breakeven"), +263 (QQQ target), -38 (SPY "breakeven"), -93 (QQQ premium stop). All 6 losers were up at least +17% at peak; 4 were up +28% or more; both "breakeven" exits were up +39-51% at peak and finished -18% to -32%.

**Backtest `bt13` for the live config (e15, 1.25R, BE 0.5R):** QQQ train n=449 avg $9.49 PF 1.18; lock n=214 avg $9.07 PF 1.11. SPY train n=452 avg $7.50 PF 1.19; lock n=215 avg $8.99 PF 1.17. Win rate 36-38%. Exit mix: stop 26-28% (avg -$98 to -$132), "breakeven" 27-31% (avg -$28 to -$39, ~16% win), target 21-27% (avg +$164 to +$251), time ~14-26% (avg ~0).

**Edge fragility:** removing only the single best trade in each bucket cuts the average to about $2.8 (QQQ lock), $5.4 (QQQ train), $4.0 (SPY train), $3.9 (SPY lock). Without the 0.5R breakeven rule (be0) the lock-period average is only +$2.10 (QQQ) / +$2.87 (SPY). Config was chosen from a grid of about 24 variants after seeing results. Trade-level rows were not saved, so drop-best-5 was never run.

**Live vs `bt13` rule differences (from `server.js` and `study_orb15.js`):**
1. Live applies a **-50% premium stop** (`exitReason`); `bt13` has no premium stop. 3 of 7 live trades exited this way, each at -50%. The backtest never validated this rule.
2. Cost model: `bt13` uses option trade prices with $0.01 per fill each way; live pays the ask and receives the bid. Before 2026-11-18 live trade rows did not store entry bid, so real spread cost was unmeasured (now logged, see section 4).
3. Correlation cap ($500) blocked 2 of 7 ORB signals (QQQ Nov 16, SPY Nov 17); the backtest is unconstrained.
4. Signal detection (before the Nov 18 fix): live only acted if the **last** 1-minute bar was exactly the 15-minute candle-close minute, and any later candle returned null once an earlier close had broken out. A server restart or slow tick at that minute silently lost the symbol for the day, with no log line.
5. Entry window: live and `bt13` are **the same** here. Both allow the last candle that starts 15:00 (closes minute 914 = 15:14 ET, entry about 15:15). An earlier draft of this document said live stopped at a 15:00 entry; that was wrong.

**Signal frequency:** checked against Alpaca IEX 15-minute bars for Nov 12-18, the 15-minute rules should have fired on 10 of 10 symbol-sessions. Live logged 7 (5 entered, 2 cap-blocked). The 3 missing: QQQ and SPY on Nov 13 (first-candle breakouts at 10:00 ET) and SPY on Nov 12 (breakout at 10:45 ET). Nov 13: the server was in an OOM crash loop (restart about every 7 minutes) from about 5:54 AM CT until fixes deployed about 9:24-9:32 AM CT, and the 10:00 ET candle (9:00 AM CT) fell inside it. This is consistent with the miss but not proven. Nov 12 SPY is **unexplained**. Nov 16-18: 6 of 6 signals detected. **Caveat:** this check used Alpaca IEX bars, while live trading reads Robinhood minute bars, so a candle can break out on one feed and not the other; the comparison is indicative, not exact. `bt13` skipped only about 9 of ~1,340 symbol-sessions for "no breakout", so live should fire about once per symbol per session.

## 2. Assumptions and unknowns
- Per-trade standard deviation is roughly $150 (estimate from the exit mix, not computed from trade rows). At that level, ~1,000 trades would be needed to separate a $9 average from zero. Forward paper trading therefore checks execution and frequency, not the edge.
- Whether the premium stop helps or hurts on average is unknown; it caps -50% losses but also cuts trades that would recover.
- Real 0DTE bid/ask width at entry is unknown until the new logging accumulates trades.

## 3. Proposed study `bt27` (read-only, no trading effect) — NOT APPROVED, NOT BUILT

Reuse `study_orb15.js` (real Alpaca option bars, SPY/QQQ, Mar 2024 to date). **Save trade-level rows** to a separate kv key so drop-best-5 and bootstrap checks need no rerun.

**Baseline L0 = exact live rules** (e15, 1.25R, BE 0.5R, plus -50% premium stop on option close). Compare L0 with `bt13`'s no-premium-stop result first: if L0 is materially worse, the adopted edge was never validated under the live rule set.

**Pre-registered variants (fixed now; no tuning after seeing results; count logged = 9 plus baseline, x2 symbols):**
- V1: no premium stop (reproduces `bt13`; control)
- V2: premium stop at -35%
- V3: premium lock: once option close >= +30% over entry, move the stop to entry premium (replaces the underlying-based breakeven; underlying stop and target kept)
- V4: as V3 with a +50% trigger
- V5: premium trail reusing X9's already-tested parameters (arm +25%, give back 50% of peak gain); no new parameters
- V6: skip entries after 10:45 ET
- V7: skip entries after 11:30 ET
- V8: skip when opening range % is in the top decile of the **training** period
- V9: V3 plus the better of V6/V7 only if both V3 and that filter pass alone (no other combinations)

**Cost stress:** report every variant at $0.01 and $0.03 per leg. Once about 15 live ORB trades carry real spread data, compare the measured round-trip spread to these assumptions.

**Splits:** dev = 2024-03 to 2025-12; confirmation = 2026-01 to 2026-11-11. The confirmation period was already used to choose the live config, so it is **not an untouched holdout**; label it that way. Add 4 chronological blocks for sign consistency. True holdout = forward paper from the freeze date.

**A variant replaces the live rule only if all hold:**
1. Average per trade improves by at least $5 vs L0 in all four symbol x period cells.
2. Paired-by-day bootstrap 95% interval for the improvement excludes zero in the pooled sample.
3. Still positive after dropping its best 5 trades.
4. Improvement survives $0.03 per leg.
5. At least 100 trades per symbol per period after any entry filter.

If none pass, the live config stays and the honest L0 result is reported. If L0 is at or below zero under cost stress, the question of pausing ORB goes to James; nothing is changed automatically.

## 4. Engineering fixes — APPROVED AND DEPLOYED 2026-11-18 (commit `7d78f9b`, Render deploy live 18:34Z)
- DONE: `orb15.js` (new, unit-tested in `test/orb15_detect.test.js`) scans all closed 15-minute candles and returns the first breakout; `orb15Sig` uses it. A stale signal (older than 150 s) is logged as a skip. An opening range with fewer than 15 one-minute bars logs a skip and retries each tick.
- DONE: ORB trade rows now store `entryBid`, `exitAsk`, `spreadIn`, `spreadOut`, `delta`, `iv`.
- Tests: new detection test and the four existing suites pass (synthetic data only; no live-path integration test was run).
- STILL OPEN: priority rule for the correlation cap so ORB is not routinely blocked by other books' risk (FP is now retired, which reduces this).

## 5. Forward monitoring (not an edge test)
Track exit-mix vs backtest, signals per symbol-session (expect about 1; every missed signal should now appear as a logged skip), and real fill cost vs assumptions. Do not judge by win count. Project floor of 100 closed trades per strategy still applies.

## 6. Open decisions for James
1. Approve building `bt27` as specified (pending).
2. ~~Approve the `orb15Sig` robustness fix and entry-bid logging~~ — approved and deployed 2026-11-18.
3. Keep ORB running unchanged while `bt27` is decided/run (recommended; no rule changes made).
