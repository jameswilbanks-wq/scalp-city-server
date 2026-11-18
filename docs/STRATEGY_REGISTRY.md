# STRATEGY_REGISTRY.md — Scalp City

Last updated: 2026-11-18.

Specifications, versions, status, and results for every strategy. Rationale/approval dates are in DECISIONS.md; backtest detail is in EXPERIMENT_LOG.md; limits/suspension rules are in RISK_POLICY.md.

---

## Cross-book risk governor — correlation-aware exposure cap (added 2026-11-14)

Not a strategy of its own — a gate that applies to every book below before it opens a new position. Sweep, ORB, X9, FP (now retired), CSK, and CDR each have their own per-book risk rules, but SPY and QQQ move together, so several books being open on them at once creates combined exposure that no individual book's own cap sees. `server.js` sums each open position's estimated max-loss dollars by symbol group (`CORR_GROUPS`, default `SPY,QQQ`) across all books, and skips a new entry in **any** of them if it would push that group's combined open risk over `CORR_CAP_USD` (default $500 — a reasoned placeholder, flagged for James's confirmation, see RISK_POLICY.md). `CORR_CAP_USD=0` disables it. See RISK_POLICY.md for the full rationale and DECISIONS.md (2026-11-14) for the approval trail.

## AI trade-management overlay — shadow-log only, CDR only (added 2026-11-14)

Not a strategy or a trading authority — an advisory layer James asked to add, built from a Python prototype he supplied (`ai_trade_overlay.py`, saved in the project docs and ported to `ai_overlay.js` in the server repo). For each CDR entry candidate and each open CDR position, it asks Claude (via the Anthropic API) for an ENTER/WAIT/HOLD/REDUCE/EXIT opinion given a fact snapshot, and **only logs that opinion** to `cdrk.aiShadow` — nothing in any book's entry/exit/risk code reads it. It cannot invent or resize a trade, cannot override the deterministic exit engine (`base_exit` always wins without consulting the model), and fails safe to `DEFER` on any staleness, timeout, schema problem, invented-evidence citation, or logging failure. 7/7 safety tests pass without needing a live API key.

Scope was James's explicit choice on 2026-11-14: CDR only (not Sweep or CSK), shadow-log only (not acted on). Deployed commit `816c6de`, live but **inert** — `AI_OVERLAY_ON=0` by default and `ANTHROPIC_API_KEY` is not yet set on Render, so no shadow decisions have actually been logged yet. As of 2026-11-18, this is also explained by CDR having fired zero live trades in 8+ days (see the CDR section below) — there's been nothing to shadow regardless of the key. See RUNBOOK.md for the env vars and DECISIONS.md (2026-11-14) for why this design is compatible with the project's standing "deterministic code for order validation and risk enforcement, no unconstrained LLM as sole order authority" rule. Before any extension beyond CDR or any real effect, this needs the same validation discipline as any other strategy change — enough shadow decisions to judge against CDR's own deterministic calls.

## IB / "Levels" — Initial Balance Failed Auction & Trend Continuation — STAGE 0 FAILED, NOT ADVANCING

**Status: Stage 0 signal study complete (2026-11-14) and did NOT pass. No Stage 1 options backtest should be built on this signal as currently specified. Dormant unless re-specified with new evidence or a materially different rule set.**

**Source:** a YouTube video James shared. This session could not reach YouTube directly (hard network block in this container, confirmed via yt-dlp, WebFetch, and a third-party tool, all independently blocked) — a different Claude session with working video access watched it and wrote the proposal (`claude/ib-strategy-spec.md`). This session reviewed that spec critically rather than adopting it wholesale, and surfaced its flagged open decisions to James for approval before building anything.

**Hypothesis:** the first 60 minutes of trading (9:30-10:30 ET) sets an "Initial Balance" (IB) — a high (IBH), low (IBL), and midpoint (IBM) — that the rest of the day tends to interact with predictably. Two setups:
- **Failed Auction (FA):** price breaks outside the IB, fails to hold, closes back inside → trade reverts toward IBM.
- **Trend Continuation (TC):** the IB itself trended one direction; price later pulls back to IBM with an anchored-VWAP (AVWAP, from the 9:30 open) confluence and rejects → trade continues toward the IB extreme.

