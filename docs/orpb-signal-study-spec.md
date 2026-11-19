# ORPB — opening-range breakout + 2-minute 20-EMA pullback entry: Stage 0 signal study spec (`bt29`)

Last updated: 2026-11-19. Status: **APPROVED by James 2026-11-19 for the read-only Stage 0 study `bt29` only (not `bt28`), nothing live. Built (`orpb.js`, `study_orpb.js`, `test/orpb_smoke.test.js`) and deployed 2026-11-19 after 16:00 ET and after `bt28` had finished; results pending in kv `bt29` (progress `bt29p`). Read-only; no options, no money, no effect on any live book.**

Build notes (things the spec did not say, all inside Stage 0): the first 5 sessions are skipped because the EMA warm-up needs 5 prior sessions; days with fewer than 150 one-minute bars and sessions ending before 15:00 ET are skipped and counted; a bar that opens beyond the stop fills at the open; the EMA is seeded with the first value of its series; the $0.10 floor skips the whole day (counted, no retry); sessions after 2026-11-13 are not fetched; stock bars are IEX (not the consolidated tape). The name "ORPB" is unchanged (open decision 2 was not answered).
Working name "ORPB" is a placeholder. Repo copy belongs in `docs/` (source of truth); do not edit the old Project copies.

## 1. What the video shows (verified from the screen recording, 2026-11-19)

Short Instagram reel from "flexingjoetrades" about Nasdaq futures, plastered with "Total payouts approved $79,204 ... $226,049" Apex prop-firm payout banners. The rule it teaches, as read from the captions and drawn chart:
1. **Opening range = 9:30 to 10:00 ET** (30 minutes), high to low. This is a 30-minute range, not the 15-minute range our ORB15 uses.
2. Wait for a **10-minute candle to close** above the range (shown for a long; the short side is not shown).
3. Switch to the **2-minute chart and add a 20 EMA** (settings on screen: length 20, source close, offset 0).
4. Wait for a **2-minute candle to "interact" with the 20 EMA** (a pullback to it), then **enter long**.
5. A "how I set stops" caption is followed by a long-position box drawn on the chart. The stop appears to sit at the low of the pullback near the EMA, with a target drawn far above. The reel never states the stop rule or target in words, and the numbers on the box (108.50, 1.77) are chart labels I cannot interpret. Target, stop placement, session cutoffs, short side and one-trade-per-day are therefore **unknown / inferred** (section 3).

No backtest, win rate or profit figure is shown. The payout banners are social proof, not evidence; the chart is a single hand-picked winning example.

## 2. How this differs from what we already run (and what it overlaps)

- **Not a duplicate of ORB15:** different range length (30 vs 15 minutes), a 10-minute confirmation candle, and an entry on a pullback to the 2-minute 20 EMA instead of at the breakout close. Entries come later and, if the stop is the pullback low, with much tighter stops.
- **Overlaps:** same underlying idea as ORB15 (a morning range break continues) and the same family as BRT (break and retest, `brt-strategy-spec.md`, not built). On days it fires it will usually agree with ORB, so the cross-book correlation cap would treat it as shared exposure. It does not diversify ORB.
- **Skeptical prior:** the closest tested relative is `bt24` (IB failed auction / trend continuation), which failed Stage 0. Treat ORPB, BRT, IB and ORB variants as one "levels / opening-range family" for multiple-comparisons accounting.
- **Hazard unique to this design:** a stop at a 2-minute pullback low is very tight (possibly a few cents to tens of cents on SPY/QQQ). Spread and slippage then eat a large fraction of 1R, and tiny stop distances inflate R-multiples. Costs must be applied in dollars, not as a flat fraction of R (section 4).

## 3. Rule as pre-registered for the study (inferred pieces flagged)

