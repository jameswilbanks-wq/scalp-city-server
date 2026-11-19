# PROJECT_STATE.md — Scalp City

Last updated: 2026-11-18, after the ORB15 detection fix and the decision to move code work to Claude Code.

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

## 2026-11-18 (night) — eval-harness Part 2, step 1: richer trade-log fields on the MAIN (Sweep) book, deployed alone (cherry-picked from branch `eval-harness`)

Main-book trade rows (`closePaper`) now also carry, as optional fields: `quotedBid`, `quotedAsk` (kept separate from the fill price, because with `SWEEP_REAL_ORDERS` on the fill overwrites `entryAsk`/`entryBid`), `spreadIn`, `slippageVsMid`, `exitAsk`, `spreadOut` (same names ORB rows already use), `holdMinutes`, `mfe`, `mae` (option dollars, full position, from monitoring-tick bids, so approximate), `strategyVersion` (`sweep-run-1`; other triggers `main-<trig>-1`; bump on any material change) and `signalId` (`sym|trig|signal time`; signal rows do not carry it yet, so reconciliation is still by time). Additive only and fail open: no entry, exit, sizing or risk change; a helper returns `{}` on any error. Tested against the original `closePaper` on 48 cases (identical rows once the new fields are stripped) in `test/trade_row_extras.test.js`. Deployed with no position open in any book, market closed. **Not yet done:** ORB, X9, FP, CSK, CDR and the shadow book (one at a time); acceptance criteria 4 and 5 stay open until live rows are checked for nulls and a before/after trade-count comparison is made. The rest of the harness (branch `eval-harness`) is not merged.

## 2026-11-18 — workflow change: moving code work to Claude Code

James decided (afternoon of Nov 18) to move code, deploy and records work from chat into Claude Code, with this `docs/` folder and a repo-root `CLAUDE.md` as the source of truth, and to keep chat for research, video-spec handoffs and quick questions. Setup steps were given to him; the first Claude Code session should verify it can read Supabase `notes`, list Render deploys, and run `node --check server.js` plus the tests. The Alpaca Live and Robinhood connectors are deliberately not to be connected in Claude Code. `RUNBOOK.md` and the morning-review prompt still describe the chat-based setup and need repointing.

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
| ORB15 (bt13) | $6.00/trade, PF 1.07 | $5.49/trade, PF 1.08 | QQQ barely ahead, gap converges in holdout |
| Sweep (bt8, live "run" exit) | avg -$2.67/trade, PF 0.81 | avg -$3.44/trade, PF 0.63 | **Both negative in holdout** — QQQ "less negative," not a real edge |

**Takeaway:** QQQ is at least as good as SPY everywhere, and clearly ahead on CSK and X9 — there is no case in this project's backtests for isolating toward SPY. But Sweep's own live exit ("run") shows a *negative* average and PF <1 for both symbols in the lock/holdout period — that's a flag about Sweep's current exit robustness, not a symbol story, and deserves its own look before any capital-isolation decision leans on it. No action taken on this yet — James said to start thinking about it for when real money goes live, not to implement isolation now.

## Status by book (as of Nov 18)

| Book | Status | Since |
|---|---|---|
| Sweep (main) | **Active**, real orders at Alpaca paper (pilot). Backtest (`bt8`) shows negative avg/PF<1 for both SPY and QQQ in the lock/holdout period — flagged for review, not yet acted on | Nov 9 built, real-order pilot Nov 12 |
| EMA (main) | **Paused** — no profitable variant found in 3 studies | Retired Nov 13 |
| VWAP (main) | **Paused** — never had an edge | Retired Nov 13 |
| 15-min-break (main) | **Paused** — superseded by the ORB book | Retired Nov 13 |
| ORB (opening-range breakout) | **Active**, 15-min version, rules unchanged. Detection fix and spread logging deployed Nov 18; exit study `bt27` proposed, awaiting James | Nov 10, switched to 15-min Nov 12 |
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
7. **ORB exit study `bt27` awaiting James's decision**; the $500 correlation cap blocked 2 of 7 ORB signals and has no ORB priority rule.

## Next steps

- Finish the move to Claude Code: verify connectors, repoint `RUNBOOK.md` and the morning-review prompt at the repo, commit `CLAUDE.md` and `docs/` outside market hours.
- **Decide on ORB `bt27`** (spec in `orb-exit-study-spec.md`); meanwhile ORB keeps running unchanged. After about 15 live ORB trades, compare the new `spreadIn`/`spreadOut` data with the backtest's $0.01/fill assumption.
- **Look into Sweep's lock-period backtest showing negative avg/PF<1 on both symbols.**
- **Get James's answers on BRT's open decisions** and, if approved, build `study_brt.js` (kv `bt25`) using the `study_ib.js` harness pattern.
- Confirm Robinhood's early-close behavior for spreads.
- Decide whether/when to flip `WHEEL2_CSP_ON=1` (watch the dry-run log a while longer first; consider re-running bt21 cleanly).
- Add a monthly account-growth tracker once live.
- Build the day-type (chop/trend) regime-matching backtest (not started).
- Decide how to live with the no-broker-stop gap before any live pilot (blocker 4 above).
- When James is ready to go live with real money: revisit the per-symbol capital-isolation question with fresh eyes (and, ideally, more live-paper days by then) before acting on it — nothing has been implemented, this is evidence-gathering only.
