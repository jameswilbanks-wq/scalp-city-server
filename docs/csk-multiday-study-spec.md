# CSK multi-day call-spread study (`bt33`): does selling call spreads that expire 1-5 trading days out add something on top of 0DTE CSK?

Status: **APPROVED by James 2026-11-20** ("test away as proposed (and this would not replace our 0DTE. it would be in addition."). Read-only backtest; nothing trades, no live rule changes. Frozen before any `bt33` result exists. Code `study_csk_multiday.js`, test `test/cskmd_smoke.test.js`, kv `bt33` (resumable rows in `bt33p`).

## 1. Question and scope
Any result is judged as an **addition** to the live 0DTE CSK books (slots 1 and 2), never a replacement. A cell that passes is only a candidate for a **forward paper** test, which would need James's separate yes. Nothing here changes the live book.

## 2. Verified facts and unknowns
- 0DTE CSK (`bt6`/`bt7`/`bt9`): hold-to-close, 11:00 ET, short strike nearest 0.45% above price, $2 wide. `bt9` hold cells (QQQ/SPY): lock avg +$8.18/+$5.72 per spread, train +$4.43/+$4.82, win 80-90%, worst about -$190 to -$200.
- Unknown: whether a farther expiry pays enough credit for the extra gap risk. Same strike distance is breached far more often over 3-5 days than over one, so farther strikes (smaller credit) are included.
- Historical option bars have no bid/ask (trade prints only). Costs are modeled per leg per fill ($0.01, stress $0.03); this understates real spread cost on thin far-OTM legs.
- **Not modeled:** early assignment of the short leg, pin risk, dividends, and any broker-side margin or buying-power effect of holding spreads overnight. The live 3x stop exists only while the Render process runs (RISK_POLICY gap), so overnight gaps are unprotected.

## 3. Setup (read-only)
Same loader and entry logic as `bt9` part A: underlying 5-minute IEX bars from 2024-03-01, one entry per symbol per session at 11:00 ET on the 10:55-11:00 bar close, SPY and QQQ, $2 width, entry credit must be 3 cents to $1.80, real Alpaca option prices. Train = sessions before 2026-01-01, lock = 2026 onward (as `bt9`). Sessions up to but excluding today. Expiry = the session `dte` trading days after entry (the session list of the underlying), so weekends and holidays are skipped.

Grid (fixed now): `dte` in {0, 1, 2, 3, 4, 5} x short strike at {0.45%, 0.75%, 1.0%, 1.5%} above price, rounded to the nearest whole dollar (short = round(price x (1+pct)), long = short + 2). Entry price: last trade at or before 11:00 within 5 minutes (1-minute bars, as `bt9`). Path: 30-minute bars to expiry.

Exits (fixed now):
| id | rule | applies |
|---|---|---|
| H | hold to expiry, settle at the expiry-day close, value capped at the width | all dte |
| S | buy back when the spread value (short close minus long close, both legs in the same 30-minute bar, clamped to 0..width) is at least 3x the entry credit on two consecutive such bars; fill at that bar's close value; else H | all dte |
| D | close both legs at the 15:30-16:00 bar close of the session before expiry (last known price within 3 hours); skip if a leg has no price | dte >= 1 |
| SD | S until the D time, else D | dte >= 1 |

Costs: $0.01 per leg per fill, 2 fills to open, 2 more to close early (H: 2 fills total; a fired S: 4; D and SD: 4); stress $0.03.

## 4. Control (must pass or every result is reported unverified)
Cell `dte=0, 0.45%, H` per symbol, restricted to sessions up to 2026-11-10 (the last full session `bt9` saw), must reproduce `bt9` `A|SYM|hold|train` and `|lock`: count within 2% and average within $0.50. The same logic and costs as `bt9` (hold net = gross - $2) apply.

## 5. Decision criteria (per symbol x dte x pct x exit cell; ALL must hold for "forward-paper candidate")
1. Average per spread at $0.01 is at least +$3 in BOTH train and lock.
2. Average per spread at $0.03 over the whole window is above zero.
3. Bootstrap by entry day (4000 resamples, seeded) 99% interval of the whole-window average per spread at $0.01 has a lower bound above zero. (99%, not 95%, because about 150 cells are compared; about 1% of cells would still pass by chance.)
4. At least 100 spreads in each of train and lock.
5. Lock-period average per session (zero on sessions with no spread) is at least +$3 at $0.01.
6. **Plateau:** at least one neighbouring cell (same symbol and exit, adjacent strike distance at the same dte, or adjacent dte at the same strike distance) also has a positive whole-window average at $0.01. A lone lucky cell does not count.

Reported for every cell, not judged: win rate, worst trade, average of the worst 5%, and the 0DTE control's average for comparison. For any candidate the report also states peak concurrent exposure: with one new spread per day per symbol and `dte` days to expiry, up to `dte` spreads per symbol per strike setting are open at once, each risking about $200 minus credit, which is relevant to the $800 correlation cap. If no cell passes, the live books stay as they are and the result is reported plainly. Best cells are shown as hypotheses only.

## 6. Interpretations fixed before the run
1. A spread that settles in the money is valued at min(width, max(0, expiry close - short strike)); assignment is ignored.
2. A cell's trade list is every session with a valid entry price and credit; skipped sessions (no price, credit out of range, expiry session missing) are counted by reason and never silent.
3. Per-session average divides the cell's total by ALL sessions in the split.
4. Overlapping spreads are treated independently (no occupancy rule), since each is a separate daily entry; concurrency is reported, not enforced.
5. Rows saved to kv `bt33` so any later check (drop-worst-5, other splits) needs no rerun. Expected run time about 30-60 minutes (about 2 option-data requests per symbol-session).
6. Deploy follows the usual rule: tests first, push only with no open positions or after telling James, one-shot after boot, no live behaviour change.