Underlyings **SPY and QQQ** (the books we trade; the video's futures are not available to us). All times ET, regular session, from 1-minute bars aggregated by the study.
1. **Range:** high/low of 1-minute bars 9:30 through 9:59. Skip the day if fewer than 25 of the 30 bars exist.
2. **Trigger:** first 10-minute candle (10:00-10:09, 10:10-10:19, ...; closes at :09 / :19 ...) whose close is above the range high (long) or below the range low (short). Short side mirrors the long (**assumption: video shows only longs**). Last trigger candle starts 14:30.
3. **Pullback entry:** after the trigger candle closes, on 2-minute candles (aligned to 9:30), the first candle that **touches** the 20 EMA (long: low <= EMA20; short: high >= EMA20) **and closes on the trade side of it** (long: close > EMA20). Entry at that candle's close. **Assumption:** "interaction" = touch-and-hold. Variant V2 = touch only (no close condition). Entry window ends 15:00. One trade per symbol per day; if no pullback happens, no trade.
4. **EMA:** standard recursive EMA, length 20 on 2-minute closes, alpha = 2/21. Primary seed: warmed up over the previous 5 trading days' regular-session 2-minute closes, so the first morning values are not distorted by a cold start. Sensitivity: session-only seed. **Unknown** whether the reel's chart includes extended hours.
5. **Stop (inferred):** the low (long) / high (short) of the pullback candle that triggered entry. Stop checked before target inside a bar.
6. **Target (unknown):** pre-registered fixed set R = 1.5, 2, 3 (multiples of the entry-to-stop distance); or no target, exit 15:30. Flat 15:30 ET.
7. **Minimum stop distance:** skip a signal if stop distance < $0.10 per share, and count the skips (a stop that tight is untradeable in options and cost-dominated). Also report results with the floor raised to $0.20 as an informational row.

## 4. Study `bt29` (Stage 0, read-only)

**Harness:** new pure module `orpb.js` (aggregation, EMA, trigger, pullback; no I/O, unit-testable like `orb15.js`) plus `study_orpb.js` following `study_ib.js` (real Alpaca 1-minute SPY/QQQ stock bars, run server-side once after boot, saved to kv `bt29`). `bt28` is reserved for the unbuilt RB15 expression study and `bt27` for the unbuilt ORB exit study; confirm `bt29` is free.

**Splits:** dev 2024-03-01 to 2026-07-13, holdout 2026-07-14 to 2026-11-13 (same as `bt24` for comparability). The holdout window has been seen by earlier studies, so it is a weak holdout; the untouched final test is forward paper from 2026-11-19, evaluated only after a frozen version exists.

**Costs (underlying only, no options yet):** subtract **$0.02 per share round trip** (about a 1-cent spread each way) in dollars, converted to R as 0.02 / stop distance, per trade. Report also at $0.04. Do not use a flat 0.05R haircut here; with tight stops it hides the real cost. Historical options pricing is deliberately left to Stage 1.

**Metrics** per config x symbol x period: n signals, n trades, win%, avg R net of costs, profit factor, total R, worst/best trade, max drawdown in R, longest losing streak, trades-per-day share, average over ALL trading days including no-trade days, stop-distance distribution ($ and % of price), skip counts by reason, drop-best-5 result, day-level bootstrap 95% interval on avg R. Compare against a naive baseline: the same trigger entered at the trigger-candle close with the stop at the range's other side (so we can see whether the EMA pullback entry adds anything or just filters).

**Configs (pre-registered, kept small):** entry {touch-and-hold, touch-only} x target {1.5R, 2R, 3R, none-to-15:30} = 8 per symbol, plus the naive baseline. Parameter sensitivity around the primary (touch-and-hold, 2R): EMA 15/20/25, trigger candle 5/10/15 minutes, range 23/30/38 minutes, EMA seed session-only. Sensitivity is for reporting fragility, not for choosing a winner.

**Pass criteria (set before results):** the primary config (touch-and-hold, 2R) passes Stage 0 only if ALL hold on both symbols:
1. Dev avg R > 0 after costs at $0.02/share.
2. Holdout avg R > 0 and holdout n >= 40 per symbol.
3. Still positive with the best 5 trades removed.
4. Not sign-flipping across the +/-25% sensitivity neighbors (fragile = fail).
5. Beats the naive same-trigger baseline on avg R in dev and holdout (otherwise the EMA pullback adds nothing).
6. Median stop distance large enough to trade: report it; if the median is under $0.20, mark as likely cost-dominated and do not advance without a Stage 1 plan that handles it.
Fail on any criterion = record as failed in `EXPERIMENT_LOG.md`, no Stage 1, no book. All configs tried count toward the family multiple-comparisons tally with `bt13`, `bt24` (and `bt25`/BRT if built).

## 5. If Stage 0 passes (NOT authorized by this spec)

Separate decision by James: Stage 1 = single-leg ATM 0DTE (same expression as ORB/Sweep) and a debit spread on real option bars with the same cost sweep discipline as `bt28`, then a forward paper shadow (at least 60 trading days and 100 closed trades per strategy before any live discussion). No live trading. Spread/slippage on tiny stops may make the options version unprofitable even if the underlying signal is positive.

## 6. Out of scope

Futures (NQ/MNQ), single stocks, prop-firm pass-rate modelling, any change to ORB15 or any live book.

## 7. Open decisions for James

1. Approve building and running `bt29` (read-only Stage 0 only)?
2. Rename "ORPB"?
3. OK with the inferred pieces: touch-and-hold entry, stop at the pullback candle's extreme, mirrored shorts, targets tested at 1.5/2/3R, $0.10 stop floor?
4. Order versus the other pending read-only studies (`bt27` ORB exit study, `bt28` RB15 expression study)? All three are read-only; recommendation: run them one at a time so Alpaca data pacing is not stressed.

## 8. Instructions for Claude Code (after James says yes to item 1)

1. Confirm you are on `main` with a clean working tree apart from the spec files James added under `docs/`. Do not commit or touch unrelated files (there was a separate `triple-rsi` branch with untracked folders on his machine; leave it alone).
2. Read `CLAUDE.md`, `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`, `docs/STRATEGY_REGISTRY.md`, `docs/EXPERIMENT_LOG.md`, `docs/RISK_POLICY.md`, `docs/brt-strategy-spec.md` if present, and Supabase `notes`; read `study_ib.js`, `orb15.js`, `test/ib_smoke.test.js`.
3. Add `orpb.js`, `study_orpb.js`, `test/orpb_smoke.test.js` (synthetic bars: 10-minute and 2-minute aggregation alignment, EMA value against a hand calculation, trigger candle, touch-and-hold vs touch-only, stop floor skip, one trade per day, stop-before-target, costs in R). Run `node --check server.js` and the relevant tests; show the output.
4. Wire a one-time post-boot run in `server.js` like `bt24` (skip if key exists, errors saved to the key, request pacing like the other studies).
5. Follow the deploy procedure in `CLAUDE.md` (open-position check if during market hours, commit, push, confirm Render deploy `live`).
6. When `bt29` finishes, read it from Supabase and report dev and holdout separately against the criteria above. It is a historical underlying-price study: not forward, not live, not profit.
7. Same commit: update `STRATEGY_REGISTRY.md` (new ORPB section), `EXPERIMENT_LOG.md`, `DECISIONS.md` (James's approval and date), `PROJECT_STATE.md`; add a Supabase `notes` item.
