# CSK real order path (Alpaca PAPER first): build spec

Status: **DRAFT FOR JAMES'S REVIEW. Not approved, not built.** Written 2026-11-20 after James asked how to go live and said "yes" to drafting this spec. Facts, assumptions, open decisions and things only James can do are kept separate. **This spec covers Phase 1 only: real multi-leg orders against the Alpaca PAPER account. Going live with real money is Phase 2, listed in section 9 as gates only, and needs a separate explicit decision and a change to the paper-only rule in `CLAUDE.md`.**

## 1. Why
CSK is the only book with a full real-price validation, and the plan (PROJECT_STATE goal ladder) is "30-60 trades, then go live small". Today CSK places **no orders at all**: it books simulated natural fills (`cskLook`/`cskClose` in `server.js`). Going live safely means first proving a real order path, in paper, that behaves like the simulated book and tells us what real fills would cost.

## 2. Verified facts
- **Existing order plumbing** (`server.js`): `apTrade` posts to a **hardcoded paper base URL** (`ALPACA_PAPER_TRADING_BASE`, "paper-api.alpaca.markets"); helpers `alpacaBuyLimit`, `alpacaSell1`, `alpacaOrderStatus`; the Sweep pilot uses them with `client_order_id`s, a 30-second limit entry that is cancelled if unfilled (`SWEEPX_LIMIT_MS`), and a poller `pollSweepReal`. Keys come from `ALPACA_KEY_ID`/`ALPACA_SECRET` (Render env only).
- **Alpaca multi-leg API** (docs.alpaca.markets "Options Level 3 Trading", researched 2026-11-20): multi-leg orders go to the standard orders endpoint with `order_class: "mleg"` and a `legs` array (symbol, side, ratio quantity, position intent such as `sell_to_open`/`buy_to_open`). Spreads need Level 3 approval; a denial can only be reappealed after 60 days. Paper accounts have options on by default; live accounts need an approval request.
- **Known gap** (`docs/RISK_POLICY.md`): no broker-resident stop exists for options at Alpaca, so the CSK 3x stop exists only while the Render process runs. A spread's loss is capped at width minus credit, so an outage cannot produce an unbounded loss, but it can produce a full-width loss.

## 3. Unknowns to settle by test on paper (Phase 1 step 0)
1. Does the paper environment accept `mleg` orders for SPY/QQQ call spreads?
2. Sign convention of `limit_price` for a net credit (positive or negative).
3. Whether stop or market orders are allowed for `mleg`; whether a cancel-replace works on them.
4. How Alpaca treats a short call that finishes in the money at expiry (assignment/exercise, and what it does automatically).
5. Fees on options orders (none are in any P&L here yet).
These are answered by a scripted test order on paper, results written to `docs/EXPERIMENT_LOG.md` before any build proceeds.

