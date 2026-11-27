# Signal confluence study (`bt38`), frozen spec

Status: **RESEARCH ONLY. Frozen before any data was fetched or any result was seen.** Local on this PC; no Render, Supabase write, broker or order path.
Date: 2026-11-27. Asked by James: "i know that not one signal is reliable but if you combine 5 and they all say the same thing, buy or sell, it strenthens the chances of being correct. if you need to test/research further please do."

## 1. Question
Does the forward move of SPY and QQQ get better, in the signal's direction, as more of the five signal-board signals (`signals.js`: VWAP, 30-minute ORB, RSI(14) on 5-minute bars, EMA 9/21, first-half-hour momentum) agree? And is the "3 or more agree" light (the live board rule) better than chance after costs?

The study runs the **production code** (`computeSignals` from `signals.js`) on historical minutes, so what is tested is what is deployed. No parameter is tuned; there is nothing to optimise, so dev vs holdout is a check that a result is not one period's luck.

## 2. Data
Alpaca SIP 1-minute bars with volume, `adjustment=all`, SPY and QQQ, 2016-01-04 to 2026-11-25, cached locally in `harness_local/sig/cache` (git-excluded). Exchange calendar from `harness_local/ger/calendar.json` (non-sessions dropped, early-close days end at their real close). Regular session only (ET 09:30 to 15:59). Split by decision day: **dev 2016-01-04 to 2023-12-31, holdout 2024-01-01 to 2026-11-25**. The dev stage applies a hard cutoff before any computation; the holdout is read once, by `final`, on a clean committed tree.
SPY is the primary instrument (all five signals exist; it is the most traded manual ticker). QQQ is the replication. The 8 stocks are **not** studied: the first-half-hour signal does not exist for them (max 4 of 5) and a different data pull is needed; they are a possible follow-up.

## 3. Decision points and outcomes
- A decision is taken at the close of each 1-minute bar whose ET start minute is 10:00, 10:05, ..., 15:30 (every 5 minutes; both ORB and first-half-hour are defined from 10:00). On early-close days the last decision is 30 minutes before the real close. The first 5 sessions of data are warm-up and are skipped.
- The signal vector is computed by `computeSignals` on the bars of the **previous 3 sessions plus today up to that bar** (what the live server holds), `index: true`, `now` set just after the bar so nothing is stale.
- **Entry** = open of the next 1-minute bar (no look-ahead). **Exit** = close of the bar H minutes later (H = 15, 30, 60), or the session's last bar if that comes first; horizon `close` = the session's last bar. Return in basis points of the entry price. Horizons are the same for every state.
- **Direction-adjusted excess return** for a state with direction d (+1 buy lean, -1 sell lean) = d x (r - mean of r over ALL decision points of the same symbol, period and horizon). This removes the market's own drift (SPY rises on most days, so raw buy-state returns would look good for free). The **net** figure subtracts costs (section 5).
- States: **ladder** `buy k` = exactly k of the five signals at +1 (k = 0..5), `sell k` = exactly k at -1; **light** = `computeSignals().state` (buy/sell = 3 or more agree); **5 of 5**; each **single signal** alone (value +1 or -1).

## 4. Statistics
- Day-clustered bootstrap (resample trading days with replacement, 2,000 draws, fixed seed) for the 95% interval of every mean excess; decision points within a day overlap, so days are the unit.
- **Control C1, shifted-signal null:** the signal vectors are circularly shifted by a random whole number of sessions (same minute-of-day), outcomes unchanged, 1,000 draws, fixed seed. This keeps each signal's own persistence and time-of-day pattern and breaks only the link to what happens next. The real pooled excess of the "light" state is compared with the 97.5th percentile of the shifted distribution.
- **Independence check:** pairwise correlation of the five signals (+1/-1 only), their mean, and the effective number of independent signals N/(1+(N-1) x mean correlation). This addresses the idea that agreement adds confidence: agreement among highly correlated signals adds little.
- **Gradient:** Spearman correlation between k (1..5) and the mean excess, buy and sell separately.
- Everything is reported for dev, holdout and full, never blended; every horizon and every state is recorded, including failures.

## 5. Costs (stated assumptions, not measurements of history)
- Underlying round trip: **0.3 bp** of price (SPY and QQQ about 1 cent each way at these prices).
- Option-equivalent round trip (what a manual 0DTE trade actually pays): **1.0 bp** of the underlying, stress **2.0 bp**. Basis: live quote samples show SPY 0DTE ATM spreads of 1 to 7 cents on premiums near $1 (Render `quote_sample` logs, 2026-11-27); a 3-cent round trip on a delta-0.5 option is about 6 cents of underlying, about 0.8 bp of 725. Theta, gamma and IV changes are NOT modelled: **this study measures the underlying move, not option P&L.** A positive result here is necessary, not sufficient; option history would be needed to size real P&L.

## 6. Verdict (all must hold; SPY, horizon 30 minutes, state = the "3 or more agree" light, buy and sell pooled, direction-adjusted)
1. At least 300 light decision points in dev AND in holdout, else **Inconclusive**.
2. Mean excess > 0 in dev AND in holdout.
3. Dev bootstrap 95% interval lower bound > 0.
4. Mean excess minus the 1.0 bp option-equivalent cost > 0 in dev AND in holdout.
5. Real dev excess above the 97.5th percentile of the C1 shifted null.
6. Gradient (the user's hypothesis): mean excess of the light states (k >= 3) is greater than the mean excess of the weak states (k = 1 or 2, same direction pooled) in dev AND in holdout.
All six hold = **Supported (underlying move only)**; otherwise **Not supported** (or **Inconclusive** if criterion 1 fails). Each failed criterion is named. QQQ, other horizons, the 5-of-5 state and single signals are **descriptive**; with 4 horizons x 2 symbols x several states, a lone good cell elsewhere is not a finding (multiple comparisons).
A "Supported" verdict does **not** make it a strategy: it would go to James as a proposal (option-level test, sizing, risk) and nothing trades on it without his explicit yes.

## 7. Deliverables
`study_sig.js` (pure), `run_sig_local.js` (fetch / dev / final), `test/sig_study.test.js`, results in `docs/signal-confluence-results.md`, `bt38` compact result in `scalp.kv`, entries in EXPERIMENT_LOG and STRATEGY_REGISTRY (as a research item, not a strategy). Local branch `signal-study`; pushed only if James says so.
