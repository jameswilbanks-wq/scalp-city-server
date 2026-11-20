"""Tests for the Triple RSI strategy, backtest engine and paper executor. Synthetic data and fake brokers only: no network, no keys.

Run:  python -m unittest discover -s tests -p "test_triple_rsi.py" -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backtests.triple_rsi_backtest import SimConfig, compute_metrics, prepare, simulate, wilson_ci  # noqa: E402
from execution import triple_rsi_paper as ex  # noqa: E402
from strategies.triple_rsi import (  # noqa: E402
    BASELINE, SizingInputs, compute_indicators, daily_loss_breached, entry_signal, exit_signal, size_position, wilder_atr, wilder_rsi,
)


# ------------------------------------------------------------------------------------------ helpers

def ind_frame(rsi, close=None, sma=None):
    n = len(rsi)
    return pd.DataFrame({"rsi": rsi, "close": close if close is not None else [100.0] * n, "sma": sma if sma is not None else [90.0] * n},
                        index=pd.bdate_range("2024-01-01", periods=n))


def ref_rsi(c, n):
    g = [max(c[i] - c[i - 1], 0) for i in range(1, len(c))]
    l = [max(c[i - 1] - c[i], 0) for i in range(1, len(c))]
    ag, al = sum(g[:n]) / n, sum(l[:n]) / n
    out = [100 - 100 / (1 + ag / al)]
    for i in range(n, len(g)):
        ag, al = (ag * (n - 1) + g[i]) / n, (al * (n - 1) + l[i]) / n
        out.append(100 - 100 / (1 + ag / al))
    return out


def hand_frame(opens, closes, entry=(), exit_=(), atr=1.0, lows=None, highs=None, start="2024-01-02"):
    n = len(closes)
    idx = pd.bdate_range(start, periods=n)
    f = pd.DataFrame({"open": opens, "close": closes}, index=idx)
    f["high"] = highs if highs is not None else np.maximum(f["open"], f["close"]) + 0.1
    f["low"] = lows if lows is not None else np.minimum(f["open"], f["close"]) - 0.1
    f["atr"] = atr
    f["entry"] = [i in entry for i in range(n)]
    f["exit"] = [i in exit_ for i in range(n)]
    return f


def make_bars(tail):
    """Uptrend, a RSI-neutral sawtooth, then the given daily moves. Designed so the LAST bar can satisfy the full entry rule."""
    r = [0.002] * 220 + [0.003, -0.003] * 20 + list(tail)
    c = 100 * np.cumprod(1 + np.array(r))
    o = np.concatenate([[c[0]], c[:-1]])
    idx = pd.bdate_range(end="2026-03-13", periods=len(c))
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) * 1.001, "low": np.minimum(o, c) * 0.999, "close": c, "raw_close": c, "volume": 1e6}, index=idx)


ENTRY_TAIL = [-0.03, -0.03, -0.03]


class FakeBroker:
    def __init__(self, is_open=False, positions=None):
        self.is_open, self.positions, self.orders, self.submits, self.cancels = is_open, positions or {}, {}, [], []
        self.fail_submit = False
        self.open_orders = []

    def get_clock(self):
        return {"is_open": self.is_open}

    def get_positions(self):
        return dict(self.positions)

    def get_open_orders(self):
        return list(self.open_orders)

    def get_order_by_client_id(self, cid):
        return self.orders.get(cid)

    def submit_order(self, symbol, side, qty, cid):
        self.submits.append((symbol, side, qty, cid))
        self.orders[cid] = {"id": "b-" + cid, "client_order_id": cid, "status": "accepted", "filled_qty": "0"}
        if self.fail_submit:
            raise ConnectionError("boom")                       # the order landed at the broker, then the connection died
        return self.orders[cid]

    def cancel_order(self, oid):
        self.cancels.append(oid)


def cfg_for(mode="DRY_RUN", **over):
    c = {"mode": mode, "enabled": True, "universe": ["SPY"], "account": {"initial_equity": 2000, "fractional": True},
         "risk": {"max_alloc_pct": 0.2, "max_combined_pct": 0.4, "risk_pct": 0.01, "daily_loss_pct": 0.02, "slippage_bps": 5, "gap_buffer_pct": 0.01},
         "strategy": {}, "execution": {"stale_data_max_days": 4, "paper_base_url": ex.PAPER_BASE_URL}}
    c.update(over)
    return c


def make_exec(tmp, bars, mode="DRY_RUN", broker=None, confirm=False, cfg=None, now=None, **kw):
    now = now or (bars.index[-1] + pd.Timedelta(hours=18)).tz_localize("America/New_York")
    return ex.TripleRSIExecutor(cfg or cfg_for(mode), broker, lambda s: bars, ex.Store(Path(tmp)), now_fn=lambda: now, confirm_paper=confirm, **kw)


# ============================================================================================ RSI

class TestRSI(unittest.TestCase):
    def test_wilder_published_example(self):
        c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4766, 45.8434, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028,
             46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7138, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314]
        got = [round(x, 2) for x in wilder_rsi(pd.Series(c), 14).dropna().head(6)]
        self.assertEqual(got, [70.53, 66.32, 66.55, 69.41, 66.36, 57.97])

    def test_matches_independent_reference_on_random_walk(self):
        rng = np.random.default_rng(7)
        c = 100 + np.cumsum(rng.normal(0, 1, 400))
        for n in (3, 5, 7, 9):
            self.assertLess(np.max(np.abs(wilder_rsi(pd.Series(c), n).dropna().to_numpy() - np.array(ref_rsi(list(c), n)))), 1e-9)

    def test_warmup_is_nan_then_defined(self):
        s = wilder_rsi(pd.Series(np.linspace(100, 120, 30) + np.sin(np.arange(30))), 5)
        self.assertTrue(s.iloc[:5].isna().all())
        self.assertTrue(s.iloc[5:].notna().all())
        self.assertTrue(wilder_rsi(pd.Series([1.0, 2.0, 3.0]), 5).isna().all())          # shorter than the seed window: all NaN, no crash

    def test_flat_is_50_and_straight_up_is_100(self):
        self.assertEqual(wilder_rsi(pd.Series([10.0] * 12), 5).iloc[-1], 50.0)
        self.assertEqual(wilder_rsi(pd.Series(np.arange(1.0, 13.0)), 5).iloc[-1], 100.0)

    def test_sma_warmup(self):
        ind = compute_indicators(make_bars([]))
        self.assertTrue(ind["sma"].iloc[:199].isna().all())
        self.assertTrue(pd.notna(ind["sma"].iloc[199]))

    def test_atr_wilder(self):
        h, l, c = pd.Series([11.0, 12, 13, 14]), pd.Series([9.0, 10, 11, 12]), pd.Series([10.0, 11, 12, 13])
        a = wilder_atr(h, l, c, 3)
        self.assertTrue(a.iloc[:2].isna().all())
        self.assertAlmostEqual(a.iloc[2], 2.0)
        self.assertAlmostEqual(a.iloc[3], 2.0)


# ============================================================================== entry / exit rules

class TestRules(unittest.TestCase):
    GOOD = [55.0, 45.0, 38.0, 29.0]            # RSI[t-3] < 60, three declines, RSI[t] < 30

    def entry(self, rsi, **kw):
        return bool(entry_signal(ind_frame(rsi, **kw)).iloc[-1])

    def test_all_conditions_true(self):
        self.assertTrue(self.entry(self.GOOD))

    def test_rsi_must_be_below_30(self):
        self.assertFalse(self.entry([55, 45, 38, 30.0]))        # exactly 30 is not "below"
        self.assertFalse(self.entry([60.5, 50, 40, 31]))
        self.assertTrue(self.entry([55, 45, 38, 29.99]))

    def test_must_have_declined_three_sessions_strictly(self):
        self.assertFalse(self.entry([55, 45, 45, 29]))         # equal step breaks strictness
        self.assertFalse(self.entry([55, 40, 42, 29]))         # one up-step in the middle
        self.assertFalse(self.entry([40, 45, 38, 29]))         # first step is up
        self.assertFalse(self.entry([20, 25, 35, 29]))

    def test_rsi_three_sessions_ago_must_be_below_60(self):
        self.assertFalse(self.entry([60.0, 45, 38, 29]))       # exactly 60 is not "below"
        self.assertFalse(self.entry([75, 45, 38, 29]))
        self.assertTrue(self.entry([59.99, 45, 38, 29]))

    def test_close_must_be_above_sma(self):
        self.assertFalse(self.entry(self.GOOD, close=[100.0] * 4, sma=[100.0] * 4))   # equal is not above
        self.assertFalse(self.entry(self.GOOD, close=[90.0] * 4, sma=[100.0] * 4))

    def test_nan_in_lookback_or_too_few_rows_means_no_signal(self):
        self.assertFalse(self.entry([np.nan, 45, 38, 29]))
        self.assertFalse(self.entry([55, 45, 38, 29], sma=[np.nan] * 4))
        self.assertFalse(self.entry([45, 38, 29]))             # only 3 rows: needs t-3

    def test_original_baseline_values(self):
        self.assertEqual((BASELINE.rsi_len, BASELINE.oversold, BASELINE.prior_max, BASELINE.exit_level, BASELINE.sma_len), (5, 30, 60, 50, 200))
        self.assertIsNone(BASELINE.atr_stop_mult)
        self.assertIsNone(BASELINE.max_hold)
        self.assertIsNone(BASELINE.vix_max)

    def test_exit_requires_cross_above_50(self):
        ex_ = lambda r, p=BASELINE: bool(exit_signal(ind_frame(r), p).iloc[-1])
        self.assertTrue(ex_([49.0, 51.0]))
        self.assertTrue(ex_([50.0, 51.0]))                      # t-1 <= 50 counts
        self.assertFalse(ex_([49.0, 50.0]))                     # must be strictly above 50
        self.assertFalse(ex_([51.0, 53.0]))                     # already above: no fresh cross
        self.assertFalse(ex_([55.0, 49.0]))
        self.assertFalse(ex_([np.nan, 51.0]))
        self.assertTrue(ex_([54.0, 56.0], replace(BASELINE, exit_level=55.0)))

    def test_vix_filter_fails_closed(self):
        f = ind_frame(self.GOOD)
        with self.assertRaises(ValueError):
            entry_signal(f, replace(BASELINE, vix_max=30.0))   # no vix column: refuse, never silently ignore the filter
        f["vix"] = [20, 20, 20, np.nan]
        self.assertFalse(bool(entry_signal(f, replace(BASELINE, vix_max=30.0)).iloc[-1]))
        f["vix"] = [20, 20, 20, 25]
        self.assertTrue(bool(entry_signal(f, replace(BASELINE, vix_max=30.0)).iloc[-1]))
        f["vix"] = [20, 20, 20, 35]
        self.assertFalse(bool(entry_signal(f, replace(BASELINE, vix_max=30.0)).iloc[-1]))

    def test_synthetic_series_triggers_full_rule_on_real_indicators(self):
        ind = prepare({"X": make_bars(ENTRY_TAIL)}, BASELINE)["X"]
        self.assertTrue(bool(ind["entry"].iloc[-1]), ind[["close", "rsi", "sma"]].tail(5))
        self.assertFalse(bool(ind["entry"].iloc[:-2].any()))     # the rule also (correctly) fires on the 2nd big down day, never before the dip


# ============================================================================================ sizing

class TestSizing(unittest.TestCase):
    def test_allocation_cap_20pct(self):
        r = size_position(SizingInputs(equity=2000, price=500, atr=None, atr_stop_mult=None))
        self.assertEqual(r.reason, "ok")
        self.assertAlmostEqual(r.notional, 400, places=3)

    def test_combined_cap_40pct(self):
        r = size_position(SizingInputs(equity=2000, price=500, atr=None, atr_stop_mult=None, existing_alloc=700))
        self.assertAlmostEqual(r.notional, 100, places=3)
        self.assertEqual(size_position(SizingInputs(equity=2000, price=500, atr=None, atr_stop_mult=None, existing_alloc=800)).qty, 0)

    def test_risk_budget_with_atr_stop_and_estimate_includes_slippage_and_gap(self):
        r = size_position(SizingInputs(equity=2000, price=500, atr=10, atr_stop_mult=2.0, slippage_pct=0.0005, gap_buffer_pct=0.01))
        self.assertAlmostEqual(r.stop_price, 480)
        self.assertLessEqual(r.est_loss, 20.0 + 1e-6)          # 1% of 2000
        self.assertAlmostEqual(r.qty, 20 / (20 + 500 * 0.011), places=4)

    def test_estimated_loss_never_exceeds_budget_for_random_inputs(self):
        rng = np.random.default_rng(3)
        for _ in range(300):
            s = SizingInputs(equity=float(rng.uniform(500, 5000)), price=float(rng.uniform(5, 800)), atr=float(rng.uniform(0.2, 30)), atr_stop_mult=2.0)
            r = size_position(s)
            if r.qty > 0:
                self.assertLessEqual(r.est_loss, s.risk_pct * s.equity + 1e-6)
                self.assertLessEqual(r.notional, s.max_alloc_pct * s.equity + 1e-6)

    def test_refusals(self):
        self.assertEqual(size_position(SizingInputs(equity=2000, price=500, atr=None, atr_stop_mult=2.0)).reason, "ATR stop requested but ATR unavailable")
        self.assertEqual(size_position(SizingInputs(equity=0, price=500, atr=1, atr_stop_mult=None)).qty, 0)
        self.assertEqual(size_position(SizingInputs(equity=2000, price=500, atr=None, atr_stop_mult=None, fractional=False)).qty, 0)   # 400 < 1 share
        self.assertEqual(size_position(SizingInputs(equity=2000, price=500, atr=1000, atr_stop_mult=2.0)).reason, "stop price would be non-positive")

    def test_whole_shares_when_fractional_off(self):
        r = size_position(SizingInputs(equity=2000, price=50, atr=None, atr_stop_mult=None, fractional=False))
        self.assertEqual(r.qty, 8.0)

    def test_daily_loss_threshold(self):
        self.assertFalse(daily_loss_breached(2000, 1961))
        self.assertTrue(daily_loss_breached(2000, 1960))
        self.assertTrue(daily_loss_breached(0, 0))


# ===================================================================================== engine models

class TestEngine(unittest.TestCase):
    def sim(self, frames, model, **kw):
        p = kw.pop("p", BASELINE)
        return simulate(frames, p, SimConfig(model=model, slippage_bps=kw.pop("slip", 0.0), **kw))

    def base_frames(self, **kw):
        o = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]
        c = [100.5, 101.5, 102.5, 103.5, 104.5, 105.5, 106.5, 107.5, 108.5, 109.5]
        return {"X": hand_frame(o, c, **kw)}

    def test_model_a_fills_at_signal_close(self):
        f = self.base_frames(entry={2}, exit_={5})
        t = self.sim(f, "A").trades.iloc[0]
        self.assertEqual((t.entry_px, t.exit_px), (102.5, 105.5))
        self.assertEqual(t.entry_date, t.signal_date)

    def test_model_b_fills_at_next_open(self):
        f = self.base_frames(entry={2}, exit_={5})
        t = self.sim(f, "B").trades.iloc[0]
        self.assertEqual((t.entry_px, t.exit_px), (103.0, 106.0))                       # opens of day 3 and day 6
        self.assertEqual(t.entry_date, str(f["X"].index[3].date()))
        self.assertEqual(t.exit_date, str(f["X"].index[6].date()))
        self.assertEqual(t.signal_date, str(f["X"].index[2].date()))

    def test_slippage_is_applied_against_us_on_both_sides(self):
        t = self.sim(self.base_frames(entry={2}, exit_={5}), "B", slip=10.0).trades.iloc[0]
        self.assertAlmostEqual(t.entry_px, 103.0 * 1.001)
        self.assertAlmostEqual(t.exit_px, 106.0 * 0.999)

    def test_no_overlapping_positions_in_same_symbol(self):
        for m in ("A", "B"):
            r = self.sim(self.base_frames(entry={2, 3, 4}, exit_={7}), m)
            self.assertEqual(len(r.trades), 1, m)

    def test_position_sized_at_20_percent_of_strategy_equity(self):
        t = self.sim(self.base_frames(entry={2}, exit_={5}), "A").trades.iloc[0]
        self.assertAlmostEqual(t.notional, 400.0, places=2)

    def test_combined_cap_blocks_third_symbol(self):
        mk = lambda: hand_frame([100] * 8, [100] * 8, entry={2}, exit_={6})
        r = self.sim({"A": mk(), "B": mk(), "C": mk()}, "A")
        self.assertEqual(len(r.trades), 2)
        self.assertIn("combined allocation cap reached", set(r.refused["reason"]))

    def test_daily_loss_limit_blocks_new_entries(self):
        x = hand_frame([100, 100, 100, 100, 100, 100], [100, 100, 100, 88, 88, 88], entry={1}, exit_={5})         # X is held, then falls 12% on day 3
        y = hand_frame([50] * 6, [50] * 6, entry={3}, exit_={5})
        r = self.sim({"X": x, "Y": y}, "A")
        self.assertEqual(set(r.trades["symbol"]), {"X"})
        self.assertIn("daily loss limit", set(r.refused["reason"]))

    def test_atr_stop_fills_at_stop_and_at_open_when_gapped(self):
        p = replace(BASELINE, atr_stop_mult=2.0)
        o = [100, 100, 100, 100, 100, 100]
        r = self.sim({"X": hand_frame(o, [100] * 6, entry={1}, atr=2.0, lows=[99.9, 99.9, 99.9, 95.0, 99.9, 99.9])}, "A", p=p)
        t = r.trades.iloc[0]                                      # entry 100 at close of day 1, stop 96, day 3 low 95 -> stop fill at 96
        self.assertEqual((t.exit_reason, t.exit_px), ("atr_stop", 96.0))
        o2 = [100, 100, 100, 92, 100, 100]
        r2 = self.sim({"X": hand_frame(o2, [100] * 6, entry={1}, atr=2.0, lows=[99.9, 99.9, 99.9, 91.0, 99.9, 99.9])}, "A", p=p)
        t2 = r2.trades.iloc[0]                                    # gap: opens at 92, below the 96 stop -> fills at the open, loss bigger than planned
        self.assertEqual((t2.exit_reason, t2.exit_px), ("atr_stop_gap", 92.0))

    def test_time_stop(self):
        r = self.sim(self.base_frames(entry={1}), "A", p=replace(BASELINE, max_hold=3))
        t = r.trades.iloc[0]
        self.assertEqual((t.exit_reason, t.hold_sessions), ("time_stop", 3))

    def test_open_position_is_marked_and_flagged_at_end(self):
        r = self.sim(self.base_frames(entry={7}), "A")
        self.assertEqual(r.trades.iloc[0].exit_reason, "end_of_data")

    def test_never_spends_more_than_cash(self):
        r = self.sim({k: hand_frame([100] * 8, [100] * 8, entry={2}, exit_={6}) for k in "ABCDE"}, "A", max_alloc_pct=0.5, max_combined_pct=2.0)
        self.assertGreaterEqual(float(r.equity.min()), 0.0)
        self.assertLessEqual(float(r.trades["notional"].sum()), 2000.0 + 1e-6)


# ===================================================================================== no lookahead

class TestNoLookahead(unittest.TestCase):
    def synthetic(self, seed=11, n=1800):
        rng = np.random.default_rng(seed)
        c = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.011, n)))
        o = np.concatenate([[c[0]], c[:-1]]) * (1 + rng.normal(0, 0.002, n))
        idx = pd.bdate_range("2015-01-01", periods=n)
        return pd.DataFrame({"open": o, "high": np.maximum(o, c) * 1.003, "low": np.minimum(o, c) * 0.997, "close": c}, index=idx)

    def test_indicators_and_signals_at_t_ignore_all_later_bars(self):
        df = self.synthetic()
        full = prepare({"X": df}, BASELINE)["X"]
        self.assertGreater(int(full["entry"].sum()), 3)          # non-vacuous
        for k in (400, 900, 1500):
            part = prepare({"X": df.iloc[:k + 1]}, BASELINE)["X"]
            pd.testing.assert_series_equal(full["rsi"].iloc[:k + 1], part["rsi"], check_names=False)
            self.assertTrue((full["entry"].iloc[:k + 1].to_numpy() == part["entry"].to_numpy()).all())
            self.assertTrue((full["exit"].iloc[:k + 1].to_numpy() == part["exit"].to_numpy()).all())

    def test_changing_future_bars_never_changes_past_signals(self):
        df = self.synthetic()
        base = prepare({"X": df}, BASELINE)["X"]
        k = 1000
        d2 = df.copy()
        d2.iloc[k + 1:, :] = d2.iloc[k + 1:, :].to_numpy() * np.random.default_rng(5).uniform(0.5, 1.5, (len(df) - k - 1, 4))
        other = prepare({"X": d2}, BASELINE)["X"]
        for col in ("rsi", "sma", "atr"):
            np.testing.assert_allclose(base[col].iloc[:k + 1].to_numpy(), other[col].iloc[:k + 1].to_numpy(), equal_nan=True)

    def test_simulation_prefix_equals_simulation_of_truncated_history(self):
        df = self.synthetic()
        for model in ("A", "B"):
            for p in (BASELINE, replace(BASELINE, atr_stop_mult=2.0, max_hold=10)):
                full = simulate(prepare({"X": df}, p), p, SimConfig(model=model, slippage_bps=5))
                self.assertGreater(len(full.trades), 3)
                k = 1300
                cut = simulate(prepare({"X": df.iloc[:k + 1]}, p), p, SimConfig(model=model, slippage_bps=5))
                np.testing.assert_allclose(full.equity.iloc[:k + 1].to_numpy(), cut.equity.to_numpy(), rtol=0, atol=1e-9)

    def test_model_b_entry_uses_the_next_open_not_the_signal_bar(self):
        df = self.synthetic()
        fr = prepare({"X": df}, BASELINE)
        res = simulate(fr, BASELINE, SimConfig(model="B", slippage_bps=0))
        self.assertGreater(len(res.trades), 3)
        for _, t in res.trades.iterrows():
            i = fr["X"].index.get_loc(pd.Timestamp(t.entry_date))
            self.assertEqual(str(fr["X"].index[i - 1].date()), t.signal_date)
            self.assertAlmostEqual(t.entry_px, float(fr["X"]["open"].iloc[i]), places=9)
            self.assertTrue(bool(fr["X"]["entry"].iloc[i - 1]))


class TestMetrics(unittest.TestCase):
    def test_wilson_and_flags(self):
        lo, hi = wilson_ci(8, 10)
        self.assertTrue(0.4 < lo < 0.8 < hi < 1.0)
        eq = pd.Series(np.linspace(2000, 2100, 50), index=pd.bdate_range("2024-01-01", periods=50))
        t = pd.DataFrame({"pnl": [5.0, -2.0], "ret_pct": [1.0, -0.5], "hold_sessions": [5, 4], "exit_reason": ["rsi_cross"] * 2})
        m = compute_metrics(eq, t, 2000.0)
        self.assertIn("INSUFFICIENT", m["sample_flag"])
        self.assertAlmostEqual(m["net_return_pct"], 5.0)
        self.assertAlmostEqual(m["profit_factor"], 2.5)
        self.assertAlmostEqual(m["expectancy_usd"], 1.5)


# ========================================================================= executor safety + mocks

class TestExecutorSafety(unittest.TestCase):
    def test_only_dry_run_and_paper_exist(self):
        with tempfile.TemporaryDirectory() as d:
            for bad in ("LIVE", "live", "Live", "REAL", "", "PAPER_LIVE"):
                with self.assertRaises(ex.SafetyError, msg=bad):
                    make_exec(d, make_bars(ENTRY_TAIL), mode=bad, broker=FakeBroker(), confirm=True)

    def test_paper_needs_explicit_confirmation(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ex.SafetyError):
                make_exec(d, make_bars(ENTRY_TAIL), mode="PAPER", broker=FakeBroker(), confirm=False)

    def test_non_paper_trading_host_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            c = cfg_for("DRY_RUN")
            c["execution"]["paper_base_url"] = "https://api.alpaca.markets"
            with self.assertRaises(ex.SafetyError):
                make_exec(d, make_bars(ENTRY_TAIL), cfg=c)
        with self.assertRaises(ex.SafetyError):
            ex.AlpacaPaperBroker(base_url="https://api.alpaca.markets")

    def test_source_never_names_the_live_trading_host(self):
        src = Path(ex.__file__).read_text("utf-8")
        self.assertNotIn("//api.alpaca.markets", src)
        self.assertEqual(ex.PAPER_BASE_URL, "https://paper-api.alpaca.markets")
        self.assertEqual(ex.ALLOWED_MODES, ("DRY_RUN", "PAPER"))

    def test_adapter_needs_credentials_from_env_and_never_hardcodes_them(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ex.SafetyError):
                ex.AlpacaPaperBroker()
        import re
        for f in (ROOT / "execution" / "triple_rsi_paper.py", ROOT / "backtests" / "triple_rsi_backtest.py", ROOT / "config" / "triple_rsi.yaml"):
            self.assertIsNone(re.search(r"PK[A-Z0-9]{18}", f.read_text("utf-8")), f.name)           # Alpaca key id shape

    def test_non_baseline_parameters_need_gate_and_human_approval(self):
        with tempfile.TemporaryDirectory() as d:
            c = cfg_for("DRY_RUN", strategy={"sma_len": 150})
            with self.assertRaises(ex.SafetyError):
                make_exec(d, make_bars(ENTRY_TAIL), cfg=c, promotion_path=Path(d) / "none.json")
            label = replace(BASELINE, sma_len=150).label()
            pj = Path(d) / "p.json"
            pj.write_text(json.dumps({"gate_passed": True, "human_approved": False, "candidate": {"label": label}}))
            with self.assertRaises(ex.SafetyError):
                make_exec(d, make_bars(ENTRY_TAIL), cfg=c, promotion_path=pj)
            pj.write_text(json.dumps({"gate_passed": True, "human_approved": True, "candidate": {"label": label}}))
            make_exec(d, make_bars(ENTRY_TAIL), cfg=c, promotion_path=pj)           # allowed only now
            with self.assertRaises(ex.SafetyError):
                make_exec(d, make_bars(ENTRY_TAIL), cfg=cfg_for("DRY_RUN", strategy={"atr_stop_mult": 2.0}), promotion_path=pj)

    def test_disabled_switch(self):
        with tempfile.TemporaryDirectory() as d:
            e = make_exec(d, make_bars(ENTRY_TAIL), cfg=cfg_for("DRY_RUN", enabled=False))
            self.assertEqual(e.run_once(), {"skipped": "disabled"})


class TestExecutorFlow(unittest.TestCase):
    def test_dry_run_records_signal_but_never_touches_a_broker(self):
        class Tripwire:
            def __getattr__(self, name):
                raise AssertionError(f"broker.{name} touched in DRY_RUN")
        with tempfile.TemporaryDirectory() as d:
            e = make_exec(d, make_bars(ENTRY_TAIL), mode="DRY_RUN", broker=Tripwire())
            rep = e.run_once()
            dec = rep["decisions"][0]
            self.assertEqual((dec["action"], dec["result"]), ("buy", "dry_run"))
            self.assertTrue(dec["entry_signal"])
            self.assertEqual(len(dec["rsi"]), 4)
            self.assertTrue((Path(d) / "signals.jsonl").exists())
            with open(Path(d) / "orders.jsonl") as fh:
                self.assertEqual(sum(1 for _ in fh), 1)
            rep2 = make_exec(d, make_bars(ENTRY_TAIL), mode="DRY_RUN").run_once()           # the same evening again: no second order record
            self.assertEqual(rep2["decisions"][0]["result"], "duplicate_skipped")

    def test_a_dry_run_record_does_not_block_the_real_paper_order_for_the_same_signal(self):
        with tempfile.TemporaryDirectory() as d:
            bars, b = make_bars(ENTRY_TAIL), FakeBroker()
            make_exec(d, bars, "DRY_RUN").run_once()
            self.assertEqual(b.submits, [])
            make_exec(d, bars, "PAPER", b, True).run_once()          # same state dir, same signal date
            self.assertEqual(len(b.submits), 1)
            make_exec(d, bars, "PAPER", b, True).run_once()          # and now the normal duplicate protection applies
            self.assertEqual(len(b.submits), 1)

    def test_paper_buy_uses_deterministic_client_id_and_correct_size(self):
        with tempfile.TemporaryDirectory() as d:
            bars, b = make_bars(ENTRY_TAIL), FakeBroker()
            rep = make_exec(d, bars, "PAPER", b, True).run_once()
            self.assertEqual(len(b.submits), 1)
            sym, side, qty, cid = b.submits[0]
            self.assertEqual((sym, side, cid), ("SPY", "buy", f"trsi-SPY-{bars.index[-1].date()}-buy"))
            self.assertAlmostEqual(qty * float(bars["close"].iloc[-1]), 400.0, delta=0.01)       # 20% of the strategy's own $2000
            self.assertEqual(rep["decisions"][0]["action"], "buy")

    def test_restart_cannot_duplicate_an_order(self):
        with tempfile.TemporaryDirectory() as d:
            bars, b = make_bars(ENTRY_TAIL), FakeBroker()
            make_exec(d, bars, "PAPER", b, True).run_once()
            make_exec(d, bars, "PAPER", b, True).run_once()          # process restarted, same state dir
            self.assertEqual(len(b.submits), 1)

    def test_lost_local_state_adopts_the_order_already_at_the_broker(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            bars, b = make_bars(ENTRY_TAIL), FakeBroker()
            make_exec(d1, bars, "PAPER", b, True).run_once()
            make_exec(d2, bars, "PAPER", b, True).run_once()         # empty local state, broker already has the client_order_id
            self.assertEqual(len(b.submits), 1)

    def test_connection_error_during_submit_does_not_resend(self):
        with tempfile.TemporaryDirectory() as d:
            b = FakeBroker()
            b.fail_submit = True
            rep = make_exec(d, make_bars(ENTRY_TAIL), "PAPER", b, True).run_once()
            self.assertEqual(len(b.submits), 1)
            self.assertEqual(rep["decisions"][0]["result"], "accepted")

    def test_market_open_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            b = FakeBroker(is_open=True)
            rep = make_exec(d, make_bars(ENTRY_TAIL), "PAPER", b, True).run_once()
            self.assertIn("market_open", rep["skipped"])
            self.assertEqual(b.submits, [])

    def test_stale_data_blocks_trading(self):
        with tempfile.TemporaryDirectory() as d:
            b = FakeBroker()
            bars = make_bars(ENTRY_TAIL)
            late = (bars.index[-1] + pd.Timedelta(days=10)).tz_localize("America/New_York")
            rep = make_exec(d, bars, "PAPER", b, True, now=late).run_once()
            self.assertTrue(rep["errors"])
            self.assertEqual(b.submits, [])

    def test_partial_fills_are_applied_once_then_completed(self):
        with tempfile.TemporaryDirectory() as d:
            bars, b = make_bars(ENTRY_TAIL), FakeBroker()
            e = make_exec(d, bars, "PAPER", b, True)
            e.run_once()
            cid, qty = b.submits[0][3], b.submits[0][2]
            b.orders[cid].update(status="partially_filled", filled_qty=str(qty / 2), filled_avg_price="500", filled_at="2026-03-16T13:30:00Z")
            e.sync_orders()
            e.sync_orders()                                           # idempotent: same data, no double count
            self.assertAlmostEqual(e.store.state["positions"]["SPY"]["qty"], qty / 2, places=6)
            b.orders[cid].update(status="filled", filled_qty=str(qty))
            e.sync_orders()
            self.assertAlmostEqual(e.store.state["positions"]["SPY"]["qty"], qty, places=6)
            self.assertEqual(e.store.state["positions"]["SPY"]["entry_date"], "2026-03-16")

    def test_rejected_order_creates_no_position(self):
        with tempfile.TemporaryDirectory() as d:
            b = FakeBroker()
            e = make_exec(d, make_bars(ENTRY_TAIL), "PAPER", b, True)
            e.run_once()
            cid = b.submits[0][3]
            b.orders[cid].update(status="rejected", reject_reason="insufficient buying power")
            e.sync_orders()
            self.assertEqual(e.store.state["positions"], {})
            self.assertEqual(e.store.state["orders"][cid]["status"], "rejected")

    def test_reconcile_shortfall_halts_new_entries(self):
        with tempfile.TemporaryDirectory() as d:
            st = ex.Store(Path(d))
            st.state["positions"]["SPY"] = {"qty": 1.0, "entry_px": 100.0, "entry_date": "2026-01-02", "signal_date": "2026-01-01"}
            st.save()
            bars = make_bars(ENTRY_TAIL)
            b = FakeBroker(positions={})
            e = ex.TripleRSIExecutor(cfg_for("PAPER", universe=["QQQ"]), b, lambda s: bars, ex.Store(Path(d)),
                                     now_fn=lambda: (bars.index[-1] + pd.Timedelta(hours=18)).tz_localize("America/New_York"), confirm_paper=True)
            rep = e.run_once()
            self.assertTrue(rep["reconcile_problems"])
            self.assertEqual(rep["decisions"][0]["action"], "blocked")
            self.assertEqual(b.submits, [])

    def test_stale_pending_orders_are_cancelled_but_current_ones_are_kept(self):
        with tempfile.TemporaryDirectory() as d:
            bars = make_bars([0.001, 0.001])
            last = str(bars.index[-1].date())
            b = FakeBroker()
            b.open_orders = [{"id": "old", "client_order_id": "trsi-SPY-2026-01-02-buy"}, {"id": "cur", "client_order_id": f"trsi-SPY-{last}-buy"}, {"id": "other", "client_order_id": "scalp-1"}]
            make_exec(d, bars, "PAPER", b, True).run_once()
            self.assertEqual(b.cancels, ["old"])

    def test_sell_uses_only_the_quantity_this_strategy_recorded(self):
        full = make_bars(ENTRY_TAIL + [0.02] * 6)
        ind = prepare({"X": full}, BASELINE)["X"]
        cut = int(np.flatnonzero(ind["exit"].to_numpy())[0])            # first RSI cross above 50 after the dip
        bars = full.iloc[:cut + 1]
        self.assertTrue(bool(prepare({"X": bars}, BASELINE)["X"]["exit"].iloc[-1]))
        with tempfile.TemporaryDirectory() as d:
            st = ex.Store(Path(d))
            st.state["positions"]["SPY"] = {"qty": 0.5, "entry_px": 400.0, "entry_date": str(bars.index[-8].date()), "signal_date": str(bars.index[-9].date())}
            st.save()
            b = FakeBroker(positions={"SPY": 100.0})                  # the shared paper account holds 100 SPY for other reasons
            make_exec(d, bars, "PAPER", b, True).run_once()
            sells = [s for s in b.submits if s[1] == "sell"]
            self.assertEqual(len(sells), 1)
            self.assertEqual(sells[0][2], 0.5)


class TestBrokerRetries(unittest.TestCase):
    def test_outage_is_retried_then_succeeds_without_leaking_keys(self):
        class R:
            def __init__(self, code, js=None):
                self.status_code, self._j = code, js

            def json(self):
                return self._j

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError("http")

        calls = []

        class S:
            def request(self, method, url, **kw):
                calls.append(url)
                if len(calls) < 3:
                    raise ConnectionError("down SECRET-VALUE-123")
                return R(200, {"is_open": False})

        class Dead:
            def request(self, *a, **k):
                raise ConnectionError("down SECRET-VALUE-123")

        with mock.patch.dict(os.environ, {"APCA_API_KEY_ID": "KEYIDFORTEST", "APCA_API_SECRET_KEY": "SECRET-VALUE-123"}), mock.patch("time.sleep"):
            b = ex.AlpacaPaperBroker(session=S(), retries=3)
            self.assertEqual(b.get_clock(), {"is_open": False})
            self.assertEqual(len(calls), 3)
            self.assertTrue(all(u.startswith("https://paper-api.alpaca.markets") for u in calls))
            with self.assertRaises(RuntimeError) as cm:
                ex.AlpacaPaperBroker(session=Dead(), retries=2).get_clock()
            self.assertNotIn("SECRET-VALUE-123", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