## 4. Design (Phase 1: paper only, 1 lot, shadowing the simulated book)
- **Switches:** `CSK_REAL_ON` (default `0`, off), `CSK_REAL_QTY` (default 1; this is also the ladder quantity). The paper base URL stays hardcoded; a test fails if any other trading base URL appears in the code. No live key is read or stored.
- **Simulated book unchanged.** The real path runs alongside it. Every CSK entry decision (window, strikes, 3-cent minimum credit, stale-quote gate, correlation cap) is made by the existing code first; only then, if `CSK_REAL_ON=1`, a real order is attempted. The simulated record remains the reference for comparison.
- **Entry order:** one `mleg` limit order, legs `sell_to_open` short call and `buy_to_open` long call, ratio 1, `time_in_force: day`, `client_order_id = csk-{SYM}-s{slot}-{date}` (idempotent: a restart can never send it twice). Limit starts at the quoted **mid** credit and steps toward the **natural** credit every 15 seconds, at most 3 steps, never below `max(0.03, simulated natural credit - 0.05)`. Not filled after 60 seconds: cancel, record `no fill`, take no position.
- **Exit orders:** stop (mid at least 3x credit on two consecutive fresh reads, as today): `mleg` buy-to-close limit at the natural debit, stepping up to 3 times (+$0.02 each, 15 seconds apart); if still unfilled after 60 seconds, flag `UNFILLED STOP` on the Board and keep retrying every 30 seconds until 15:55 ET (a single-leg fallback is only designed if the unknowns in section 3 permit it). Expiry: no order; positions are left to expire as in the simulation, subject to open decision D2.
- **Reconciliation (every poll):** compare Alpaca order status and positions with `rec.csk.open`. Any mismatch (unexpected position, missing leg, quantity different from intended) **halts new real orders for the day** and posts a Board alert. On boot, rebuild state from Alpaca by `client_order_id` so a restart cannot orphan or duplicate a position.
- **Deterministic risk checks before every real order (no model involved):** `CSK_REAL_ON=1`; quantity at most `CSK_REAL_QTY`; defined-risk structure only (long leg strictly further out of the money than the short, equal expiry); buying power from the account endpoint at least the spread's max loss; daily realized real loss under the daily limit (D3); correlation cap unchanged.
- **Journal:** `rec.csk.real` stores each order (ids, requested limits, status transitions with timestamps), fills, time to fill, and **slippage versus the simulated natural fill**, per trade.
- **Weekly comparison report** (read-only): real vs simulated, per slot and symbol, average over all trading days: fill rate, slippage per spread, P&L difference. Alpaca paper fills are themselves simulated, so this proves the plumbing and gives a first look at fill sensitivity, **not** live fill quality.

## 5. Tests (plain Node scripts, mocked Alpaca; mutation-checked like the other books)
Payload builder (legs, ratio, intent, id format, price formatting); price ladder and floor; order state machine (new, partially filled, filled, cancelled, rejected, expired); idempotency (same id never sent twice); restart reconciliation; mismatch halt; kill switch; risk checks; source guard (only the paper base URL; no key echoed); `CSK_REAL_ON=0` sends nothing.

## 6. Acceptance for Phase 1 (judged after at least 20 trading days of real-paper orders at 1 lot)
1. At least 90% of simulated entries produce a real filled order.
2. Median entry slippage no worse than $0.03 per spread versus the simulated natural credit (reported at the median and the worst decile).
3. Zero unresolved reconciliation mismatches; zero duplicate orders; the kill switch tested on a trading day.
4. Every stop that fired in the simulation was also executed for real (or its failure is explained).
5. The section 3 unknowns are answered and documented.

## 7. Open decisions for James
- **D1:** approve the entry/exit price ladder (mid, then toward natural, 15 s x 3, 60 s timeout)?
- **D2:** close in-the-money (or nearly in-the-money) spreads shortly before the close to avoid assignment, instead of letting them expire? This changes behaviour relative to the backtests and needs its own study; Phase 1 only logs "would close" decisions.
- **D3:** daily real-loss halt (suggest 2x the step-1 expected worst day, about $540, to be raised with each ladder step).
- **D4:** confirm Phase 1 uses the existing Alpaca paper keys (no new keys).

## 8. Things only James can do
- Apply for **Alpaca live options approval (Level 3)** early, since a denial can only be reappealed after 60 days, and ask Alpaca support the unanswered questions (minimum equity, fees, handling of expiring in-the-money spreads, margin account type).
- Never paste keys into chat; live keys, when the time comes, go only into Render environment variables.

## 9. Phase 2 (real money): gates only, NOT approved, NOT part of this build
At least 30-60 closed CSK trades with a positive average over all trading days; Phase 1 acceptance met; assignment policy decided and tested; a real-money daily loss limit and kill switch agreed in writing; `CLAUDE.md` paper-only rule changed by James explicitly; separate live keys in Render only; start at ladder step 1 (1 lot each) with the same step-up rules. The live Alpaca connector in this environment stays disconnected.

## 10. Rollout
Build with `CSK_REAL_ON` default off; tests first; deploy outside market hours; enabling it is a separate yes from James. No change to the simulated CSK book, its backtests, strikes or stops.
