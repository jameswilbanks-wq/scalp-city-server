# X9 level-exit study (proposed `bt32`): does changing how X9 decides a trade is wrong improve it?

Status: **APPROVED by James 2026-11-20** ("1. 5 is good. 2. yes 3. yes": variants E1-E5 as written, SPY included, bt31 window and splits). Frozen before any `bt32` result exists. Built as `study_x9_level.js`, test `test/x9level_smoke.test.js`. Read-only; no live X9 rule changes.

## 1. Verified facts
- **Live X9 exits** (`x9Manage` in `server.js`): the "level" exit fires when a completed 5-minute candle closes through EMA9 against the trade (checked from the candle after the signal candle); "reverse" = the opposite EMA9/VWAP cross; plus the -30% premium stop, flat at 15:35 ET, and the per-symbol profit rule (QQQ +70% target, SPY trail arm +25% / keep half the peak gain). Checked in code: `aggBars` keeps only complete 5-minute buckets, so live exits fire on completed candles, the same as the backtest. There is no live/backtest mismatch on that point.
- **The level exit is X9's main exit.** In the `bt31` rows (2025-11-20 to 2026-11-18, SPY and QQQ), 447 of 490 QQQ trades and 432 of 474 SPY trades ended on the level exit (91%); "reverse" ended 5 trades in total; the rest were time exits. Under the live rules, QQQ level-exit trades averaged +$10.30 net at $0.01 per fill (34% winners); SPY level-exit trades averaged -$1.27 (45% winners).
- **Live, 2026-11-12 to 11-20:** 13 of 18 closed X9 trades were level exits, net -$280, 3 winners (QQQ 8 trades -$207, SPY 5 trades -$73). That is a small sample: the QQQ gap to the backtest (-$26 live vs +$10 backtest per trade) is roughly 1 to 1.5 standard errors and is not conclusive.
- **Never tested:** how the level exit is defined. Earlier X9 studies: `bt12` (5-minute vs 1-minute candles), `bt15` (3-minute direction filter on entries), `bt22` and `bt31` (profit-taking on top of the level exit). `bt31` result: no profit-exit variant improved QQQ or SPY.

## 2. Assumptions and unknowns
- Whether a different level exit helps is unknown. A stricter level exit holds losers longer (the -30% stop is the only floor) and may hold winners through bigger pullbacks; the direction of the net effect is not known in advance.
- Backtest option prices are last-trade prices without bid/ask; fast-moving 0DTE trade prints can overstate peaks. All variants share this.
- With about 480 trades per symbol and outlier winners, only large improvements can be detected; a "no improvement" result does not prove no improvement exists (see `bt31`).

## 3. Setup (read-only, no trading effect)
New harness reusing the `bt31` loader (Robinhood 1-minute bars aggregated to 5-minute candles, `Engine.x9Signals` entries, real Alpaca 1-minute option prices walked minute by minute, entry at the next 5-minute open). Window: the `bt31` window (use the `now` saved in kv `bt31`), **ending before today's session** (the two `bt31` errors were Alpaca refusing recent same-day option data). $0.01 per fill each way, with $0.03 stress. Train = first two thirds of sessions, lock = last third (both already seen in `bt22`/`bt31`, so neither is an untouched holdout; forward paper from 2026-11-12 is the only clean test and is far too small).

Every variant carries the **live** profit rule for its symbol (QQQ +70% target, SPY trail 25% / 50%), the -30% premium stop, the reverse exit and flat at 15:35. Unlike `bt22`/`bt31`, **each variant runs its own trade list with its own no-overlap rule** (one position per symbol at a time, as live), because a different exit changes when the next signal becomes tradable. Trade sets therefore differ, so variants are compared **per trading day** (all sessions, zero on no-trade days) as well as per trade.

## 4. Variants (fixed now; 5 per symbol plus the control; all recorded including failures)
| id | level exit rule |
|---|---|
| E0 | control: first completed candle closing through EMA9 against the trade (live) |
| E1 | two-close confirmation: two consecutive completed candles close through EMA9 against the trade |
| E2 | buffer: a candle closes through EMA9 by at least 0.25 x ATR(14) of that candle |
| E3 | grace: ignore the level exit on the first two completed candles after entry (entry candle and the next); evaluate from the third. Stop, reverse and profit rules stay active throughout |
| E4 | other line: exit when a completed candle closes through VWAP (OHLC/4) against the trade instead of EMA9 |
| E5 | no level exit at all: only reverse, -30% stop, profit rule and flat at 15:35 (measures how much the level exit adds or costs) |

## 5. Decision criteria (per symbol, each variant versus E0; ALL must hold)
1. Average per trade at $0.01 improves by at least $3 in BOTH train and lock.
2. Average P&L per trading day (zero on no-trade days) improves in BOTH train and lock.
3. Paired-by-day bootstrap **99% interval** (0.5% to 99.5%; 4000 resamples of days; fixed seed) of the whole-window daily P&L difference excludes zero. (Wider than 95% because 5 variants are compared per symbol.)
4. After dropping each rule's own best 5 trades, the variant's average per trade still exceeds the control's.
5. Absolute average per trade AND per trading day at $0.03 per fill are above zero (less negative is not enough).
6. At least 100 trades in each of train and lock, and at least 60% of the control's trade count (so a variant cannot "win" by mostly not trading).

If none pass for a symbol, the live rule stays and the result is reported plainly. Note: SPY's control is already negative at $0.03, so a SPY variant can pass only by making SPY profitable under cost stress (criterion 5), which is a high bar. **Nothing changes automatically**; any adoption is James's decision and would be a separate, small `x9Manage` change.

## 6. Interpretations fixed before the run
1. Control check (amended 2026-11-20 before building, before any result): `bt31` kept a symbol blocked until the *underlying* exit time even after a profit exit, while E0 uses real occupancy (blocked only until the position actually closes), so E0 cannot be expected to match `bt31`. An extra control **E0L** = E0 with `bt31`'s occupancy rule must reproduce the `bt31` live-rule cells (QQQ C1, SPY C2) within 2% on trade count and $1.00 on average; otherwise report every result as unverified. The E0 vs E0L gap is reported as the effect of occupancy. Judging criteria in section 5 still compare variants to E0.
2. A confirmation or buffer that is never met before 15:35 simply means the trade ends on reverse, stop, profit rule or the time exit.
3. Trade rows saved (kv `bt32`, resumable partial rows `bt32p`) so drop-best-5 and bootstrap checks need no rerun. Expected run time about 5-10 minutes.
4. Deploy follows the usual rule: tests first, push only with no open positions (or after telling James), one-shot after boot, no live behavior change.

## 7. Questions for James before building
1. Approve the five variants (E1-E5) as written, or add/remove any?
2. Include SPY, or QQQ only? (SPY's control is negative; including it also tests whether any exit rescues SPY X9.)
3. Keep the `bt31` window and splits (recommended, so results are comparable)?
