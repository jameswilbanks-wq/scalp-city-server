# RB15 — second book from the 15-minute opening-range reel: expression study spec (`bt28`)

Last updated: 2026-11-19. Status: **PROPOSAL ONLY. Not approved, not built. Read-only study; nothing here changes any live book.**
Working name "RB15" is a placeholder (James can rename). Repo copy belongs in `docs/` (source of truth); do not edit the old Project copies.

## 1. What the video shows (verified from the screen recording, 2026-11-19)

Instagram reel from Roboquant ("The ORB is king"). The setup it teaches, using a TSLA 15-minute chart:
- Mark the high and low of the first 15-minute candle (the opening range).
- A 15-minute candle that **closes above** the range: buy. **Closes below**: sell.
- Stop at the opposite side of the range. The example trade box on screen shows a stop larger than the target (target 3.51 vs stop 6.80, labeled risk/reward 0.54).
- The rest is a vendor demo of a strategy called "Giga ORB" in Roboquant's backtester (futures chart, ~30,000 price level, "Apex" prop-firm pass-rate tool). Numbers on screen: +201.89% return, net +$50,471.50, 1,217 trades, win rate 55.9%, profit factor 1.23, Sharpe 1.43, max drawdown -9.4%, expectancy +$41.47, avg win $391.04, avg loss -$401.19, avg R:R 0.97, 72.2% simulated prop-firm pass rate. The settings behind "Giga ORB" are not shown.

## 2. The important finding: this is the ORB15 book we already run

- Rule is identical to live ORB15 (`orb15.js`): range 9:30-9:44 ET, first 15-minute close beyond it, stop at the other side.
- We already tested this idea from an earlier reel (TradeX QuantORB, MNQ 15-minute chart): study `bt13` covered 5- vs 15-minute entries, 1R-2R targets, break-even rules and range-size filters on real SPY/QQQ same-day option prices. Per `bt13`: about +$6/trade QQQ, +$5.5/trade SPY in the 2026 lock period, PF 1.07-1.08. Live ORB: 7 trades, net -$279 (statistically consistent with a thin edge).
- The video's own demo numbers imply an edge of roughly 0.1R per trade ($41 on a ~$400 loss) on futures, before knowing its costs. That is the same thin-edge order of magnitude as ours. It is vendor marketing and is **not evidence** for SPY/QQQ options. Prop-firm pass rates are not profitability.

**Consequence:** a "second ORB book" that trades the same signal on the same symbols at the same time is a duplicate. It would double the same bet (the cross-book correlation cap would count it as one exposure anyway) and add no diversification or new evidence. The only legitimately new question is the **options expression** of the same signal, which the project rules already require us to compare ("a profitable underlying-price backtest does not establish profitable options execution"; "compare expiration horizons, do not default to 0DTE").

## 3. Hypothesis to test

The ORB15 underlying signal may be real but thin (~0.06-0.1R). A single-leg ATM 0DTE call/put pays full theta and spread cost on a contract that must move a lot, in a few hours. A different expression of the same trades might keep more of a thin edge:
- **B. 0DTE debit vertical spread** (cheaper entry, less theta bleed, capped payoff, but two legs of spread cost).
- **C. Single-leg ATM, next-listed expiration (about 1DTE)** (less theta decay per hour and better-quoted contracts, but more premium at risk and lower gamma).

Unknown in advance whether either beats the control. Costs may well erase the difference.

## 4. Study `bt28` (read-only, no trading effect) — NOT APPROVED, NOT BUILT

**Harness:** new `study_rb15.js`, following the pattern of `study_orb15.js` (bt13) and `study_ib.js`: real Alpaca 1-minute option bars (`/v1beta1/options/bars`), SPY and QQQ, March 2024 to latest, run server-side once after boot, saved to kv `bt28`. `bt27` is reserved for the unbuilt ORB exit study; do not reuse that key. Confirm `bt28` is free first.

**Signal and exits are identical across all variants (one change at a time):** signal from `Orb15.find()` logic (first 15-minute close beyond the range, candles from 9:45 through the 15:00 candle, one trade per symbol per day); stop = opposite side of range on the underlying; target 1.25R and stop moves to entry at +0.5R (live settings `ORB_R`, `ORB_BE`); flat 15:30 ET; stop checked before target inside a bar. **Claude Code must verify which `bt13` key matches live settings** (registry calls the adopted config `e15|t1|be1`, live is 1.25R / +0.5R; confirm the mapping before using it as the control). No premium stop in the study (matches `bt13`); live has -50% premium stop, so note that gap in results.

**Variants:**
| ID | Structure |
|---|---|
| A (control) | ATM single-leg, same-day expiry. Must reproduce `bt13`'s live-config row (same n, avg $/trade within about $0.50) before B/C results are trusted. If it does not, stop and report. |
| B | 0DTE debit vertical: buy ATM, sell the strike $2 further out in the trade direction (call: higher strike; put: lower). Skip the day if either leg has no price within the same staleness window `bt13` uses. Max loss = debit paid. |
| C | ATM single-leg, next listed expiration (Friday uses Monday). Same exits, still flat 15:30 same day (no overnight). |

