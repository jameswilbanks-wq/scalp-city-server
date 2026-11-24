# RISK_POLICY.md — Scalp City

Last updated: 2026-11-14.

Approved limits and suspension rules. Strategy mechanics are in STRATEGY_REGISTRY.md; rationale/dates are in DECISIONS.md.

## Account-level, paper (current)

- 1 contract per paper trade (or 1 spread), regular trading hours only, 0DTE expiry.
- Daily trade/loss limits are **currently OFF for paper** (`ENFORCE_LIMITS=0`) so samples can build without being cut short. `ENFORCE_LIMITS=1` restores: max loss $50/day, max 6 trades/day, max 3 losers/day.
- **This must be revisited before any live trading** — restoring these limits (or setting live-appropriate ones) is a standing item on every morning review.

## Account-level, planned for live (NOT YET ACTIVE)

- Max 3 trades and 2 losers a day.
- Max $150 per contract.
- Weekly loss cap $100; total cap $150.
- Max spread cost 10%.
- **Open issue:** a SPY 0DTE contract typically costs ~$115-230 and a $2-wide spread risks up to $200 — these per-contract/per-spread costs already approach or exceed the planned $150 cap, so the cap needs revisiting before live, not just activating as-is.

## Correlation-aware exposure cap across books (added 2026-11-14, $500 confirmed by James same day)

Each book below caps its own risk, but before 2026-11-14 nothing capped the *combined* open risk when several books are open on the same correlated symbols at once (SPY and QQQ move together). `server.js` now sums estimated max-loss dollars across sweep/ORB/X9/FP (long single-leg premium) + CSK (credit-spread width minus credit) + CDR (its own pre-computed risk) for symbols in `CORR_GROUPS` (default `SPY,QQQ`), and skips any new entry in any book that would push that group's combined open risk over `CORR_CAP_USD`.

- **`CORR_CAP_USD=500`, confirmed by James 2026-11-14.** Set explicitly as a Render env var (along with `CORR_GROUPS=SPY,QQQ`) the same day, rather than left on the code default. Sized against the planned live per-trade cap ($150) and weekly cap ($100) in this file, scaled up to allow a handful of small concurrent paper positions without being toothless.
- `CORR_CAP_USD=0` disables the cap entirely. `CORR_GROUPS` (comma list) controls which symbols are treated as one correlated bucket — currently just SPY,QQQ, since those are the only two symbols multiple books can trade simultaneously today.
- A skipped entry is logged on the Board (reason: "would push {symbol}-group open risk to $X, over the $Y correlation cap"), not silently dropped.
- This is a soft governor on top of each book's own per-book risk rules below, not a replacement for them.
- Observed 2026-11-18: the cap blocked 2 of 7 ORB signals (QQQ Nov 16, SPY Nov 17). A priority rule so ORB is not routinely blocked is an open question (see DECISIONS.md).

## Per-book risk/suspension rules

**Sweep (main):** -50% premium catastrophic stop per trade; flat before close; one position at a time on the main book; cools down after a stop.

**ORB:** stop at opposite side of the opening range; -50% premium stop; flat before 3:30 PM ET; one trade per symbol per day.

**CSK (call spreads):** loss capped at spread width minus credit received (defined-risk by construction) when held to expiry; 3x-credit buy-back stop (cuts a ~-$200 worst day to roughly -$120-150); one spread per symbol per day caps concurrent exposure to 2 spreads total (SPY+QQQ).
- **Not modeled — real risk at a live broker:** assignment of the short leg if finishing between strikes (a $2,000 account cannot carry 100 shares assigned); Robinhood's unconfirmed early-close behavior in the last 30 minutes, which is exactly when this strategy's profit is earned.
- **Sizing note:** reaching $25/day would need 5-6 spreads, i.e. $1,000-1,200 at risk daily on a $2,000 account — too aggressive for that account size. Two spreads (~$8-10/day average) is a size a $2,000 account could survive a bad day on.

**X9:** -30% premium stop per trade; QQQ take-profit at +70% premium; SPY trailing stop (arm +25%, give back 50% of peak); one open position per symbol.

**FP:** -50% premium stop; stop for the day after 3 losses in a row; flat by 11:30 ET regardless of P&L. (Retired 2026-11-18, `FP_ON=0`.)

