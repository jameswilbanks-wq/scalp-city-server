# PROJECT_STATE.md — Scalp City

Last updated: 2026-11-19, after `bt28` (ORB15 options expression) and `bt29` (ORPB Stage 0) finished and both failed their pre-registered criteria, and `bt30` (Sweep variants) was approved and deployed; previously 2026-11-18, ORB15 detection fix and the move to Claude Code.

This file is the "where are we right now" snapshot. For strategy specs see STRATEGY_REGISTRY.md, for why decisions were made see DECISIONS.md, for limits see RISK_POLICY.md, for backtest results see EXPERIMENT_LOG.md, for how to run/deploy/pick this up see RUNBOOK.md.

## Phase

**Paper trading only.** No live trading has started anywhere. Two things place real orders, but only against paper accounts:
- Sweep (main book) → Alpaca's own paper account.
- Wheel2 CSP → currently **off** (`WHEEL2_CSP_ON=0`); dry-run signal logging only.

Overall plan stage: Stage 1 of 5 — "prove something works" (see the goal ladder below). The call-spread book (CSK) is still the only 0DTE idea that has passed a proper real-price backtest with the full project's dev/holdout discipline; CDR now has its first backtest too (see below).

## The goal (set by James, 2026-11-11)

Income of about $4,000/month from options, reached step by step. 0DTE options only in the trading account; long-term/premium-selling strategies (the wheel) are a separate bucket for once the account is larger. Working target capital: about $300,000 at ~15%/year. Stages:

1. **Now to ~$5,000:** prove something works (CSK book, 30-60 trades, then go live small).
2. **$5,000-$25,000:** scale what's proven, worst day under ~5% of account.
3. **$25,000-$100,000:** start the wheel small as a side book (early groundwork started Nov 13 — two paper accounts, four backtests, one dry-run signal, see STRATEGY_REGISTRY.md "Wheel2 CSP").
4. **$100,000-$300,000:** shift weight toward premium selling.
5. **$300,000:** the $4,000/month target (15% ≈ $45k/year, uneven).

Contribution amount not yet set by James. Yields are historical/estimated, not promised.

## 2026-11-19 (night) — Sweep improvement pack (SWEEPX) live from 2026-11-20; strategy version sweep-run-2

James approved ideas 1, 2 and 4 from the Sweep discussion, all live at once for 2026-11-20 ("we can see which of these improves or not and adjust"). **Untested hypotheses, not a validated edge.** Basis: bt30 showed the live rule beats a coin flip by only about $0.50-$2 per trade and loses after costs at both $0.01 and $0.03 per fill. (1) Cost: entry is a limit order at the quote mid rounded up to the cent (never above the ask), canceled after 30 s and not chased (exits stay market); skip if the quoted spread is above $0.03; signal bars only 10:00-14:59 ET. (2) Levels: the sweep bar must also poke through and close back across the prior-day high/low or the 9:30-9:44 opening-range high/low (a filter on the existing signal; premarket levels are not in the feed). (4) Volume: sweep-bar volume at least 1.5x the mean of the prior 20 bars. Thresholds fixed in advance, missing data fails open. Every sweep signal (taken, blocked, no contract) is journaled in `r.sweepx` of the day's `rec:` row with its features, the blocking gates and the limit-fill outcome, so each idea can be judged separately later. `SWEEPX_ON=0` restores the old behavior exactly (original data and `sweep-run-1` rows are untouched). Expect far fewer trades than before: the gates stack. Test `test/sweepx.test.js` (21 pass, two deliberate breakages caught).

## 2026-11-19 (night) — ORBN (bt28 variant C) deployed as a simulated paper book; Sweep variants NOT built

