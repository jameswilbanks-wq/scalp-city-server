# Daily-direction signal study (`bt34`), Stage 0: do well-known indicators call the SPY/QQQ day well enough to pay for buying 0DTE calls or puts?

Status: **Stage 0 only. Read-only backtest on the underlying price; no options, nothing trades, no live rule changes.** Written 2026-11-20 after James asked: "build a book strategy that recognizes the general daily direction of the market based on the best indicators out there and buys puts or calls to make as much profit as possible 0dte." Frozen before any `bt34` result exists. Code `study_dir.js`, test `test/dir_smoke.test.js`, kv `bt34` (progress `bt34p`). Linked from `docs/EXPERIMENT_LOG.md` and `docs/DECISIONS.md`. Supersedes nothing (related earlier failures: `bt2`, `bt23`, `bt24`, `bt29`, `bt28`; see section 2).

## 1. Why a study first, not a live book
"As much profit as possible" is not a testable target and no backtest can promise it. A directional 0DTE long-option book only makes money if the direction call is right **often enough and by enough** to beat the premium (a call or put bought 0DTE loses the whole premium when wrong). Every directional entry tried here so far lost after costs on real option prices, except ORB15 (thin). Building and trading a book before knowing whether any daily-direction indicator beats a coin is how a paper account bleeds. So: Stage 0 measures whether the indicators predict the sign and size of the 10:30-to-close move at all. Only a survivor earns Stage 1 (real option prices, entry/exit rules), and only a Stage 1 survivor earns a shadow book, each a separate James decision. Nothing here goes live without James's explicit yes (CLAUDE.md).

## 2. Verified facts and unknowns
- Prior directional work on this project (EXPERIMENT_LOG): EMA entries (`bt23`, 60 buckets, none cleared breakeven), Sweep (`bt8`, break-even to losing), IB levels (`bt24` fail), ORPB (`bt29` fail), ORB15 options expression (`bt28` fail), FP retired. ORB15 live is the one survivor (about +$9/trade at $0.01, +$5 at $0.03 per leg).
- Published context (not verified here): first-half-hour returns weakly predicting the last half hour is a documented but small effect; gap, trend and short-term reversal effects exist in indexes at small size. Assumption to be tested, not relied on.
- Data: Alpaca 1-minute IEX stock bars (not consolidated tape; IEX volume is a small share of total, so VWAP here is a rough proxy). Split-adjusted. No VIX/breadth/futures data are used (not available in this loader); this limits the indicator set and is listed as a gap, not a finding.

## 3. Setup (fixed now)
Symbols SPY and QQQ. Sessions 2024-03-01 to 2026-11-13; a session needs a first bar by 09:35 ET, at least 60 one-minute bars before 10:30, a bar between 15:35 and 15:44, and at least 22 prior sessions of history (warm-up); skipped sessions are counted by reason. Dev = sessions before 2026-07-14; holdout = 2026-07-14 onward (a weak holdout: earlier studies saw this window; the untouched test is forward paper).
- **Decision time:** close of the last bar before 10:30 ET (entry price E). **Exit:** close of the last bar at or before 15:44 ET (X). move = X/E - 1; moveD = X - E in dollars per share.
- **Indicator votes** (+1 call, -1 put, 0 no trade), computed only from data before 10:30 and prior sessions:

| id | rule |
|---|---|
| GAPF | gap = open / prior close - 1; vote sign(gap) if abs(gap) >= 0.10% (follow the gap) |
| GAPR | same threshold, opposite sign (fade the gap) |
| ORB30 | E above the 09:30-10:00 high: +1; below the low: -1 |
| MOM | E / open - 1: sign if abs >= 0.10% (morning momentum) |
| VWAP | sign(E - session VWAP) if abs diff >= 0.02% |
| EMA | 5-minute closes (this session plus the last 3 sessions): sign(EMA9 - EMA20) |
| TREND | sign(prior close - SMA20 of the last 20 daily closes) |
| PDF | prior-day return sign (follow) |
| PDR | opposite (fade) |
| RSI2 | daily 2-period RSI < 10: +1; > 90: -1; else 0 |
| C1 | sign of the sum of votes ORB30 + MOM + VWAP + EMA + TREND (equal weight; tie = no trade) |
| C2 | sign of the sum of ORB30 + MOM + VWAP + EMA |
| B0 | baseline: always +1 |
| B1 | baseline: seeded coin flip per session (control; must look like zero) |

14 variants x 2 symbols = **28 comparisons**, all logged. The thresholds (0.10%, 0.02%) and the SMA/RSI lengths are fixed in advance and were not tuned.

## 4. Metrics (every variant, dev / holdout / all)
Trades n (vote != 0); hit rate (move in the voted direction > 0); mean signed return in basis points (vote x move x 10,000); per-session average (zero for no-trade sessions); 99% bootstrap interval by session (4,000 resamples, seeded) of the mean signed return; and **edge vs fair premium per contract** = 100 x [mean over trades of max(0, vote x moveD) - mean(abs(moveD)) / 2]. This is the long-option hold-to-close payoff over a fair-premium proxy (the fair price of an at-the-money option held to the exit is about half the expected absolute move). It **excludes** bid/ask, fees, the variance premium that 0DTE options usually carry over realized moves, and any early exit, so it is an upper bound on what an option buyer could keep.

## 5. Pass criteria for Stage 0 (per symbol and variant, ALL must hold; baselines are not judged)
1. n >= 150 trades over the whole window.
2. 99% interval of the mean signed return (whole window) has a lower bound above zero.
3. Mean signed return positive in BOTH dev and holdout.
4. Hit rate >= 53% in BOTH dev and holdout.
5. Edge vs fair premium >= +$5 per contract over the whole window (a cushion against costs that are not in this metric).
6. Mean signed return beats both B0 and B1 on the same symbol.
A variant that passes on **both** symbols is a robust candidate; on one symbol only, a weak candidate. About 1% of 28 comparisons pass by chance even at 99%. If nothing passes, the answer is plain: these indicators do not call the daily direction well enough to buy 0DTE options, and no book is built. Best-looking variants are hypotheses only.

## 6. Not modeled / caveats
Stage 0 ignores option prices, theta, spreads and fees entirely. A pass here does not mean a profit; it only earns the right to test real option prices (Stage 1: ATM and slightly OTM long calls/puts, hold-to-close and stop/target exits, real Alpaca 1-minute option bars, costs of $0.01 and $0.03 per leg per fill, reported separately for historical, holdout, and forward paper). Indicators missing from this study (VIX level and term structure, breadth, futures, news/event calendars) may matter and are not tested because the data are not in this loader.

## 7. Rollout
Read-only; one-shot after boot, skipped if `bt34` already exists; no trading effect; tests first; deploy outside market hours.