**James's approvals (2026-11-14), all three decisions the spec flagged as needing his sign-off:**
1. Build Stage 0 (the no-cost, no-options, no-trading-effect underlying-price signal study) — approved and built.
2. If Stage 0 passes and the project moves to an options expression later, use single-leg long calls/puts (same expression as Sweep), not a spread — approved, now moot since Stage 0 failed.
3. Block new IB entries that would oppose an already-open position in the same symbol — approved, now moot since Stage 0 failed.

**What was built:** `study_ib.js`, deployed commit `f54f31b`, kv key `bt24`, ran against real 5-minute Alpaca stock bars for SPY/QQQ (NOT options, no money, zero effect on any book). Computed IBH/IBL/IBM and an AVWAP, applied an IB-width-band filter and an AVWAP-chop-count filter, ran both setups with a stop-first tie-break, recorded outcomes as R-multiples with a flat 0.05R haircut, split dev (2024-03-01 to 2026-07-13) vs. holdout (2026-07-14 to 2026-11-13), and ran a ±25% parameter-sensitivity sweep plus a drop-best-5-trades robustness check.

**Result (see EXPERIMENT_LOG.md, `bt24`, for full numbers): FAILS the pre-registered pass criteria.** Dev expectancy is negative in all 4 setup/symbol combinations (avgR -0.007 to -0.294). Holdout looks positive on its face but every bucket falls short of the ≥40-signal minimum (n=7-38) and the apparent edge disappears when the best 5 trades are dropped from the combined sample (all 4 buckets go negative). The parameter-sensitivity sweep shows fragility (TC swings from strongly positive to strongly negative depending on which single parameter moves) rather than robustness. This is the same shape of false positive as `bt5` and `bt23`: a short, recent window with a few outsized winners dressed up as an edge.

**Explicitly not implemented for this run:** economic-event/holiday filters (CPI/PPI/FOMC/NFP) — doesn't change the verdict, since dev was already negative before that gap could help or hurt it.

