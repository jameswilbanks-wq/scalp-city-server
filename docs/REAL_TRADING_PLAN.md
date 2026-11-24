# Real-money trading plan (Scalp City)

Status: **NOT STARTED. Nothing is connected.** Written 2026-11-24 after James asked: "set this up for real trading just like the paper account but we will not connect this to a real money account until we are fully ready and we have worked through all the steps." Linked from `DECISIONS.md`, `RISK_POLICY.md`, `PROJECT_STATE.md`. Supersedes nothing; it extends the CSK real order path spec (`csk-order-path-spec.md`, Phase 2 section). The paper-only rule in `CLAUDE.md` stays in force until James changes it in writing.

## 1. What exists today (verified in code and tests)
- A PAPER / REAL toggle at the top of the web page (`/?key=...`). PAPER is the default and is unchanged.
- A separate REAL page: red banner, connection status, empty account tiles, empty positions and trades tables, and the readiness list below. It has **no order or close buttons**.
- `GET /api/real` returns the status. Every other `/api/real` request returns 403.
- `realStatus()` always returns `connected: false` and `canOrder: false`. The build contains **no real-account code, no live broker URL and no order path**; the real credential names are only checked for presence and never put in a response. `test/real_page.test.js` locks these facts in.

## 2. Steps to work through, in order (each needs James's explicit yes before the next starts)
1. **Decision and rule change.** James writes the go-live decision and changes the paper-only hard rule in `CLAUDE.md` himself.
2. **Account and credentials.** Pick the broker and account. Real-account credentials (`REAL_ALPACA_KEY`, `REAL_ALPACA_SECRET`, or the chosen broker's equivalents) live only in Render env vars, never in code, docs, chat or Supabase. Do not connect the Alpaca live connector in this environment.
3. **Read-only connection.** Show balances and positions on the REAL page. They must match the broker app for at least 5 trading days. Still no orders.
4. **Real-money risk policy.** Max loss per day, max position size, quantity cap, kill switch. All deterministic code, never a language model (`RISK_POLICY.md`).
5. **Real order path.** Same design as the CSK paper order path (idempotent client ids, reconciliation, halts, ladder), built and proven against the Alpaca PAPER account first. Separate switch, default off.
6. **Forward paper evidence.** Each book that would go live meets its acceptance bar (CSK Phase 1: at least 20 trading days, at least 90% of entries filled for real, median slippage within $0.03, no unresolved mismatches or duplicates, stops executed). Backtest, out-of-sample, forward-paper and live results are reported separately, with fees and bid/ask.
7. **Stops that survive a restart.** Broker-resident stops, or an accepted alternative. Today no broker-resident option stop exists, so stops only run while the Render process runs.
8. **Account rules.** Fees, margin, options approval level, day-trade rules, tax lots checked for the real account.
9. **Dry run.** Kill switch and alerts tested. First day is 1 contract, a hard daily loss limit, and James watching.

## 3. Decisions (James, 2026-11-24)
1. **Broker/account:** James asked for a recommendation. Recommended: **Alpaca live** (the paper account and the whole CSK order path already use Alpaca's official API and `mleg` orders, so the real path is the same code with a different base URL and keys; Robinhood has no official options API). Needs Alpaca live options Level 3 approval (apply early: a denial can only be reappealed after 60 days). Final choice pending James's yes to the recommendation.
2. **First book:** **CSK only** (James: "yes csk only").
3. **Size ladder:** start at step 1 and step up by the rules below (James: "what you recommended as the start stepping up"). Table from the 2026-11-20 sizing discussion (lots each of SPY and QQQ; "backtest pace" is the realistic column; account size uses a 5% worst-day rule):

| Step | Lots each | Total spreads | Worst day | Account (5%) |
|---|---|---|---|---|
| 1 | 1 | 2 | -$270 | $5,400 |
| 2 | 2 | 4 | -$540 | $10,700 |
| 3 | 3 | 6 | -$800 | $16,100 |
| 4 | 5 | 10 | -$1,340 | $26,800 |
| 5 | 8 | 16 | -$2,140 | $42,900 |
| 6 | 11 | 22 | -$2,950 | $59,000 |
| 7 | 20 | 40 | -$5,360 | $107,000 |
| 8 | 42 | 84 | -$11,260 | $225,000 |

Step-up rules: move up one step only after at least 30 closed trades at the current size (about 15 trading days), an average over all trading days that is positive and at least half the backtest pace for that step, and no day worse than 1.5x the expected worst day. Step back one level if the running drawdown exceeds 10 days of average profit. Stop and review after any day losing more than the previous step's worst day. The $800 correlation cap must rise with each step (about $1,450 at step 4, $3,200 at step 6); each cap change needs James's explicit yes. Daily real-loss halt starts at $540 (2x the step-1 worst day) and is raised with each step. A `CSK_QTY` sizing setting (default 1) will be built only when the ladder is reached and with James's yes; nothing changes today. Starting real size therefore is **step 1: 1 lot each of SPY and QQQ, daily loss halt $540**.

**Done 2026-11-24:** James reports he has been approved for Level 3 options trading on his live account (reported by James; not verified from the broker, and assumed to be the Alpaca live account, to be confirmed when we reach step 2). This covers the options-approval part of step 8 only; fees, margin and day-trade rules there are still unchecked. Approval does not connect anything.

Still open: James's yes to Alpaca live (confirming it is the account that was approved), and the written real-money risk policy (step 4 above).

## 4. Known gaps carried forward
No broker-resident option stop (step 7). Alpaca closes near/in-the-money short options itself around 15:45 ET (seen 2026-11-23). Options fees on the real account are unmeasured. Paper fills are simulated and say nothing about live fill quality.