**CDR (iron condor):** per-trade risk capped at $200 (incl. $20 fee/slippage reserve) via `CDR_TRADE_MAX`; per-trade stop $140 via `CDR_TRADE_STOP`; **daily reserved risk capped at $400** (`CDR_DAILY_MAX` — realized losses not offset by realized profits, plus open risk); **a $280 combined realized daily loss halts the book for the rest of that day** (`CDR_DAILY_STOP`). This is the most actively risk-budgeted book, appropriate given it has never been backtested. As of 2026-11-14 it also carries a shadow-log-only AI advisory layer with no effect on any of these numbers — see STRATEGY_REGISTRY.md.

**Wheel2 CSP:** defined-risk by construction (put credit spread, 1% width). Currently cannot lose real money — `WHEEL2_CSP_ON=0`, dry-run only.

## General operational risk notes (apply everywhere)

- A stop-loss is not a guaranteed loss cap: gaps, illiquidity, rejected orders, partial fills, and assignment/exercise exposure can all exceed the intended stop. A spread's defined payoff does not eliminate these operational risks.
- **Known gap, confirmed 2026-11-14: there is no broker-resident stop for options at Alpaca.** Checked their own docs directly (`options-trading-overview`): single-leg and multi-leg option orders support market/limit only — no bracket, OTO, OCO, stop, or trailing-stop order type exists for options at all. This means sweep's wick/trailing stop (and any other book's stop) is enforced entirely by the Render app; if the app or its connection to Alpaca goes down, an open position has **no floor at the broker** until the app reconnects. Not fixed — see DECISIONS.md 2026-11-14 and the unresolved question there about how to live with this before any live pilot (external watchdog process, tighter outage alerting, or accepting it as a documented risk).
- Highly correlated positions (e.g. SPY and QQQ moving together) should be treated as shared exposure, not independent risk, when sizing multiple books that could all be open at once. **Enforced in code as of 2026-11-14** — see the correlation-aware exposure cap above.
- Default to avoiding expiration/assignment exposure unless a strategy is specifically designed, tested, and approved to carry it (none currently are — all current books are flat before close or defined-risk by expiry).
- Contract multipliers and whole-contract sizing: if one contract's risk exceeds the approved budget for a book, skip the trade rather than round down.

## AI advisory layer (added 2026-11-14) — not a risk control, note on scope

The CDR AI trade-management overlay (see STRATEGY_REGISTRY.md) is shadow-log only: it has zero authority over any limit, stop, or exposure number in this file. It cannot loosen a limit, skip a stop, or approve risk this file doesn't already allow — by design, it can only ever defer to, or silently agree/disagree with, decisions the deterministic rules above already made. Listed here only so this file's own limits aren't mistaken for something the AI participates in enforcing.

## Security (standing, not a trading rule but enforced the same way)

- Never echo pasted Alpaca/Anthropic API keys or secrets in plaintext anywhere in chat.
- Never write them anywhere outside Render secret environment variables (not in code, not in project docs, not in Supabase).

## Not yet decided / needs James's approval before activating

- Restoring daily trade/loss limits for live (`ENFORCE_LIMITS`, or a live-specific set).
- Revised per-contract/per-spread dollar caps given real option costs.
- Whether/when `WHEEL2_CSP_ON` flips to 1.
- Any real-order pilot for CDR (only after it has a backtest and a sample).
- **How to close the no-broker-stop gap for options** before any live pilot (see "General operational risk notes" above).
- Whether/how to extend the AI advisory overlay beyond CDR shadow-logging, once there's enough shadow-decision history to judge it against CDR's own deterministic outcomes.

**2026-11-20 CSK2:** up to two CSK spreads per symbol per day (one per slot), so up to four open at once. The unchanged $500 correlation cap bounds this: with spreads risking about $140 each, a fourth concurrent SPY/QQQ spread is normally blocked and logged as skipped. No limit was changed. Raising the cap needs James's explicit yes.

**2026-11-20 correlation cap raised $500 -> $800 (James: "change the cap to fit our new strategy").** Value chosen by Claude, not specified by James: four concurrent CSK spreads (two slots x SPY/QQQ) risk about $540-$690 (width $200 minus credit $27-$67 each), so $500 would block most slot-2 entries. $800 leaves about $100-$250 of room for one other position. The cap is shared by ALL books on SPY/QQQ (Sweep, ORB, X9, FP, CSK, CDR), so this raises the combined ceiling for every book, not just CSK; ORB signals blocked by the old cap can now enter more often. Set as Render env `CORR_CAP_USD=800` (explicit, restarts the server). To revert: set `CORR_CAP_USD=500`.