Width $2 is one pre-registered choice. Do not tune widths. If $2 is not listed or has no bars on a day, skip and count it.

**Costs (a historical option bar has no bid/ask, a known limit):** report each variant at **$0.01, $0.03 and $0.05 per leg per fill**. B pays this on 4 fills (2 legs in, 2 out). **Pass is judged at $0.03.** Replace the assumption with measured numbers once there are at least 20 live ORB rows with `entryBid`/`exitAsk`/`spreadIn`/`spreadOut` (logging started 2026-11-18, so very few exist yet; do not pretend otherwise).

**Splits:** same as `bt13` for comparability: train before 2026-01-01, lock 2026-01-01 onward. Also report the sub-period 2026-07-14 to latest separately. The lock period was already seen for the ORB signal in `bt13`, so it is not a virgin test. **The untouched final holdout is forward paper trading from 2026-11-19 on**, evaluated only after the version is frozen.

**Metrics per variant, symbol, period and cost level:** n, win%, avg $/trade, profit factor, worst/best trade, max drawdown of cumulative P&L, longest losing streak, avg R on the underlying (same for all variants, a sanity check), share of days traded, **average P&L over all trading days including no-trade days**, day-level bootstrap 95% interval (2,000 resamples) for avg $/trade and for the difference vs A, and the result with the best 5 trades removed. Record skipped-day counts by reason.

**Pre-registered pass criteria (B or C advances only if ALL hold, set before looking at results):**
1. Control A reproduces `bt13` (harness check).
2. At $0.03/leg: avg $/trade > 0 and PF >= 1.10 in both train and lock, on both SPY and QQQ.
3. Beats control A on avg $/trade in both periods on both symbols at $0.03.
4. Lock n >= 100 per symbol.
5. Still positive with the best 5 trades removed.
6. Maximum loss per trade fits the approved per-trade cap in `RISK_POLICY.md` (read the current number; skip-if-one-contract-exceeds-budget rule applies).
A positive result whose bootstrap interval includes zero is labeled **unproven**: at most forward paper shadow, never live.
If neither passes: record both as failed in `EXPERIMENT_LOG.md`, ORB15 continues unchanged, no second book gets built. All variants and costs tried are recorded, failures included. They count with `bt13` toward the ORB-family multiple-comparisons tally (2 candidates x 2 symbols x 3 cost levels here).

## 5. What happens only if a candidate passes (NOT authorized by this spec)

A separate decision from James. Outline only: new book (`rbk`, env `RB15_ON=0` by default) that reuses `orb15.js` `find()`, simulated fills first, counted in the correlation cap using the debit as risk, logging spread/delta/iv like ORB rows, running alongside ORB on the same signals so results are paired rather than independent. Forward paper floor: at least 60 trading days and 100 closed trades per strategy before any live-pilot discussion, extended if the sample is thin. Frozen version during validation. No live trading.

## 6. Out of scope / not recommended

- Single stocks such as TSLA from the video: 0DTE single-stock options lost $5-9/trade under every exit tested in `bt8`; a chart example is not a reason to add them. Needs its own hypothesis and study if James wants it.
- Futures (NQ/MNQ): the project trades options on Alpaca/paper; the video's futures numbers do not transfer.
- Retuning ORB's own rules (target, break-even, range filters): already covered by `bt13`; the exit question belongs to `bt27`.

## 7. Open decisions for James

1. Approve building and running `bt28` (read-only study only)? Nothing live changes.
2. Is the $2 width and the next-expiry choice acceptable, and is $0.03/leg the right pass-test cost?
3. Rename "RB15"?
4. Should this wait behind the pending `bt27` ORB exit study, or run first? Recommendation: either order is safe because both are read-only; `bt28` answers a structurally different question.

## 8. Instructions for Claude Code (after James says yes to item 1)

1. Read `CLAUDE.md`, `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`, `docs/STRATEGY_REGISTRY.md`, `docs/EXPERIMENT_LOG.md`, `docs/RISK_POLICY.md`, `docs/orb-exit-study-spec.md`, and Supabase `notes`; read `study_orb15.js`, `study_ib.js`, `orb15.js`.
2. Add `study_rb15.js` and a smoke test `test/rb15_smoke.test.js` with synthetic bars (leg selection for B, Friday-to-Monday expiry for C, skip rules, cost application, control-reproduction check logic). Run `node --check server.js` and all relevant tests; show the output.
3. Wire a one-time post-boot run into `server.js` like `bt24` (skip if key exists, errors saved to the key). Keep Alpaca request pacing like `bt13`.
4. Follow the deploy procedure in `CLAUDE.md`: check no open positions if during market hours, commit, push, confirm Render deploy `live`.
5. When `bt28` finishes, read it back from Supabase and report: historical train and lock results separately, by variant and cost level, against the criteria above. No live results or forward results exist for this idea yet; label accordingly.
6. In the same commit as code: update `STRATEGY_REGISTRY.md` (new RB15 section, status), `EXPERIMENT_LOG.md` (row for `bt28`), `DECISIONS.md` (James's approval, date), `PROJECT_STATE.md`; add a Supabase `notes` item.
