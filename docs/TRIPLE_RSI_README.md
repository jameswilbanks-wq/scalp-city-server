# Triple RSI (mean reversion) — backtest, robustness and paper executor

Status as of 2026-11-18: **built and tested offline. DRY_RUN only. No order has ever been sent.** Paper trading only; live trading does not exist in this code.
This module is independent of the Node `server.js` book system and shares no state with it.

## Files

| File | Purpose |
|---|---|
| `strategies/triple_rsi.py` | Pure strategy logic: Wilder RSI/ATR, entry and exit rules, position sizing, daily-loss check. No network, files or clock. |
| `backtests/triple_rsi_backtest.py` | Data loading and validation, Model A and Model B simulators, metrics, charts, variants, walk-forward, final-test gate. |
| `execution/triple_rsi_paper.py` | DRY_RUN / PAPER executor, Alpaca **paper** REST adapter, persistent state, idempotent orders, reconciliation. |
| `config/triple_rsi.yaml` | All parameters. Default `mode: DRY_RUN`. No secrets. |
| `tests/test_triple_rsi.py` | 60 tests (unit, engine, no-lookahead, executor with mock brokers). |
| `requirements-triple-rsi.txt` | pandas, numpy, matplotlib, pyyaml, requests, yfinance, tzdata. |
| `reports/triple_rsi/` | Generated: `A_*/`, `B_*/` (trades.csv, summary.json, equity.png, drawdown.png), `optimization.json`, `promotion.json`, `variants_train_validation.csv`, `state/` (executor records). |

## The rules (immutable baseline = `BASELINE`)

1. Wilder RSI(5) on split+dividend **adjusted** daily closes.
2. RSI[t] < 30.
3. RSI[t] < RSI[t-1] < RSI[t-2] < RSI[t-3] (three strictly lower sessions).
4. RSI[t-3] < 60.
5. Close[t] > SMA(200)[t].
6. Enter long when all hold. 7. Exit when RSI[t-1] <= 50 and RSI[t] > 50. 8. No overlapping positions in a symbol.

ATR stop, time stop, VIX filter and the sizing/risk limits are **additional safeguards**, off in the baseline and tested separately.

## Two execution models (different numbers, on purpose)

* **Model A, original close-to-close:** fills at the signal day's own close, no costs. This is the published assumption and **cannot be reproduced live** (the official close and final RSI are not known before the close). Reported only for comparison.
* **Model B, executable next-open:** decide on the completed daily bar, fill at the **next session's open**, 5 bps slippage per side. The paper executor implements this model.

No decision ever uses a bar after the one it is made on: `TestNoLookahead` perturbs/truncates future bars and requires identical past indicators, signals and equity.

## Results (HISTORICAL simulation on adjusted prices; not profits)

Data: SPY and QQQ daily, yfinance (keyless), adjusted. SPY from 1999-01-04, QQQ from 1999-03-10, both to 2026-11-18. Reported window 1999-12-21 to 2026-11-18 (after the 200-bar warmup). Start equity $2,000 of strategy capital, 20% per symbol, 40% combined. Gaps over 7 calendar days: none. Rows dropped: 0.

| | A: close-to-close | B: next-open + costs | SPY buy & hold | QQQ buy & hold |
|---|---|---|---|---|
| Trades | 150 | 150 | – | – |
| Win rate (95% CI) | 84.7% (78–90) | 77.3% (70–83) | – | – |
| Expectancy per trade | +1.18% | +0.95% | – | – |
| Profit factor | 4.28 | 3.12 | – | – |
| Net return on $2,000 | +42.0% | +32.7% | +712% | +776% |
| CAGR | 1.31% | 1.06% | 8.1% | 8.4% |
| Max drawdown (of strategy capital) | -4.8% | -4.8% | -55.2% | -83.0% |
| Sharpe / Sortino (daily, rf 0) | 0.63 / 0.95 | 0.52 / 0.77 | 0.50 / 0.71 | 0.44 / 0.62 |
| Days with a position | 8.2% | 8.2% | 100% | 100% |
| Avg capital deployed | 2.2% | 2.2% | 100% | 100% |

Reading it plainly: the per-trade edge is positive, but the strategy is in the market ~8% of days with a small slice of capital, so its dollar return is a small fraction of buy-and-hold. Its low drawdown is mostly low exposure, not proof of safety. Waiting for the next open costs about 0.23 percentage points per trade versus the published model.
I did not compare Model A against QuantifiedStrategies' published figures (not fetched); do not assume it reproduces them.

Worst Model B trades: QQQ 2008-01 -9.8% over 20 sessions (-$43.6, 2.2% of equity), SPY 2011-07 -7.4%, SPY 2025-02 -5.3%. **The baseline has no stop**, so a single trade's loss is not capped; the worst in this sample is not the worst possible. Longest stretch below a prior equity high: 636 sessions.
Recent behaviour is weaker: 2019 to date (49 trades) win rate 65%, expectancy +0.69%; 2026 so far 9 trades, 44% wins. That could be noise or decay; with these counts it cannot be told apart.

By ticker (B): SPY 72 trades, 79% wins (68–87), +1.0%/trade; QQQ 78 trades, 76% wins (65–84), +0.9%/trade. Annual returns and per-year trade counts are in `B_executable_next_open/summary.json`.

## Optimization and robustness

18 variants (baseline + 17), **one parameter at a time** (not a grid): RSI length 3/7/9, oversold 20/25/35, exit 45/55/60, SMA 100/150, ATR stop 2x, max hold 5/10/15, VIX < 25/35. Splits (fixed in config): train 2000-03 to 2012-12, validation 2013-01 to 2018-12, **final test 2019-01 to end, never used to choose a variant** and evaluated once.

