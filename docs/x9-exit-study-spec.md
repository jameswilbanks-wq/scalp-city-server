# X9 exit study v2 (`bt31`): does a better exit stop X9 giving back its big runs?

Status: **APPROVED by James 2026-11-20 ("build the study"). Read-only. No change to the live X9 book, no orders.** Spec written before any `bt31` result existed; section 5 lists the choices fixed in advance and they are not to be changed after results arrive.

## 1. Why this study (verified facts, from the Supabase journal and `bt22`)
- James observed that X9 positions run up (+$100) and then fade without selling. Today's QQQ put: entry ask $2.45, bid peaked $3.43 (about +$98), later $2.43. QQQ has **no trailing stop**; its only profit exit is a flat take-profit at +70% of the premium (a bid near $4.17 here), which a +40% run never reaches. SPY uses a trailing stop (arm +25%, exit when the gain falls to half the peak) and sold a +$131 peak at +$60.
- Live X9, Nov 12-20: 18 closed trades, net -$236. 7 trades peaked at +$42 or more; their peaks sum to about $599 and they closed with about $191 (peaks are hindsight; no rule sells exactly at the top).
- `bt22` (full history, one year, $0.01 per fill) tested: baseline, flat take-profits at 50-100%, and ONE trail setting (arm +25%, keep half the peak gain). QQQ: tp70 avg $9.14 PF 1.33, trail $5.53 PF 1.25. SPY: every flat TP negative, trail $0.29 PF 1.01. **Not tested in `bt22`: other trail settings, a trail on QQQ combined with the target, a breakeven lock.** That is this study.
- Known weakness of `bt22` that this study inherits: premium paths use trade prices with no bid/ask spread; X9's edge comes from rare large runs (best backtest trades $1,244-$1,600), so averages are outlier-sensitive.

## 2. Setup (identical to `bt22`, so the control is comparable)
Real same-day 0DTE option prices (Alpaca 1-minute option bars), SPY and QQQ, Robinhood 1-minute underlying bars aggregated to the live 5-minute frame, `Engine.x9Signals` entries, same -30% premium stop, same level/reverse/end-of-day exits, entry at the next 5-minute open, option price walked minute by minute. Window: the last 365 days at run time. $0.01 per fill each way ($2 round trip); every result is also reported at $0.03 per fill each way ($6). Split as `bt22`: first two thirds of sessions = train, last third = lock. **Neither is an untouched holdout** (both were seen in `bt22`); the only clean test is forward paper from 2026-11-12, which is far too small to judge.

## 3. Variants (fixed now; 12 per symbol, all recorded including failures)
Rules apply to the option premium as % of entry premium, checked on closed 1-minute option prices, stop first, then target, then lock/trail (as `bt22`).
| id | rule |
|---|---|
| C0 | control: no profit exit (`bt22` baseline) |
| C1 | control: flat take-profit +70% (live QQQ rule) |
| C2 | control: trail, arm +25%, exit when gain <= 50% of peak (live SPY rule) |
| T1 | trail arm +40%, keep 50% of peak gain |
| T2 | trail arm +15%, keep 50% |
| T3 | trail arm +25%, keep 67% (tighter) |
| T4 | trail arm +25%, keep 35% (looser) |
| H1 | +70% target plus trail arm +25% / keep 50% (first to trigger) |
| H2 | +100% target plus trail arm +25% / keep 50% |
| H3 | +70% target plus trail arm +40% / keep 50% |
| B1 | breakeven lock: once up +30%, exit if the premium falls back to entry (replaces the -30% stop above that point) |
| B2 | +70% target plus the breakeven lock |

"Keep k of peak gain" means exit when current gain <= k x peak gain, i.e. the live `X9_TRAIL_GIVE` = 1 - k.

## 4. Reference rule and decision criteria
Reference ("current live rule") = **C1 for QQQ, C2 for SPY**. Every variant is compared with it on the same trades, per symbol. A variant is a **replacement candidate** only if ALL hold:
1. Average per trade at $0.01 improves by at least $3 versus the reference in BOTH train and lock.
2. Paired-by-day bootstrap **99.5% interval** (0.25% to 99.75%; 4000 resamples of days; fixed seed) of the improvement, whole window, excludes zero. (Wider than 95% because 11 variants are compared per symbol.)
3. After dropping each rule's own best 5 trades, the variant's average still exceeds the reference's.
4. Absolute average per trade at $0.03 per fill is above zero (a rule that is only "less negative" is not recommended).
5. At least 100 trades in each of train and lock.

If none pass for a symbol, the live rule for that symbol stays and the result is reported plainly. **Nothing is changed automatically**; any adoption is James's decision and would start as a separate, small change.

## 5. Interpretations fixed before the run
1. The trade set is exactly `bt22`'s (signals and the no-overlap rule use the baseline exit time), so all variants trade the same entries. This is a simplification: with an early profit exit a later signal could have been traded.
2. Control check: C0, C1 and C2 must reproduce the saved `bt22` cells (`SYM|baseline|ALL`, `tp70`, `trail`): trade count within 5%, average within $3.00 per trade. The window is one week newer than `bt22`'s, so exact equality is not expected; if outside tolerance, report every result as unverified.
3. Descriptive giveback metric, all variants: among trades whose premium reached at least +40% of entry before the C0 exit (about a +$100 run on a $2.50 option), report count, average result, and share finishing positive. This directly measures the "ran up then faded" complaint.
4. The improvement over the reference is the same at any per-leg cost (both sides pay the same two legs); the real cost test is criterion 4.
5. Trade rows are saved (kv `bt31`, resumable partial rows in `bt31p`) so no later check needs a rerun.
