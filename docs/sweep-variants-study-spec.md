# Sweep variants: fade, wick-size cap, with-trend filter — Stage 0 study spec (`bt30`)

Last updated: 2026-11-19. Status: **APPROVED by James 2026-11-19 to build and run as a read-only Stage 0 study. Built, unit-tested on synthetic data (`test/sweepvar_smoke.test.js`) and deployed 2026-11-19 after `bt28` and `bt29` had finished (both failed their pre-registered criteria); results pending in kv `bt30` (progress `bt30p`). No change to the live Sweep book, no orders.**

James's answers (2026-11-19): (1) yes, build and run `bt30`; (2) leave the live Sweep real-order pilot as is for now (no `SWEEP_REAL_ORDERS` change); (3) "you make the call on what is actually true": cost and holdout labelling decided as stated in section 3 (below). Push order: after `bt28` and `bt29` have finished, so one study runs at a time (a deploy restarts the server and would restart any study still running from scratch).

Resolved while building (differences from the first draft, all inside Stage 0):
- Data source: SPY/QQQ 1-minute IEX stock bars are fetched directly through the Alpaca data client (`/v2/stocks/{sym}/bars`, raw/unadjusted like `bt8`), not the Robinhood historicals connector; signals come from the same Engine `sweepSignal`. The `bt8` reproduction check is what proves the signals match.
- Criterion 5 (fade stability) is implemented as: positive average in at least 75% of the calendar quarters that have at least 10 trades, and at least 4 such quarters, per symbol.
- Each signal is priced independently (as `bt8` does); the live book holds one position at a time, so the study's trade count is an upper bound on what the live rule would take.
- Stock bars are processed in 20-session chunks (identical signals, no long event-loop block on the live server). The study waits for the `bt28` result and for any running `bt29` before starting.

## 1. Why this exists

Live Sweep "run" book, main book, trig `sweep` (kv `rec:` rows, 2026-11-11 to 2026-11-19, read 2026-11-19): 41 trades, 15 winners (37%), **-$208** (avg -$5.1; avg win +$26.7, avg loss -$23.4). 0DTE calls 22 trades -$328 (4 winners); 0DTE puts 16 trades +$111 (9 winners). 2026-11-19 alone: 6 trades, 1 winner, -$216, five calls on a falling day.
Observed on 2026-11-19: underlying stop distances $0.65-$1.72 (most earlier days $0.10-$0.50); with one contract per trade, wider wick = more dollars at risk (losses -$44, -$33, -$45, -$27, -$73). Best open profit vs final P&L on today's trades: +$65 -> +$6, +$60 -> -$33.
Prior evidence (EXPERIMENT_LOG, `bt2`/`bt3`/`bt4`/`bt8`/`bt9`): Sweep on real option prices was about break-even in tuning and **negative in the lock period for SPY and QQQ under all four exits**; about 70 exit variants tested, none beat the current trail; the early 57% "lean" was shown to be noise. A tighter-trail test (`bt4`) also failed. **This spec does not tune the exit again.**

Caveats (read before anything else):
- 41 live trades over 6 sessions cannot show that calls are worse than puts or that fading would win; two weeks of market direction explains that split as easily as the signal does.
- "The opposite would have won today" is hindsight from one day. Nov 11-13 and 17 had winners in the original direction.
- A fade pays the option spread twice as well. Logged live spreads (2026-11-19, 6 trades): about $0.03/share in and $0.03/share out. If the signal carries no direction information, the fade loses the same cost as the original; this study measures whether any information exists.
- Sweep has been examined heavily already (about 70 exit variants plus `bt8`). Every variant here adds to the multiple-comparisons tally; the family count is stated in the result.

## 2. Pre-registered variants (fixed before any result)

Signal source: Engine `sweepSignal` exactly as live (look-back 20 bars, wick >= 0.5 of range, min range 0.8 ATR, max risk 2.5 ATR; low sweep -> call, high sweep -> put), 1-minute bars, entry at the next minute's open, SPY and QQQ same-day (0DTE) expiry, at-the-money strike, all out by 15:30 ET. Same harness approach as `study_sweep.js` (`bt8`): real Alpaca 1-minute option bars, option sold at the last trade price at exit time.

