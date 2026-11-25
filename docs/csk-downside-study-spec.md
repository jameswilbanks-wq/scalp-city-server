# CSK downside-protection study (`bt35`): would a tighter stop or an up-day filter help the 0DTE call spreads?

Status: **APPROVED by James 2026-11-25** ("yes, do your read only study", after he asked "what if we put downside gaurdrails on csk? i notice on these up days it really gets hit hard"). Read-only backtest. Nothing trades, no live rule changes. Frozen before the run. Any variant that looks good is only a **candidate for a forward-paper test**, which needs James's separate yes (CLAUDE.md: no strategy, exit or risk change without it).

## 1. Question
The live CSK stop is 3x the credit (two fresh reads in a row). On strong up days the call spread loses. Would any of these beat it: (A) a lower multiple of the credit, (B) a dollar-loss cap, (C) a stop based on the underlying price against the short strike, (D) skipping the entry after a strong morning? "Beat" means less downside without giving up most of the average profit, judged on the days we would actually trade.

## 2. Verified facts, assumptions, unknowns
- Verified (docs): `bt9` found the 2x buy-back cost most of the average, the 3x stop kept most of it and cut the worst day from about -$200 to -$120..-$150, and hold-to-close beat every profit-taking rule. Live record Nov 12-25: 19 trades, one 3x stop (-$134).
- Assumption: a stop fills at the spread value of the bar that triggered it. Real stops pay the ask on the short leg and cross a spread, so every stop result here is **optimistic**; a $0.03-per-leg stress is shown beside the $0.01 base case.
- Unknown: historical option bars are trade prints (no bid/ask), so a thin leg can print stale. Live fills are the real test (the real-paper mirror is collecting that).
- Not modeled: early assignment, pin risk, the broker's own 15:45 near-the-money close, and the 12:30 second slot (this study covers the 11:00 slot only, the one with the longest history).

## 3. Setup
Same loader and entry logic as `bt9`/`bt33`: underlying 5-minute IEX bars from 2024-03-01; one entry per symbol per session at the 11:00 ET bar close (the 10:55 bar's close); SPY and QQQ; $2 wide; short strike = round(price x 1.0045), long = short + 2; credit must be $0.03 to $1.80; real Alpaca option prices. Train = sessions before 2026-01-01, lock = 2026 onward, reported **separately**. Sessions up to but excluding today. **New:** option bars at 5-minute resolution (not 30) so stops are tested at finer timing. Each row stores the whole path (time, spread value, underlying close) in kv `bt35`, so any later variant is re-scored without a rerun.

Spread value at each bar = short close minus long close, both legs from the same bar, clamped to 0..2. A bar with a missing leg is skipped.

## 4. Variants (fixed now; every one is reported, including the failures)
| id | rule |
|---|---|
| H | hold to the close, settle on the last underlying price capped at the width (control for bt9) |
| M3 | buy back when the value is at least 3x the credit on two consecutive bars (the live rule's analogue; **control for the stop**) |
| M25 | same, 2.5x |
| M2 | same, 2x |
| M15 | same, 1.5x |
| L75 | buy back when the loss reaches $75 per spread (value >= credit + 0.75), two consecutive bars |
| L100 | same, $100 (value >= credit + 1.00) |
| U0 | buy back when the underlying 5-minute close is at or above the short strike |
| U1 | same, within 0.10% below the short strike (close >= strike x 0.999) |
| U2 | same, within 0.20% below (close >= strike x 0.998) |
| F5 | skip the entry if the underlying is up 0.50% or more from the 9:30 open to the entry; hold otherwise (no stop) |
| F75 | same, 0.75% |
| F100 | same, 1.00% |
| F3 | F75 skip filter plus the M3 stop on the days that trade |

Costs: $0.01 per leg per fill (2 fills to open, 2 to close early); stress $0.03.

## 5. Control (must pass or every result is reported unverified)
H, restricted to sessions up to 2026-11-10, per symbol and per split, must reproduce `bt9` `A|SYM|hold|train` and `|lock` (count within 2%, average within $0.50), as `bt33` did. M3 is reported next to the published `bt9` 3x result for comparison but cannot be verified exactly (different bar size); that gap is stated plainly.

## 6. Decision criteria (per symbol x variant; ALL must hold for "forward-paper candidate")
The target is **less downside for little average cost**, so the bar is set against the M3 control, not against zero.
1. Average per **trading day** (zero on skipped days, the CLAUDE.md "average over all trading days" rule) at $0.01 is at least **90% of M3's** in BOTH train and lock.
2. Average of the worst 5% of trading days is better than M3's by at least 15% in BOTH train and lock.
3. Worst single day is no worse than M3's in the lock period.
4. At least 100 spread-days in each of train and lock for the cells compared.
5. Average per trading day at $0.03 over the whole window is above zero.
6. Paired bootstrap by day (4000 resamples, seeded, 99% interval) of (variant minus M3) average per day: the lower bound is above **-$1.50** (it may cost a little, but not a lot). 99% because 13 variants x 2 symbols are compared; about 1% of cells would still pass by chance.
7. **Plateau:** a neighbouring variant in the same family (next multiple, next dollar cap, next distance, next filter level) also meets criteria 1 and 2. A lone lucky cell does not count. Neighbours: M15-M2-M25-M3 in that order, L75-L100, U0-U1-U2, F5-F75-F100; F3's neighbour is F75.

Reported for every cell, not judged: win rate, trades skipped or stopped, stop-fire rate, worst trade, per-day average split into **up days and other days** (up day = underlying close above the entry price), and the share of stops that would have recovered by the close (stopped a trade that held would have won).

## 7. Interpretations fixed before the run
1. A spread that is not stopped settles at min(width, max(0, close - short strike)); assignment ignored.
2. Skipped sessions (no price, credit out of range, missing bar) are counted by reason, never silent.
3. Per-day average divides by ALL sessions in the split; a filter that skips a day counts that day as $0.
4. Backtest results are historical (train and lock reported separately); nothing here is a forward-paper or live result, and none is called profit.
5. Saved once to kv `bt35`, partial rows in `bt35p` (resumable). Runs server-side after boot, one shot, after `bt33` has finished. Expected run time about 20-40 minutes.
6. Deploy: tests first, push only with no open positions or after telling James. No live behaviour changes, a read-only one-shot.