* Passing the train+validation gate: rsi_len=7, exit=45, 55, 60, sma=150, max_hold=15 (identical to baseline). One chosen: `sma=150` (best of the minimum of train and validation Sharpe).
* Walk-forward (expanding train, 2-year blocks 2006-2017, inside train+validation only): the variant picked from prior data beat the baseline in 3 of 6 blocks; pooled out-of-sample expectancy 0.92% (35 trades) versus 0.99% (71 trades) for the baseline. Selecting variants added nothing measurable.
* Final test, 2019+: baseline 49 trades, Sharpe 0.42, expectancy +0.69%, max DD -3.0%; `sma=150` 41 trades, Sharpe 0.42, expectancy +0.73%, max DD -2.4%. A statistical tie.
* **Promotion: none.** My first gate only required "not worse than baseline", and `sma=150` passed it. That was a statistical tie among 17 comparisons, so I added materiality checks (Sharpe and expectancy must each improve by at least 0.10) **after seeing that result**; `sma=150` fails them. The test period was therefore already looked at for this candidate. Even a passing gate only makes a variant eligible: `promotion.json` also needs `human_approved: true`, which only a person sets.
* ATR stop 2x was worse on validation (expectancy 0.47% vs 1.02%). The VIX filters did not help. Max-hold variants did not help.

Not done: volatility regime filters other than VIX; the expanded universe (IWM, DIA, stocks) was not run (`--symbols` supports it; stocks carry survivorship bias).

## Risk limits (as implemented)

20% of strategy equity per symbol, 40% combined, no leverage/margin/shorting/pyramiding, whole-account cash never exceeded, entries blocked when the day's loss reaches 2% of start-of-day strategy equity, planned-loss budget 1% per trade (**only enforceable when an ATR stop is configured**; the baseline has none). Stops are not guaranteed: a gap through a stop fills at the open, which the engine models (`atr_stop_gap`). Position sizes are never increased after losses.
Sizing uses the strategy's own $2,000 notional, not the Alpaca account equity (about $98k at last check).

## Safety design (each item is tested)

* Only `DRY_RUN` and `PAPER` exist. `LIVE`, `live`, empty or unknown modes raise. The trading host is the constant `https://paper-api.alpaca.markets`; any other host raises. The live host string appears nowhere in the executor.
* `DRY_RUN` ignores any broker object entirely (no reads, no writes). `PAPER` also needs `--confirm-paper`.
* Non-baseline parameters are refused unless `promotion.json` has `gate_passed` and `human_approved` for that exact label. `atr_stop_mult` and `vix_max` are backtest-only in the executor (no broker-resident stop or VIX feed exists) and are refused.
* Deterministic `client_order_id` = `trsi-<SYM>-<signal date>-<side>`; the order is persisted before sending; after a crash or error the broker is queried by that id and the order is adopted, never re-sent. A DRY_RUN record never blocks the real PAPER order for the same signal.
* Refuses to act while the market is open or if the newest bar is older than `stale_data_max_days`. Cancels still-open strategy orders from older signal days. Partial fills are applied once (delta); rejections create no position. A shortfall between recorded and broker positions halts new entries.
* Sells only the quantity this strategy recorded. **The paper account is shared**: at last check it held 100 SPY that this strategy did not buy. Use a separate paper account for clean attribution.
* Keys come from environment variables only (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`); never logged or stored.

## Commands

```powershell
python -m venv .venv-trsi
.venv-trsi\Scripts\python -m pip install -r requirements-triple-rsi.txt
.venv-trsi\Scripts\python -m unittest discover -s tests -p "test_triple_rsi.py" -v
.venv-trsi\Scripts\python -m backtests.triple_rsi_backtest baseline          # Model A and B, writes reports\triple_rsi\
.venv-trsi\Scripts\python -m backtests.triple_rsi_backtest baseline --symbols SPY QQQ IWM DIA
.venv-trsi\Scripts\python -m backtests.triple_rsi_backtest optimize          # variants, walk-forward, one-time final test
.venv-trsi\Scripts\python -m execution.triple_rsi_paper --once               # DRY_RUN (default): signals only
# PAPER (only after review; keys typed in YOUR shell, never in a file or chat):
$env:APCA_API_KEY_ID = "<paper key id>"; $env:APCA_API_SECRET_KEY = "<paper secret>"
.venv-trsi\Scripts\python -m execution.triple_rsi_paper --once --mode PAPER --confirm-paper
```
Schedule `--once` after the close (for example 16:30 ET) so orders queue for the next open.

## Not built / not verified (be aware)

* **No order has been sent. The Alpaca REST adapter is verified only against mocks**, never against the real paper API. Alpaca historical data through Python is likewise untested (no keys were available to the tooling); backtests used yfinance. The Alpaca MCP server did return SPY daily bars with `adjustment=all`, `feed=sip`, confirming permissions for that data.
* The monitoring/learning loop is only partly built: every signal, order, execution and event is recorded (`reports/triple_rsi/state/*.jsonl`), but **weekly/monthly reports, realized-versus-backtest tracking, and missed-signal/slippage analysis are not yet implemented.** Improvements must be proposed as new versioned experiments and re-validated out of sample; nothing promotes itself.
* Corporate actions are handled only through adjusted prices. Delistings and survivorship bias do not matter for SPY/QQQ but would for single stocks.
* Costs: Alpaca equities are commission-free; SEC/TAF sell fees (cents) are ignored; slippage is a flat 5 bps per side assumption, not measured.
* The 2026-11-18 DRY_RUN shows a live SPY entry signal (RSI 50.2 → 33.5 → 27.5 → 25.8; close only $0.18 above its SMA). It is a record, not an order.
* Per this repo's rules, adding this to the live system needs James's explicit approval; nothing here touches `server.js`, Render or Supabase, and nothing is committed or pushed.