## 2026-11-20 — CSK real orders (paper)
Deterministic checks before every real order: switch on, not halted, qty at most CSK_REAL_QTY (max 5), long strike beyond short, same expiry, options buying power at least max loss x qty (fail closed if the account read fails), daily real loss above -$540 (D3). One-lot limit orders only; ladder floor max($0.03, simulated natural - $0.05). Real stop exits step up $0.02 three times then retry every 30 s until 15:55 ET, then flagged `exit_failed` (still no broker-resident stop: gap remains). D2 pre-close exit at 15:40 ET for spreads at/above or within 0.10% of the short strike. Paper account only; no live key exists in this environment.

## 2026-11-23 — CSK real-order fixes (James: "yes to fixes")
(1) A real spread that shares an option contract with a live real spread is blocked, no order sent (Alpaca nets positions per contract and rejected the SPY slot 2 order 422). (2) After 16:02 ET each real spread's P&L is recomputed from Alpaca FILL activities (catches broker auto-liquidation; the old figure assumed expiry); the journal figure is kept as realPnlJournal. (3) Reconciliation ignores expired spreads (Alpaca lists expired legs until its overnight cleanup) but still halts on a missing or extra leg of an open spread. Not changed (needs James's yes): moving the 15:50 ET D2 pre-close earlier than Alpaca's own 15:45 ET auto-liquidation of near/in-the-money shorts. Correction to the 2026-11-23 review: QQQ slot 2 real P&L is -$4 (not about -$1) and the real day about +$126.
2026-11-23 (James: "if you think 15:40 is better than let's do that"): the D2 pre-close check for real CSK spreads moved from 15:50 to 15:40 ET (checked 15:40-15:44), ahead of Alpaca's own 15:45 ET auto-liquidation of near/in-the-money shorts. Rule itself unchanged (underlying at or above short strike x 0.999). Real orders only; simulated book still holds to expiry.

## 2026-11-24 — Manual close (operator control)
Any open server paper position can be closed by hand from the web page (RUNBOOK 2026-11-24). Safeguards: behind the existing key check, POST only, symbol validated, refused when the market is closed, two-tap confirmation in the UI, one close per position (shared tick lock). A manual exit of a CSK spread with real orders on exits the real spread on the same ladder as a stop. Manual trades carry reason `manual` / `manual close`; exclude them when judging a book's rules.

## 2026-11-24 — Real money (scaffold only, not connected)
Paper only remains the rule. The REAL page and `GET /api/real` report readiness only; every other `/api/real` call returns 403; the build has no live broker URL, no real order path, and never puts credentials in a response (`test/real_page.test.js`). Real-money limits (daily loss, size, quantity, kill switch) must be written here and implemented as deterministic code before step 5 of `REAL_TRADING_PLAN.md` starts.

## 2026-11-24 — Correlation cap raised to $1,200 and CSK given priority (James: "yes, raise the cap to 1200. 2. yes give csk priority")
`CORR_CAP_USD=1200` set in Render env at 12:42 ET (the code default is still $500, so the env var must stay set). Reason: on 2026-11-24 two X9 calls ($456) plus the two 11:00 CSK spreads left no room and both 12:30 CSK spreads were skipped at the $800 cap ("would push SPY-group open risk to $903"). Priority (code, `cskReservedUSD` + `prio` argument of `corrCapBlocks`): every book except CSK sees the room still owed to CSK entries not yet made, one spread's worst case ($160 for a $2 spread) per CSK symbol per slot whose window has not ended and whose done-flag is unset; CSK's own check ignores it; the reserve vanishes once a slot is entered, skipped or past its window. Tests: `test/csk_priority.test.js` (5). The cap must still rise with each size step (about $1,450 at step 4) and each change needs James's yes.

## 2026-11-24 — On-demand paper order limits
Quantity 1 to 3, at most 3 open, premium cap $400 per contract (worst case $1,200 per order, the full premium; no stop by default), entries 9:35 to 15:30 ET, forced flat 15:59 ET, counted in the SPY/QQQ correlation cap (so it cannot take the room reserved for CSK). Paper only; deterministic code; no language model involved. Any change to these numbers needs James's yes.