**What would need to change before revisiting this:** either new evidence the FA/TC mechanical rules were mis-specified (e.g., the IB-width-band or chop-cross filter parameters are wrong in a way that's fixable, not just tuned-to-fit), or a genuinely different hypothesis — not re-running the same rules on more data. See `claude/brt-strategy-spec.md` for a related but distinct "levels family" hypothesis (break-and-retest, successful breaks rather than failed ones) currently under review — not yet approved or built.

## BRT — Break & Retest of Critical Levels — PROPOSAL ONLY, NOT APPROVED, NOT BUILT

**Status: a full spec exists (`claude/brt-strategy-spec.md`) but nothing has been built and James has not yet approved any of it. Same "levels family" as IB above (level-based, SPY/QQQ, early-session reference points) but a distinct, partly opposite hypothesis — IB fades failed breaks, BRT trades successful ones that hold through a retest.**

**Source:** a YouTube video ("I quit my job as a Teacher with this beginner friendly strategy," channel Bossupwiththehayes) that a different Claude session (without video access to this session, same situation as IB) watched and transcribed into a spec. That session explicitly could not reach this project's GitHub repo or Render deployment either, so it correctly scoped itself to writing the proposal only and flagged that the actual build has to happen in a session that has repo access (see RUNBOOK.md — this is a structural fact about which chat surfaces carry which tools, not a bug to "fix").

**Hypothesis:** support/resistance levels (pre-market high/low, previous-day high/low, hourly pivot highs/lows) that price breaks through and then successfully retests (old resistance holds as new support, or vice versa) tend to continue in the breakout direction. Two target levels, with 50% scaled out at the first and a runner toward the second.

**Full spec, pre-registered validation plan, and the open decisions below are in `claude/brt-strategy-spec.md`** — not duplicated here since nothing has been approved yet. Key points:
- Explicitly sequenced to read `bt24` (IB) first, which is now done — see above. IB's Stage 0 failure doesn't by itself disqualify BRT (it's a different, partly opposite hypothesis — successful breaks vs. failed ones), but the two should be tracked as one "levels family" for multiple-comparisons purposes per the spec's own section 7/section 11 item 5.
- Three ambiguous transcript readings flagged as needing confirmation (close-based break confirmation, entry-bar trigger rule, stop-to-breakeven after first target).
- Contract-count/scale-out economics flagged as depending on the same pending live-cap revision that gates IB's sizing.
- Would reuse the Stage 0 harness pattern from `study_ib.js`, as `study_brt.js` / kv `bt25`.

**Nothing moves on this until James answers the open decisions in the spec's section 11.** Still unstarted as of 2026-11-18 — attention this week went to the live-trading review (FP trend filter, CDR backtest) instead, at James's direction.

## Sweep (main book) — ACTIVE, real-order pilot — ⚠ lock-period backtest flag (2026-11-18)

**Hypothesis:** price poking through a recent range with a rejection wick tends to reverse.
**Underlyings:** SPY, QQQ. **Expiry:** 0DTE.
**Entry:** price pokes through the low or high of the prior 20 one-minute bars with a long wick, then closes back inside. A sweep of the low buys a call, of the high a put. Entries 9:45 AM-3:30 PM ET.
**Exit:** stop just beyond the wick on the underlying, then trails one stop-distance behind the best price (the "run" exit, adopted 2026-11-10). No profit target. Safety: -50% premium stop, flat before close.
**Execution:** since 2026-11-12, places **real market orders against Alpaca's own paper account** (not simulated fills) — a pilot to test fill-assumption realism. Hardcoded to `paper-api.alpaca.markets`; `SWEEP_REAL_ORDERS=0` reverts to simulated fills. **Known gap, confirmed 2026-11-14: Alpaca supports market/limit orders only for options — no broker-resident stop/bracket order exists to protect this position if the Render app itself goes down.** See RISK_POLICY.md "Known gap."
**Status:** the only active main-book trigger as of 2026-11-13 (EMA/VWAP/15-min-break retired, see below). One position at a time on the main book; cools down after a stop. Subject to the cross-book correlation cap above. 2026-11-18 live review: healthy, no change proposed or made.
**Per-symbol split (`bt8`, the live "run" exit, read 2026-11-18):** QQQ train n=863 avg $0.18/trade PF 1.02 → lock n=308 avg **-$2.67**/trade PF 0.81. SPY train n=1083 avg $0.70/trade PF 1.08 → lock n=473 avg **-$3.44**/trade PF 0.63. **Both symbols go negative in the lock/holdout period under the exit currently live.** QQQ is "less negative" than SPY, so there's no case here for isolating toward SPY, but neither symbol shows a real edge in this split — flagged as a blocker (see PROJECT_STATE.md) for a closer look, not yet investigated further.
**Results:** see EXPERIMENT_LOG.md (bt, bt3, bt4, bt8).

## EMA cross (main book) — RETIRED 2026-11-13

**Hypothesis:** a 1-minute close crossing the 50 EMA signals a new short-term direction.
**Entry (as last configured):** crosses agreeing with both EMA slope and VWAP side skipped (`EMA_FILTER`).
**Exit (as last configured):** dollar exits (+$25 target, -$20 stop, trail, 15-min time stop, 1 ATR underlying stop, EMA-recross exit, flat before close).
**Status:** still coded (`TRIGGERS=ema` or `all` would re-enable), but retired by James's decision after three separate studies (`bt`, `bt2`/`bt3`, `bt23`) found no profitable entry/exit/timeframe/filter combination on SPY or QQQ. `bt23` specifically tested 60 combinations (5 EMA period/timeframe pairs × fresh-cross filter on/off × 3 exits × 2 symbols) and cleared breakeven on zero of them. Also specifically checked and rejected the idea that EMA does better on QQQ than SPY (statistically indistinguishable average PF over the full backtest, despite a live 5-day sample looking that way). No path back to being trusted without new evidence.

## VWAP cross (main book) — RETIRED 2026-11-13

Never had a real edge in any study (`bt`, `bt2`). Retired alongside EMA.

## 15-minute-break (main book trigger) — RETIRED 2026-11-13

**Not the same thing as the separate ORB book below** — this was a main-book trigger variant, superseded functionally by the dedicated ORB book anyway. Retired alongside EMA/VWAP.

## ORB — opening-range breakout (own book) — ACTIVE

**Hypothesis:** a decisive break of the opening range tends to continue.
**Underlyings:** SPY, QQQ. **Expiry:** 0DTE. One trade per symbol per day.
**Entry:** range = 9:30-9:44 ET (15-minute version, adopted 2026-11-12 over the original 5-minute version). First 15-minute candle close beyond the range (candles starting 9:45, 10:00, ..., last one starting 15:00) buys a call (above) or put (below).
**Exit:** stop at the opposite side of the range; target 1.25R; stop moves to entry once +0.5R (underlying-based, "breakeven" exit reason); flat before 3:30 PM ET; -50% premium stop.
**Env:** `ORB_ON` (on/off), `ORB_MODE` (5 or 15, currently 15), `ORB_R` (1.25), `ORB_BE` (0.5).
**Signal detection (changed 2026-11-18, commit `7d78f9b`):** `orb15.js` returns the first closed 15-minute candle beyond the range, so a slow tick or restart no longer loses the day; stale signals and incomplete opening ranges are logged as skips. Trade rows now also record `entryBid`, `exitAsk`, `spreadIn`, `spreadOut`, `delta`, `iv`. Entry/exit rules unchanged.
**Results:** `bt13` — positive in 2024-25 and 2026 on both symbols, ~+$7.50-9/trade, PF 1.11-1.19 (edge fragile: ~$3-5/trade without the best single trade; config chosen from a ~24-variant grid). Subject to the cross-book correlation cap above. 2026-11-18 live review: 7 live trades net -$279; statistically consistent with the thin backtest edge. Exit study `bt27` proposed, not approved: see `orb-exit-study-spec.md`.
**Per-symbol split (`bt13`, adopted config `e15|t1|be1`, read 2026-11-18):** QQQ train n=449 avg $6.39/trade PF 1.11 → lock n=214 avg $6.00/trade PF 1.07. SPY train n=452 avg $3.53/trade PF 1.07 → lock n=215 avg $5.49/trade PF 1.08. QQQ is ahead in both periods but the gap is modest and converges further in the lock period ($6.00 vs $5.49) — a much smaller QQQ-vs-SPY split than CSK or X9 show.

## CSK — call credit spreads (own book) — ACTIVE

**The only 0DTE idea with a full real-price validation so far.**
**Hypothesis:** selling a same-day call spread well out of the money and holding to the close captures premium decay with a defined, capped loss.
**Underlyings:** SPY, QQQ. **Expiry:** 0DTE. One spread per symbol per day.
**Entry:** at 11:00 ET, sell the call nearest 0.45% above price, buy the call $2 higher. Fill at the natural price (sell at bid, buy at ask); mid also recorded.
**Exit:** held to the close, settled on last price capped at the width; OR bought back if the spread mid reaches 3x the entry credit on two consecutive fresh reads (3x stop, adopted after `bt9`).
**Not modeled:** assignment of the short leg; Robinhood's early-close behavior in the last 30 minutes (open question, see PROJECT_STATE.md).
**Env:** `CSK_ON`, `CSK_SYMS`, `CSK_PCT` (0.0045), `CSK_WIDTH` (2), `CSK_MIN` (660 = 11:00 ET), `CSK_STOP` (3).
**Results:** `bt6`, `bt7`, `bt9` — positive in both tuning and locked periods on both symbols; SPY $2-wide +$4.36/+$3.60 per spread/day (train/lock), QQQ $2-wide +$5.66/+$4.62; 85-91% win rate; worst day ~-$120-150 with the 3x stop. Subject to the cross-book correlation cap above (risk measured as width minus credit received). 2026-11-18 live review: healthy, no change proposed or made. **Per-symbol verdict (read again 2026-11-18): QQQ clearly ahead of SPY in both the tuning and locked periods** — the largest, most consistent symbol split of any active book.

## X9 — EMA9×VWAP crossover (own book) — ACTIVE, per-symbol exit split

**Hypothesis:** from a creator reel (@austin.daytrades). EMA9 crossing above/below a VWAP-like average signals direction.
**Underlyings:** SPY, QQQ (falls back to `CFG.syms`, so inherits the IWM exclusion). **Expiry:** 0DTE.
**Entry:** EMA9 crossing above VWAP → buy same-day ATM call; crossing below → buy put. Entries 9:45-15:30 ET, one open position per symbol.
**Exit:**
- **QQQ:** flat **70% take-profit** on the premium (env `X9_TP_SYMS=QQQ`, `X9_TP_PCT=70`) — adopted 2026-11-13 after `bt22` showed this beats the trail on QQQ specifically (avg $9.14/trade, PF 1.33 vs. trail's $5.53/PF1.25).
- **SPY (and any symbol not in `X9_TP_SYMS`):** original trailing stop — arm once up `X9_TRAIL_ARM` (25%), give back `X9_TRAIL_GIVE` (50%) of the peak. Every flat-TP level tested lost on SPY.
- Other exits regardless of symbol: 1-minute close back through EMA9 against the trade (level), opposite cross (reverse), -30% premium stop, flat before close.
**Env:** `X9_ON`, `X9_SYMS`, `X9_STOP` (30), `X9_TF` (5), `X9_TRAIL_ARM` (25), `X9_TRAIL_GIVE` (0.5), `X9_TP_SYMS` (QQQ), `X9_TP_PCT` (70).
**Results:** `bt11`, `bt15` (entry verification), `bt22` (exit redesign, led to the split). Subject to the cross-book correlation cap above. 2026-11-18 live review: too little live data yet to act on, no change. **Per-symbol verdict (re-confirmed 2026-11-18): QQQ clearly ahead of SPY even when each symbol uses its own individually-optimized exit** — avg $9.14/trade PF 1.33 (QQQ, flat TP) vs. avg $5.53/trade PF 1.25 (SPY, trail) — this is exactly why the per-symbol exit split exists.

## FP — fair pricing theory (own book) — RETIRED 2026-11-18

**Hypothesis:** from a JJ Simon video (NQ futures). The 9:30 ET open is treated as "fair price"; the market tends to either continue away from it or revert back to it depending on the first candle's shape.
**Underlyings:** SPY, QQQ. **Expiry:** 0DTE.
**Entry (as last configured):**
- *Continuation:* once per day, off the first 1-minute candle's color, only if it agrees with the overnight-gap bias.
- *Reversion:* a displacement candle back toward the open (body bigger than previous, close beyond previous wick).
**Exit (as last configured):** continuation — underlying stop 0.10%/target 0.15% (doubled if first candle is wide); reversion — stop 0.10%, target = the open (only if ≥1.5x the stop away); stop for the day after 3 losses in a row. Window 9:31-11:00 ET entries, flat by 11:30 ET, -50% premium stop.
**Env:** `FP_ON` (now `0`), `FP_SYMS`, `FP_STOP` (0.10), `FP_TGT` (0.15), `FP_BIAS`.
**Results:** `bt14` (original pre-live check). Subject to the cross-book correlation cap above while it was active.

**2026-11-18 live-trading review finding:** James observed FP "does well in up markets, does horrible in down swings." Reading raw trade-level JSON confirmed a concrete mechanism, not just a correlation: the continuation leg (which bets *with* intraday direction) stops firing on strongly trending days, while the reversion leg keeps firing and is structurally a bet *against* a sustained trend (betting price snaps back to the day's open). During the observed Nov 13-18 downtrend this meant repeated losing "bet it bounces up" reversion trades. Separately, some trades tagged `"reason":"target"` still showed negative option P&L — not a bug: FP's targets are tiny (0.10-0.15% of the underlying), which can be smaller than real bid/ask spread + theta on a 0DTE contract, so the underlying hitting its target line doesn't guarantee the option trade made money.

**`bt26` (study_fp_trend.js, deployed 2026-11-18, James-approved) tested a trend-filter fix for the first finding:** a trend filter computed only from closed prior days (no look-ahead) that can suppress a reversion trade, or block all reversion on a confirmed-trend day. Variants: `base` (reproduces live), `trend3`/`trend5` (skip a reversion trade whose direction opposes a confirmed 3-/5-day trend), `contOnly3`/`contOnly5` (skip *all* reversion on a confirmed-trend day, direction-blind). **Result: none of the four filtered variants clear breakeven across the full 2024-2026 history, on either symbol, in either the dev or lock period.** The reversion leg's edge is negative on its own terms — a trend filter changes *which* losing trades get skipped, not whether the underlying edge is positive. This rules out "it only loses in trends, filter the trends and it's fine" as a fix.

**Decision (James, 2026-11-18): retire/pause FP rather than attempt further fixes** — "it doesn't sound like any fix will help." `FP_ON=0` set as a Render env var; confirmed to leave any already-open FP position unaffected (exits still run through `fpManage()`, which was already independent of the `FP_ON` gate — only new entries via `fpLook()` are blocked), and confirmed to go out with zero open FP positions at the time of the change. No code change — the gate already existed. The book stays dormant (`FP_ON=1` would re-enable it with the unchanged, un-fixed logic) unless a materially different hypothesis emerges.

## CDR — opening-range iron condor (own book) — ACTIVE LIVE, FIRST BACKTEST RUN, LEFT RUNNING AS-IS

**Hypothesis:** ported faithfully from a prototype James provided (`bot.py`). A choppy opening hour sets up a range-bound midday that an iron condor can monetize.
**Underlyings:** SPY, QQQ. **Expiry:** 0DTE. One attempt per symbol per day.
**Entry condition:** first opening hour (9:30-10:30 ET) must look choppy — range width 0.15%-1% of midpoint, crossed ≥3 times, rejection wicks near both edges.
**Entry:** 70-180 minutes after open, while price is back in the middle half of the range, sell an iron condor: short strikes beyond the range by $0.50 or 10% of range width (whichever larger); wing width ($1/$2/$3) chosen for best credit-to-width ratio (credit ≥$0.20 and ≥20% of wing width).
**Exit:** 50% profit target; $140/trade stop (incl. $20 fee/slippage reserve); two consecutive 5-min closes outside the original range; time exit 70 min before close.
**Execution:** simulated fills (unlike the prototype's real paper orders) — deliberate, since CDR is unvalidated and every other book started on simulated fills before any real-order pilot.
**Env:** `CDR_ON`, `CDR_SYMS`, `CDR_FEE` (20), `CDR_TRADE_MAX` (200), `CDR_DAILY_MAX` (400), `CDR_TRADE_STOP` (140), `CDR_DAILY_STOP` (280).
**2026-11-18 live-trading review finding:** zero CDR trades had fired in 8+ live-paper days (Nov 9-18). Surfaced independently of James's original question and prioritized for a first-ever backtest to answer whether this silence is expected rarity (the chop-gate genuinely is this strict/rare) or a likely bug in the gate/signal logic.
**`bt16` (study_cdr.js, deployed 2026-11-18, James-approved) is CDR's first dedicated backtest.** Replicates the live chop-gate + condor-selection logic on real historical 1-minute SPY/QQQ bars and real historical option-bar closes (close stands in for both sides of the fill — same approximation precedent as every other options backtest in this project; Alpaca's historical options-bars endpoint has no bid/ask history). Includes diagnostic gate-pass/fire-rate counters (`out.gate`). **Result: thin/inconsistent** — not a clean pass or a clean fail on the gate-rarity-vs-bug question. A general 0DTE condor failed in `bt6`, but that was a plain fixed-time condor, not this chop-gated design — doesn't settle the question either way.
**Decision (James, 2026-11-18): leave CDR running live-paper exactly as-is, no action.** "Let's leave CDR alone for now and let it run. It's not hurting anything." Zero trades means zero cost either way; revisit once more live days accumulate or the backtest is redone with tighter gate diagnostics.
**AI overlay (added 2026-11-14):** CDR is the first (and so far only) book with the shadow-log AI trade-management overlay attached — see the "AI trade-management overlay" section above. Still inert as of 2026-11-18 — partly the pending API key, but also still explained by CDR having zero live positions to shadow.

## Wheel2 CSP — monthly QQQ put credit spread — DRY-RUN ONLY (not trading)

**Hypothesis:** classic monthly premium-selling, defined-risk version (spread instead of naked CSP) so it fits a smaller account, built off the best-looking `bt21` bucket.
**Underlying:** QQQ (env `WHEEL2_CSP_SYM`). **Cycle:** monthly, 1 contract (env `WHEEL2_CSP_QTY`).
**Structure:** short put 2% OTM (env `WHEEL2_CSP_OTM`), long put 1% further out (env `WHEEL2_CSP_WIDTH`).
**Execution:** decision logic runs every trading day regardless; result logged to Supabase `wheel2_csp_dryrun`. **`WHEEL2_CSP_ON=1` required to place real orders** against the isolated Wheel2 Alpaca paper account ($4,000) — **currently 0 (off)**. Not yet wired into the cross-book correlation cap (it's a monthly cycle, not an intraday book, and is still dry-run only).
**Status:** approved by James 2026-11-13 as a dry-run to *watch*, explicitly despite thin evidence — see EXPERIMENT_LOG.md (`bt21`) for the data-quality caveat (only 12 monthly cycles, study's own run never reached "done", 286 errors). First dry-run signal: QQQ short $665 put / long $660 put, Dec 18 expiry, credit $1.45.
**Open decision:** whether/when to flip `WHEEL2_CSP_ON=1` (see DECISIONS.md unresolved questions).

## Wheel (first wheel-research account) — INACTIVE

Separate Alpaca paper account (`WHEEL_ALPACA_KEY_ID`/`WHEEL_ALPACA_SECRET`), read-only boot check only. `WHEEL_ON=1` would be required for real orders — no entry/exit logic has been written for this account; Wheel2 (above) is the one with an actual signal. Not yet decided whether Wheel2 replaces this account or the two sit alongside each other.

## Shadow test (not a real strategy)

Every main-book entry also opens a 1-contract hypothetical copy with tight percent exits (-12% stop, +40% target, trail arms at +5%) for comparison. Never affects anything real. (Not to be confused with the CDR AI overlay's "shadow-log" mode above — different mechanism, same spirit: observe without affecting real trades.)

## Day-type (chop/trend) regime router — IDEA ONLY, NOT BUILT

Raised by James 2026-11-12: use the existing `CHOP_MAX` chop proxy to automatically pause/enable individual strategies by market regime, rather than as a single global on/off gate. Needs an offline study segmenting existing backtests by regime before any live wiring. Not started.

## Per-symbol (SPY vs. QQQ) performance — cross-book summary (added 2026-11-18)

James asked whether the active strategies do meaningfully better on SPY or QQQ, as groundwork for eventually isolating capital/strategies by symbol once live with real money. Answered from each book's own large-sample backtest (hundreds of trades per symbol, train/lock split) rather than the 8-day live sample (n=3-22/bucket across all books — far too thin to be the basis for this). Summary (see each book's own section above for the numbers):

- **CSK:** QQQ clearly ahead of SPY, both periods (bt6/bt7/bt9).
- **X9:** QQQ clearly ahead of SPY, even using each symbol's own best exit (bt22) — the reason the per-symbol exit split exists.
- **ORB15:** QQQ modestly ahead, gap converges further in the lock period (bt13).
- **Sweep:** both symbols show a *negative* average and PF<1 in the lock/holdout period under the live "run" exit (bt8) — QQQ is "less negative" but neither shows a real edge; this is a red flag about Sweep's exit robustness, not a usable symbol split.

**No case emerged for isolating capital toward SPY anywhere.** QQQ is at or ahead of SPY in every active book studied. **Nothing has been implemented from this** — it's evidence for a future live-trading capital-isolation decision, not a change to any book's current configuration.

## Retired/rejected candidates

- Single-stock 0DTE (PLTR, NVDA, TSLA) — lost $5-9/trade under every sweep exit tested (`bt8`).
- Put credit spreads and iron condors at a fixed time of day (general 0DTE form) — failed the locked period (`bt6`); doesn't settle CDR's narrower design.
- Extended-hours scanning (`EXT_SYMBOLS`) — never produced a trade, no usable pre-market option quotes on the free feed.
- **IB / "Levels" (Failed Auction / Trend Continuation)** — Stage 0 failed `bt24` (2026-11-14): negative dev expectancy across all setup/symbol combinations; holdout's apparent edge was driven by a handful of oversized winners, not a real pattern. See the dedicated section above for full detail. Not re-tried without new evidence.
- **FP (fair pricing theory)** — retired 2026-11-18: live review found the reversion leg losing repeatedly in a sustained downtrend; `bt26` showed this is a structural negative edge across all history, not fixable with a trend filter (4 variants tested, none clear breakeven). See the dedicated section above for full detail.