| ID | Rule | Purpose |
|----|------|---------|
| `S0` | Live rule: original direction, wick stop, 1R underlying trail ("run") | Control. Must reproduce `bt8` run rows for SPY/QQQ within tolerance, else results are marked "control not verified" |
| `F1` | Fade: opposite option (low sweep -> put, high sweep -> call), same entry minute. Stop = entry underlying price +/- R against the fade (R = the original wick-stop distance), then the same 1R trail (mirror of `S0`) | Does direction carry any information |
| `F2` | Fade, no stop: out 10 minutes after entry (or 15:30) | Same question without a stop assumption |
| `W1` | `S0` but skip signals with stop distance R > 0.08% of the underlying price | Wide-wick cap |
| `W2` | `S0` but skip signals with R > 0.12% of the underlying price | Wide-wick cap, looser |
| `T1` | `S0` but take only signals whose direction agrees with the sign of (price at signal - day's 9:30 open) | With-trend only |
| `T2` | `S0` but take only signals whose direction agrees with price vs session VWAP at the signal minute (call: price >= VWAP; put: price <= VWAP) | With-trend only (alt) |
| `T3` | Complement of `T1`: counter-trend signals only | Diagnostic: if `T1` helps, `T3` should be the worse half |

No other thresholds, windows or exits are tried. `W1`/`W2` are sensitivity to each other, not a search. Noise reference: the same signal minutes with a coin-flip direction (seeded) under the `S0` exit; it should come out near minus the round-trip cost.

## 3. Costs, splits, metrics

- Slippage per fill: report at **$0.01** (matches `bt8`, for comparison) and **$0.03**. Apply as a deduction from the sell and an addition to the buy, per share, x100 per contract. Pass criteria use $0.03. Decision on what is actually true (2026-11-19): the logged live full spreads on the 6 rows with the field were about $0.03 in and $0.03 out, i.e. about $0.015 per fill if filled at the touch, and the live `slippageVsMid` values ranged -$0.055 to +$0.035 per share. Bars carry only last-trade prices (no bid/ask), and stale last prices on thin strikes make fills look better than reality, so **$0.03 is a deliberately conservative upper bound, not a measured cost**, and $0.01 is probably optimistic. The truth is between them; a variant that only works at $0.01 is not a pass, and the readout shows both.
- Splits: dev = sessions before 2026-07-14; holdout = 2026-07-14 to 2026-11-13 (same as `bt24`/`bt28`/`bt29`). Honest label: the holdout is a **weak** holdout (Sweep was already examined on this period). The clean test is forward paper: the live Sweep book from 2026-11-11 (reported separately, never merged with the study).
- Metrics, per variant x symbol x period x cost: n signals, n trades, skipped by reason, win %, average $ per trade net of costs, average over ALL signal days including no-trade days, profit factor, worst/best trade, drop-best-5 average, day-level bootstrap 95% interval on the average, calls vs puts split, stop-distance distribution ($ and % of price). Report historical (dev), holdout and forward-paper live results in separate tables.
- Data caveat to carry into the readout: option prices are last-trade prices from 1-minute bars, not quotes; thin strikes can have stale last prices (the live quote_check logging exists for this reason).

## 4. Pass criteria (set before results)

A variant passes Stage 0 only if ALL hold on **both** SPY and QQQ, at $0.03 slippage:
1. Dev average > 0 and holdout average > 0.
2. Holdout n >= 100 trades per symbol (a filter that leaves fewer is reported but cannot pass).
3. Still positive after removing the best 5 trades (dev + holdout combined).
4. Beats the coin-flip noise reference by more than its 95% interval.
5. `F1`/`F2` additionally: the fade's gain must not be explained by one symbol or one period (positive in at least 75% of the calendar quarters with at least 10 trades, and at least 4 such quarters, per symbol).
6. `W1`/`W2`/`T1`/`T2` additionally: must beat `S0` average in both periods (a filter that only cuts losing and winning trades equally adds nothing).
Fail on any criterion = recorded as failed, no Stage 1. All variants count toward the multiple-comparisons tally (Sweep family: `bt2`, `bt3`, `bt4`, `bt8`, `bt9` ~70 exit variants, plus the 8 here). With that many comparisons, a lone passing variant is a lead, not a result.

## 5. If something passes (NOT authorized by this spec)

A separate decision by James. Any pass leads only to a **shadow / forward paper book** (new, small, own journal field, real-quote spread logged), at least 60 trading days and 100 closed trades before a swap or live discussion. Nothing replaces the live Sweep rule on a Stage 0 result. If everything fails, the plain conclusion stands: Sweep has no demonstrated edge, and the decision to keep or pause the pilot (real paper orders at Alpaca) is James's.

## 6. Harness plan (after James says yes)

New `study_sweep_variants.js` modeled on `study_sweep.js` plus a pure-function module for variant rules (unit-tested on synthetic bars: fade direction and mirrored stop, R cap, trend and VWAP filters, cost application, noise reference). One-time post-boot run in `server.js` saved to kv `bt30` (progress `bt30p`; skip if the key exists; errors saved to the key), started **after `bt28` and `bt29` have finished** so data pacing is not stressed. Follow the CLAUDE.md deploy procedure; docs (STRATEGY_REGISTRY, EXPERIMENT_LOG, DECISIONS, PROJECT_STATE) and a Supabase `notes` item in the same commit.

## 7. Open decisions for James

1. Approve building and running `bt30` (read-only Stage 0 only)? **Answered: yes (2026-11-19).**
2. Pause the live Sweep real-order pilot while the study runs? **Answered: leave as is for now.**
3. Confirm the cost level ($0.03 per fill) and the weak-holdout labelling? **Answered: James delegated to me; both stand as written in section 3 ($0.03 is a conservative upper bound, the holdout is weak).**
4. Order: `bt28` -> `bt29` -> `bt30`, one at a time? Implemented (the `bt30` run waits for `bt28`'s result and any running `bt29`); `bt30` is pushed only after `bt28` and `bt29` have finished.

## 8. Unknowns / not yet verified

- `bt8` pulled stock bars through the `rh` historicals wrapper; in this build the study reads the same Alpaca IEX raw bars directly. Whether the signals match `bt8` exactly is checked at run time by the control gate (n within max(3, 3%), average within $1.50 per trade); until `bt30` runs this is unverified.
- Server run time and memory on Render for about 670 sessions x 2 symbols of 1-minute bars plus roughly two option-bar fetches per signal day are unmeasured.
- Number of sweep signals available (about 2,900 across both symbols per the year study; coverage for 669 sessions unchecked) and therefore whether holdout n >= 100 is reachable per variant.
- Whether live fills match option last-trade pricing: only 6 live rows carry the new spread fields so far.