James asked to deploy bt28 for tomorrow morning. `bt28` variant C (the ORB15 signal on the NEXT listed expiry, about 1DTE) is now a simulated paper book, **ORBN** (`orbnk` in the day's `rec:` row), so forward data at real quotes accumulates. **bt28 C failed its pre-registered criteria** (QQQ lock +$2.97, 95% interval -$26.27 to +$34.54; SPY +$6.13, -$12.66 to +$27.14, at $0.03 per leg per fill), so this is data collection, not a validated edge; bt28 B (debit vertical) was not built (negative on both symbols). Same ORB15 signal/entry/stop/1.25R/+0.5R break-even/15:30 flat as ORB, 1 contract, $150 premium cap, simulated fills (sell at bid, buy at ask). It is NOT counted in or blocked by the correlation cap, never touches ORB/Sweep/other books, fails open, `ORBN_ON=0` turns it off. Code: `orbnLook`/`manageOrbN` block in `server.js` plus an optional `dteOverride` argument on `pickContract` (no existing caller passes it). Test: `test/orbn.test.js` (13 pass). Sweep variants (bt30): **none built**. At $0.03 per fill every variant AND the live control S0 lose in both dev and holdout on both symbols (holdout avg -$4.53 to -$10.07/trade, PF 0.34-0.72); the live Sweep pilot and all its data are untouched. Awaiting James's decision on whether to run any Sweep variant as a shadow book.

## 2026-11-19 (night) — Triple RSI added as a DRY-RUN-only Render cron (James approved dry run)

Daily-bar RSI(5) mean-reversion on SPY/QQQ (Python, independent of `server.js`; see `TRIPLE_RSI_README.md`). Deployed as a separate Render cron job (`triple-rsi-dryrun`), weekdays after the close, `mode: DRY_RUN`: it records would-be decisions in the Render job log and **sends no orders and holds no broker credentials**. James first chose paper orders on the main Alpaca paper account, then chose dry run instead. Known limitation: a Render cron's disk is ephemeral, so the executor's state file (positions, idempotency) does not survive between runs; the decision for each day is still logged, but a hypothetical position is not carried to the next run, so exit signals will not appear. Persisting state (Supabase `scalp.kv`) is the prerequisite for PAPER mode and is not built. First local dry run showed a SPY entry signal on the 2026-11-18 bar; the data source (yfinance) had no 2026-11-19 bar at 20:00 ET. 60 Python tests pass. No effect on any Node book.

## 2026-11-18 (night) — eval-harness Part 2, step 1: richer trade-log fields on the MAIN (Sweep) book, deployed alone (cherry-picked from branch `eval-harness`)

Main-book trade rows (`closePaper`) now also carry, as optional fields: `quotedBid`, `quotedAsk` (kept separate from the fill price, because with `SWEEP_REAL_ORDERS` on the fill overwrites `entryAsk`/`entryBid`), `spreadIn`, `slippageVsMid`, `exitAsk`, `spreadOut` (same names ORB rows already use), `holdMinutes`, `mfe`, `mae` (option dollars, full position, from monitoring-tick bids, so approximate), `strategyVersion` (`sweep-run-1`; other triggers `main-<trig>-1`; bump on any material change) and `signalId` (`sym|trig|signal time`; signal rows do not carry it yet, so reconciliation is still by time). Additive only and fail open: no entry, exit, sizing or risk change; a helper returns `{}` on any error. Tested against the original `closePaper` on 48 cases (identical rows once the new fields are stripped) in `test/trade_row_extras.test.js`. Deployed with no position open in any book, market closed. **Not yet done:** ORB, X9, FP, CSK, CDR and the shadow book (one at a time); acceptance criteria 4 and 5 stay open until live rows are checked for nulls and a before/after trade-count comparison is made. The rest of the harness (branch `eval-harness`) is not merged.

## 2026-11-18 — workflow change: moving code work to Claude Code

James decided (afternoon of Nov 18) to move code, deploy and records work from chat into Claude Code, with this `docs/` folder and a repo-root `CLAUDE.md` as the source of truth, and to keep chat for research, video-spec handoffs and quick questions. Setup steps were given to him; the first Claude Code session should verify it can read Supabase `notes`, list Render deploys, and run `node --check server.js` plus the tests. The Alpaca Live and Robinhood connectors are deliberately not to be connected in Claude Code. `RUNBOOK.md` and the morning-review prompt still describe the chat-based setup and need repointing.

## 2026-11-19 — bt28 (ORB15 options-expression study) approved and built

James approved the read-only study `bt28` (spec `rb15-expression-study-spec.md`): same ORB15 trades expressed as A ATM 0DTE (control), B $2 0DTE debit vertical, C ATM next-expiry single leg, at $0.01/$0.03/$0.05 per leg per fill. It runs once after boot on Render and saves to Supabase `bt28` (progress `bt28p`). No live behavior changes; no new book. Control numbers in this study and the docs now use the live-config `bt13` row (`e15|t1.25|be0.5`); the earlier `t1|be1` figures were a different config. Results pending: see EXPERIMENT_LOG.md. Same day: observability logging (heartbeat, per-book scan state, dashboard status pill, quote-age sampler and `quote_check`) deployed after the Alpaca key regeneration incident; see RUNBOOK.md and Supabase `notes`.

## 2026-11-19 — bt29 (ORPB Stage 0 underlying signal study) approved, built and deployed

James approved the read-only Stage 0 study `bt29` (spec `orpb-signal-study-spec.md`; approval covers `bt29` only): SPY/QQQ 1-minute IEX stock bars, 30-minute opening range, first 10-minute candle closing beyond it, entry on the first 2-minute candle touching the 20 EMA, 20 configs per symbol, dev/holdout split at 2026-07-14. It runs once after boot (about 185 s) and saves to Supabase `bt29` (progress `bt29p`). Pushed after 16:00 ET and after `bt28` finished (21:23Z). No live behavior change, no options, no new book. Results are read out separately against the pre-registered criteria and labelled historical, underlying-only: not forward, not live, not profit. Run time and Render memory for this study are unmeasured.

## 2026-11-19 — bt28 and bt29 results (both failed); bt30 (Sweep variants study) approved and deployed

`bt28` (finished 21:23Z): control reproduced `bt13` exactly; B (debit vertical) negative at $0.03 in both periods on both symbols; C (next-expiry single leg) slightly positive with intervals that include zero and fails the pre-registered criteria. No advance, ORB15 unchanged. `bt29` (finished 21:50Z): ORPB primary config lost after costs in dev and holdout on both symbols, naive same-trigger baseline beat it in dev, criteria 1-5 all false; no Stage 1, no book. Numbers in EXPERIMENT_LOG. Both are historical, not forward, not profit.

Sweep: the live book is down -$208 over 41 run trades since 2026-11-11 (-$216 on 2026-11-19). James approved the read-only study `bt30` (spec `sweep-variants-study-spec.md`: fade, wick-size cap, with-trend filters on real 0DTE option prices, judged at $0.03 per fill, weak holdout) and chose to leave the live Sweep pilot as is for now. `bt30` runs once after boot (about 195 s; it waits for any running `bt28`/`bt29`) and saves to kv `bt30` (progress `bt30p`). No live behavior change.

## 2026-11-18 — ORB15 review and fixes

James asked why ORB has so few profitable trades. 7 live ORB trades (Nov 11-18) net -$279; the 5 on the 15-minute version net -$51, statistically consistent with `bt13`'s thin edge (~$9/trade vs ~$150 per-trade SD; ~1,000 trades needed to separate it from zero). Findings and a pre-registered exit study (`bt27`, not approved, not built) are in `orb-exit-study-spec.md`. Two approved code changes deployed (commit `7d78f9b`, live 18:34Z): first-breakout signal detection (`orb15.js`) with logged skips for stale signals and incomplete opening ranges, and bid/spread/delta/iv fields on ORB trade rows. ORB entry and exit rules are unchanged. Supabase `notes` updated.

## 2026-11-18 — first live-trading performance review, then FP retirement + per-symbol analysis

James asked for a full review of live performance across all books after 8 trading days of live-paper data (Nov 9-18), specifically flagging that FP "does well in up markets, does horrible in down swings." Full detail (per-book P&L table, market backdrop, FP's continuation-vs-reversion mechanism, the CDR-zero-trades finding) is in EXPERIMENT_LOG.md's "Live-trading performance review (2026-11-18)" section. James approved all five resulting proposals:

1. **Build an FP trend filter, offline/backtest first.** Done: `study_fp_trend.js` (kv `bt26`), deployed commit `1c758d1`. Tests base (reproduces live) vs. trend3/trend5 (skip a reversion trade that opposes a confirmed 3-/5-day trend) vs. contOnly3/contOnly5 (skip all reversion on a confirmed-trend day), on real 1-minute Alpaca option bars. **Result: none of the four filtered variants clear breakeven** — the reversion leg's edge is negative across the full 2024-2026 history on both symbols, in both the dev and lock periods, trend-filtered or not. **Decision: FP retired, not fixed** (see below).
2. **Investigate why some FP trades tagged `"reason":"target"` still show negative dollar P&L.** Resolved, not a bug: the exit reason is determined purely from the underlying crossing a line; realized option P&L is computed independently as `(exitBid - entryAsk) * 100`. FP's targets are deliberately tiny (0.10-0.15% of the underlying), smaller than real bid/ask spread + theta decay on a 0DTE contract.
3. **Run a real backtest on CDR.** Done: `study_cdr.js` (kv `bt16`), deployed commit `1c758d1`. James's decision: **leave CDR running live-paper exactly as-is, no action** — it isn't hurting anything (zero trades, zero cost) and the backtest result was thin/inconsistent enough that a change either way wasn't clearly justified.
4. **Sweep/CSK:** no change, acknowledged healthy.
5. **X9/ORB15:** no change, acknowledged — too little live data yet to act on (ORB since reviewed separately, see above).

**New analysis, same day:** James asked whether the active strategies do better on SPY or QQQ, as groundwork for eventually isolating capital/strategies by symbol once live with real money (not implemented — just evidence-gathering). Pulled the real per-symbol splits out of each book's own large-sample backtest, not the 8-day live sample:

| Book | QQQ (lock/holdout) | SPY (lock/holdout) | Verdict |
|---|---|---|---|
| CSK (bt6/bt7/bt9) | +$4.62/spread/day | +$3.60/spread/day | QQQ ahead in both periods |
| X9 (bt22, each symbol's own best exit) | $9.14/trade, PF 1.33 (flat 70% TP) | $5.53/trade, PF 1.25 (trail) | QQQ clearly ahead — why the exit split exists |
| ORB15 (bt13, live config 1.25R/+0.5R; corrected 2026-11-19, earlier $6.00/$5.49 was the 1R/+1R row) | $9.07/trade, PF 1.11 | $8.99/trade, PF 1.17 | QQQ ahead in train ($9.49 vs $7.50), about equal in lock |
| Sweep (bt8, live "run" exit) | avg -$2.67/trade, PF 0.81 | avg -$3.44/trade, PF 0.63 | **Both negative in holdout** — QQQ "less negative," not a real edge |

**Takeaway:** QQQ is at least as good as SPY everywhere, and clearly ahead on CSK and X9 — there is no case in this project's backtests for isolating toward SPY. But Sweep's own live exit ("run") shows a *negative* average and PF <1 for both symbols in the lock/holdout period — that's a flag about Sweep's current exit robustness, not a symbol story, and deserves its own look before any capital-isolation decision leans on it. No action taken on this yet — James said to start thinking about it for when real money goes live, not to implement isolation now.

## Status by book (as of Nov 18)

| Book | Status | Since |
|---|---|---|
| Sweep (main) | **Active**, real orders at Alpaca paper (pilot). Backtest (`bt8`) shows negative avg/PF<1 for both SPY and QQQ in the lock/holdout period — flagged for review, not yet acted on | Nov 9 built, real-order pilot Nov 12 |
| EMA (main) | **Paused** — no profitable variant found in 3 studies | Retired Nov 13 |
| VWAP (main) | **Paused** — never had an edge | Retired Nov 13 |
| 15-min-break (main) | **Paused** — superseded by the ORB book | Retired Nov 13 |
| ORB (opening-range breakout) | **Active**, 15-min version, rules unchanged. Detection fix and spread logging deployed Nov 18; exit study `bt27` approved 2026-11-20, built and queued (read-only), result pending | Nov 10, switched to 15-min Nov 12 |
| CSK (call credit spreads) | **Active** — only strategy with a full real-price validation; QQQ ahead of SPY both periods | Nov 11 |
| X9 (EMA9×VWAP) | **Active**, per-symbol exit split (QQQ flat TP, SPY trail); QQQ clearly ahead of SPY even with each symbol's own best exit | Nov 12, split Nov 13 |
| FP (fair pricing theory) | **RETIRED (`FP_ON=0`), Nov 18.** `bt26`'s trend filter does not fix the reversion leg in any of 4 tested variants. Any open FP position at the time of the change is still managed to its normal exit; only new entries are blocked | Nov 12 live; retired Nov 18 |
| CDR (opening-range iron condor) | **Active live, zero trades fired in 8+ days.** First backtest (`bt16`) run; James's decision: leave running live-paper as-is, no action | Nov 12 live; `bt16` run Nov 18 |
| Wheel2 CSP (monthly QQQ put spread) | **Dry-run only**, not placing real orders | Nov 13 |
| Wheel (first wheel research account) | Read-only boot check only, no logic | Nov 13 |
| IB / "Levels" (Failed Auction / Trend Continuation) | **Stage 0 FAILED (Nov 14).** No edge found; dormant, not advancing. Never traded anything. | Built, run, and failed Nov 14 |
| BRT ("Break & Retest of Critical Levels") | **Proposal only, not approved, nothing built.** Related but distinct "levels family" hypothesis. | Spec received Nov 14 |

IWM is excluded from every book as of Nov 13. A cross-book correlation-aware exposure cap (SPY+QQQ, $500) gates every book's entries as of Nov 14. An AI trade-management overlay (shadow-log only, CDR only) was armed Nov 14 — still unconfirmed, since CDR continues to fire zero live entries, so there's nothing yet for it to shadow.

## The "levels family" — IB (failed) and BRT (proposed)

Both IB and BRT arrived the same way: James shared a YouTube video, a *different* Claude session (one with working video access but no repo/Render access) watched it and wrote a critically-reviewable spec doc, and the build session (which has repo/Render access but can't reach YouTube — hard sandbox network block, not a bug) read that spec, questioned it, and either built from it (IB) or asked James for approval (BRT). This division of labor is intentional — see RUNBOOK.md.

**IB result:** `bt24` ran clean (44 seconds, 0 errors) and **failed** — negative dev expectancy across all 4 setup/symbol buckets, and holdout's apparently strong numbers (PF up to 8.3) turned out to be a handful of oversized winners in an undersized sample, confirmed by the drop-best-5 check going negative everywhere. No Stage 1 built. Dormant.

**BRT status:** full spec exists (`claude/brt-strategy-spec.md` in the Project), explicitly proposal-only. Its own section 11 lists five decisions for James, partly answered (see DECISIONS.md 2026-11-14) — nothing built pending answers. Still unstarted as of Nov 18.

## Current blockers

1. **Sweep's live "run" exit shows negative average/PF<1 for both symbols in its own lock/holdout backtest period (`bt8`)** — surfaced during the Nov 18 per-symbol analysis, not yet raised as its own review item.
2. **Robinhood's handling of expiring call spreads in the last 30 minutes is unconfirmed** with Robinhood support — this matters for whether CSK can actually go live at Robinhood.
3. **Live-broker choice undecided**: Robinhood "BOT Trading" vs. the connected (unfunded) Alpaca live brokerage account.
4. **No broker-resident stop exists for options at Alpaca (confirmed Nov 14)** — sweep's real-order pilot (and any future options real-order pilot) has no floor at the broker if the Render app itself goes down. Needs a decision before any live pilot: external watchdog, tighter outage alerting, or accept as documented risk.
5. **AI overlay is armed but still unconfirmed** — CDR continues to fire zero live trades, so there's nothing yet for the overlay to have shadowed.
6. **BRT's open decisions are unanswered** (DECISIONS.md 2026-11-14) — nothing can be built until James responds.
7. **ORB exit study `bt27` approved 2026-11-20 and running read-only on the server (result in kv `bt27`)**; the $500 correlation cap blocked 2 of 7 ORB signals and has no ORB priority rule.

## Next steps

- Finish the move to Claude Code: verify connectors, repoint `RUNBOOK.md` and the morning-review prompt at the repo, commit `CLAUDE.md` and `docs/` outside market hours.
- **Read the ORB `bt27` result when it lands** (spec in `orb-exit-study-spec.md`, section 7 fixes the interpretations); meanwhile ORB keeps running unchanged. After about 15 live ORB trades, compare the new `spreadIn`/`spreadOut` data with the backtest's $0.01/fill assumption.
- **Look into Sweep's lock-period backtest showing negative avg/PF<1 on both symbols.**
- **Get James's answers on BRT's open decisions** and, if approved, build `study_brt.js` (kv `bt25`) using the `study_ib.js` harness pattern.
- Confirm Robinhood's early-close behavior for spreads.
- Decide whether/when to flip `WHEEL2_CSP_ON=1` (watch the dry-run log a while longer first; consider re-running bt21 cleanly).
- Add a monthly account-growth tracker once live.
- Build the day-type (chop/trend) regime-matching backtest (not started).
- Decide how to live with the no-broker-stop gap before any live pilot (blocker 4 above).
- When James is ready to go live with real money: revisit the per-symbol capital-isolation question with fresh eyes (and, ideally, more live-paper days by then) before acting on it — nothing has been implemented, this is evidence-gathering only.

## 2026-11-20 — X9 exit study `bt31` (read-only) queued
James's observation that X9 runs up about +$100 and fades (QQQ has no trail; flat +70% target never reached by a +40% run) led to `bt31` (spec `x9-exit-study-spec.md`, 12 variants per symbol vs the current live rules). Runs once on the server after boot (about 215 s; waits for any running `bt27`), result in kv `bt31` (progress `bt31p`). No live X9 behavior change. `bt27` (ORB exit study) finished the same day; its analysis is saved and not yet reviewed with James.

## 2026-11-20 — `bt27` ORB15 exit study result
Control reproduced `bt13` exactly. Live rules (L0) in the backtest: +$8.99 per trade at $0.01 per leg and +$4.99 at $0.03 (n=1330, Mar 2024 to 2026-11-11). None of V1-V9 beat them (all fail the pre-registered criteria); the -50% premium stop is neutral on average, not the cause of the live losses. Live ORB (9 trades, -$485) is statistically consistent with the thin backtest edge. ORB rules unchanged. Edge remains thin and fragile (config chosen from a grid; confirmation period not a clean holdout).

## 2026-11-20 — `bt31` X9 exit study result
Control reproduced `bt22` within tolerance. No variant passed for QQQ or SPY; X9 exit rules unchanged. QQQ's flat +70% target beat every trail/hybrid/lock tested (by $2.61-$7.61 per trade, intervals spanning zero); a trail banks more of the +40% runs (94-99% finish positive vs 79%) but lowers the average. SPY X9 (trail reference) is about -$0.83 per trade at $0.01 and -$4.83 at $0.03 over the last year and no exit variant makes it profitable at $0.03; whether to keep SPY X9 running is a question for James, not changed.

## 2026-11-20 — `bt32` X9 level-exit study built, awaiting push
Approved by James; code `study_x9_level.js`, launcher in `server.js` (one-shot after boot, delay 225 s), test passes 11/11 with three mutation checks caught. Local only: push deferred because a CSK position was open at 11:54 ET. Pending local commits: `0d25ddf` (docs) and the bt32 commit. Push after 16:00 ET or with James's OK; then confirm Render `live` and read kv `bt32`.

## 2026-11-20 — `bt32` X9 level-exit study result
Pushed (7566dde, Render live 17:24 UTC), ran once, 0 errors. Control E0L reproduced bt31 exactly. No variant passed for QQQ or SPY; live X9 rules unchanged. Only lead: QQQ E4 (exit on a close through VWAP instead of EMA9) +$2.4 per trade over E0 in both train and lock, below the +$3 bar, interval spans zero; hypothesis only. SPY X9 has no edge under any exit tested (all negative at $0.03). Open question for James: keep SPY X9 running?

## 2026-11-20 — CSK live review and CSK2 added
Live CSK Nov 12-19: 10 closed trades, +$278, 9 winners (winners avg about +$46, one -$134 QQQ 3x stop), $46.33 average over 6 closed days; no fees deducted; far above the backtest per-spread figure (unexplained, small sample). Added CSK2, a second entry window at 12:30 ET with the same rules (see DECISIONS). Test `test/csk2.test.js` (5). bt32 result docs ride in the same push.

## 2026-11-20 — `bt33` CSK multi-day study built
Code `study_csk_multiday.js`, launcher in `server.js` (one-shot, 245 s after boot, runs 30-60 minutes), test 10/10 with six mutation checks caught, runner dry-run clean on a fake feed. Local until pushed. Result lands in kv `bt33`.
