# Signal confluence study (`bt38`), results

Run 2026-11-27 by `node run_sig_local.js final` on commit `9cbd42f` (clean tree), after the dev stage. Spec: `docs/signal-confluence-spec.md` (frozen e4e474e; amendment A1 added the 7-signal set before any analysis). Research only. Nothing here touches the live server or any order path. Option P&L is NOT modelled; every number is the move of the underlying (SPY or QQQ) in basis points (bp, 1 bp = 0.01%).

## Verdict
**Not supported**, for both the primary set (all 7 signals, light at 4) and the replication set (the original 5, light at 3). Criteria 1, 2 and 6 passed; 3 (dev bootstrap lower bound above 0), 4 (still positive after the 1.0 bp option-equivalent cost) and 5 (above the shifted-signal chance control) failed.

## What was tested
SPY (primary) and QQQ (replication), 1-minute SIP bars with volume, 2016-01-04 to 2026-11-25 (2,741 sessions). Decisions every 5 minutes from 10:00 to 30 minutes before the close. Entry at the next bar's open. Dev 2016-2023 (2,012 sessions, about 134,000 decision points per symbol), holdout 2024-2026 (read once, by the final run). The signals are computed by the production `signals.js`.
Excess = direction-adjusted return minus the unconditional average of the same period and horizon (removes the market's upward drift, which would otherwise flatter every buy signal).

## Headline numbers (SPY, 7-signal light, mean excess over a 30-minute hold)
| | decision points lit | mean excess | 95% interval (day bootstrap) | chance control 97.5% | after 1.0 bp cost |
|---|---|---|---|---|---|
| Dev 2016-2023 | 62,736 | +0.12 bp | -0.18 to +0.43 | +0.32 | -0.88 |
| Holdout 2024-2026 | 23,409 | +0.28 bp | -0.27 to +0.81 | +0.48 | -0.72 |

Replication set (5 signals, 3 of 5): dev +0.15 bp (-0.14 to +0.45), holdout +0.32 bp (-0.16 to +0.84), chance control 0.30 and 0.43.
QQQ 7-signal: dev +0.31 bp (-0.07 to +0.71), holdout +0.21 bp (-0.52 to +0.92); QQQ 5-signal: dev +0.32, holdout +0.29. Chance controls for the four QQQ cells are 0.43, 0.67, 0.39 and 0.64; the dev excess is below its control in every case.
Hold to the close (SPY 7-signal): dev +1.44 bp (-0.69 to +3.48), holdout +0.58 bp; QQQ dev +3.14, holdout +1.46. Intervals include zero for SPY. These are descriptive (the verdict uses 30 minutes).
Hit rate of lit decisions is 50.1% to 52.0%, close to a coin flip.

## Does agreement strengthen the call? (the question)
- **Direction yes, size no.** Mean excess broadly rises with the number of signals that agree. SPY 7-signal holdout, buy side, 30 minutes: 1 agree -0.13 bp, 2 -0.38, 3 -0.01, 4 +0.31, 5 +0.59 (not strictly step by step: 2 is below 1). The rank correlation between the count and the mean excess is +1.00 (dev) and +0.90 (holdout) on the buy side. The sell side is weaker and noisier (-0.1 dev, +0.5 holdout). So more agreement lines up with a better outcome on the buy side, the pattern you expected.
- **But the effect is tiny.** The best bucket (5 of 7 buy) is about +0.5 bp per half hour. A typical cost to get in and out of an option is far larger than that (assumed 1.0 bp; real option spreads on SPY/QQQ are usually wider relative to the underlying move). The effect also does not beat the chance control, so it cannot be told apart from luck in dev.
- **Agreement is capped.** 6 or 7 of 7 never occurred in 10 years. The reason is built in: RSI and Bollinger are mean-reversion signals (buy when price has FALLEN), while VWAP, ORB, EMA and MACD are trend signals (buy when price has RISEN). They contradict each other most of the time, so the strongest consensus the board ever shows is 5 of 7. Measured pairwise correlation (dev, SPY): VWAP and ORB +0.72, VWAP and EMA +0.42, EMA and MACD +0.31, RSI against VWAP/ORB/EMA about -0.30, Bollinger against VWAP/ORB/EMA about -0.22 to -0.30.
- **The "effective independent signals" figure in this run (6.9 of 7) is misleading.** The spec's formula averages all pairwise correlations, and the positive (trend with trend) and negative (trend against mean-reversion) correlations cancel to about 0. The signals are NOT independent: VWAP, ORB, EMA and MACD largely say the same thing, and the other three argue with them. Treat that figure as a flaw of the metric, not as evidence of independence.

## What this does and does not mean
- Verified: on 10 years of SPY/QQQ minutes, the lit board does not predict the next 15 to 60 minutes by enough to survive costs or to be told from chance. This holds for the original 5 and the new 7.
- Not tested: option P&L (time decay, spreads, 0DTE gamma), the 8 single stocks (the first-half-hour signal needs a different data pull), other thresholds (for example 5 of 7), other horizons than the four reported, other signal parameters. Trying more variants now would be a new, separately recorded study, and testing many variants raises the chance of a false find; they should be pre-registered first.
- This does not say the signals are useless as a screen for human judgment. It says they do not beat the cost of trading them mechanically.
- Nothing trades on this. The board stays display-only.

## Where the data is
`harness_local/sig/out/bt38.json` (full), `bt38_compact.json` (also stored in Supabase `scalp.kv` key `bt38`), `harness_local/sig/dev_out.txt` and `final_out.txt` (printed tables). These are local and git-excluded.
