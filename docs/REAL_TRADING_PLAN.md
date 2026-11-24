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

## 3. Open decisions for James
1. Which broker and account (Alpaca live or Robinhood)?
2. Which book goes first, if any (CSK is the only one with a real-order design so far)?
3. Starting size and daily loss limit for the first real day.

## 4. Known gaps carried forward
No broker-resident option stop (step 7). Alpaca closes near/in-the-money short options itself around 15:45 ET (seen 2026-11-23). Options fees on the real account are unmeasured. Paper fills are simulated and say nothing about live fill quality.
