"""Triple RSI mean-reversion strategy (rules from QuantifiedStrategies.com), as a pure, broker-free module.

Everything here is a pure function of completed daily bars: no network, no clock, no broker, no files.
Indicators at row t use only rows <= t (no lookahead); the tests prove that by perturbing future bars.

ORIGINAL RULES (the immutable baseline, ``BASELINE``):
  1. Wilder RSI(5) on daily ADJUSTED closes.
  2. RSI[t] < 30.
  3. RSI declined three sessions in a row: RSI[t] < RSI[t-1] < RSI[t-2] < RSI[t-3].
  4. RSI[t-3] < 60.
  5. Close[t] > SMA(200)[t].
  6. Enter long when all of the above hold (original model: at the signal-day close).
  7. Exit when RSI crosses above 50: RSI[t-1] <= 50 and RSI[t] > 50.
  8. No overlapping positions in the same symbol (enforced by the callers that hold position state).

The ATR stop, the time stop and the position-sizing/risk rules are ADDITIONAL safeguards, not part of the original
strategy; they are parameters that default to OFF in ``BASELINE`` so the baseline stays exactly the published rules.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Optional

import numpy as np
import pandas as pd

__all__ = [
    "TripleRSIParams", "BASELINE", "wilder_rsi", "wilder_atr", "sma", "compute_indicators",
    "entry_signal", "exit_signal", "SizingInputs", "SizingResult", "size_position",
    "daily_loss_breached", "required_columns", "with_params",
]


@dataclass(frozen=True)
class TripleRSIParams:
    """Strategy parameters. The defaults ARE the original published rules."""
    rsi_len: int = 5
    oversold: float = 30.0          # RSI[t] must be below this
    prior_max: float = 60.0         # RSI[t-3] must be below this
    exit_level: float = 50.0        # exit when RSI crosses above this
    sma_len: int = 200              # close must be above this SMA
    atr_len: int = 14
    atr_stop_mult: Optional[float] = None   # None = no ATR stop (baseline). Safeguard, not part of the original rules.
    max_hold: Optional[int] = None          # None = no time stop (baseline). Sessions held before a forced exit.
    vix_max: Optional[float] = None         # None = no VIX regime filter (baseline). Entry needs VIX close < this (needs a 'vix' column).

    def label(self) -> str:
        parts = [f"rsi{self.rsi_len}", f"os{self.oversold:g}", f"ex{self.exit_level:g}", f"sma{self.sma_len}"]
        parts.append(f"atr{self.atr_stop_mult:g}" if self.atr_stop_mult else "noatr")
        parts.append(f"hold{self.max_hold}" if self.max_hold else "nohold")
        parts.append(f"vix{self.vix_max:g}" if self.vix_max else "novix")
        return "-".join(parts)


BASELINE = TripleRSIParams()


def required_columns() -> tuple[str, ...]:
    return ("open", "high", "low", "close")


def wilder_rsi(close: pd.Series, n: int) -> pd.Series:
    """Wilder RSI. Seed = simple mean of the first n gains/losses (first value appears at index n); then
    avg = (prev_avg*(n-1) + x)/n. avg_loss == 0 gives 100 (50 if there was no movement at all). NaN before the seed."""
    if n < 1:
        raise ValueError("rsi length must be >= 1")
    c = close.to_numpy(dtype=float)
    out = np.full(len(c), np.nan)
    if len(c) <= n:
        return pd.Series(out, index=close.index)
    diff = np.diff(c)
    gain, loss = np.where(diff > 0, diff, 0.0), np.where(diff < 0, -diff, 0.0)
    if np.isnan(diff[:n]).any():
        raise ValueError("NaN inside the RSI seed window; clean the data first")
    ag, al = gain[:n].mean(), loss[:n].mean()
    for i in range(n, len(c)):
        if i > n:
            if np.isnan(diff[i - 1]):                # a missing close poisons the recursion on purpose
                ag = al = np.nan
            else:
                ag, al = (ag * (n - 1) + gain[i - 1]) / n, (al * (n - 1) + loss[i - 1]) / n
        if np.isnan(ag) or np.isnan(al):
            continue
        out[i] = 50.0 if (al == 0 and ag == 0) else 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return pd.Series(out, index=close.index, name=f"rsi{n}")


def wilder_atr(high: pd.Series, low: pd.Series, close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder ATR. TR[0] = high-low; seed = mean of the first n TRs (value appears at index n-1); then Wilder smoothing."""
    h, l, c = (x.to_numpy(dtype=float) for x in (high, low, close))
    tr = np.empty(len(c))
    tr[0] = h[0] - l[0]
    if len(c) > 1:
        pc = c[:-1]
        tr[1:] = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - pc), np.abs(l[1:] - pc)])
    out = np.full(len(c), np.nan)
    if len(c) >= n:
        a = tr[:n].mean()
        out[n - 1] = a
        for i in range(n, len(c)):
            a = (a * (n - 1) + tr[i]) / n
            out[i] = a
    return pd.Series(out, index=close.index, name=f"atr{n}")


def sma(close: pd.Series, n: int) -> pd.Series:
    return close.rolling(n, min_periods=n).mean()


def compute_indicators(df: pd.DataFrame, p: TripleRSIParams = BASELINE) -> pd.DataFrame:
    """Return a copy of ``df`` with rsi, sma, atr columns. ``df`` must be completed, adjusted daily bars, sorted ascending."""
    missing = [c for c in required_columns() if c not in df.columns]
    if missing:
        raise ValueError(f"missing columns {missing}")
    if not df.index.is_monotonic_increasing or df.index.has_duplicates:
        raise ValueError("bars must be sorted ascending with unique dates")
    out = df.copy()
    out["rsi"] = wilder_rsi(out["close"], p.rsi_len)
    out["sma"] = sma(out["close"], p.sma_len)
    out["atr"] = wilder_atr(out["high"], out["low"], out["close"], p.atr_len)
    return out


def entry_signal(ind: pd.DataFrame, p: TripleRSIParams = BASELINE) -> pd.Series:
    """True on day t when ALL original entry conditions hold. NaN anywhere in the lookback => False (warmup)."""
    r = ind["rsi"]
    cond = (
        (r < p.oversold)
        & (r < r.shift(1)) & (r.shift(1) < r.shift(2)) & (r.shift(2) < r.shift(3))
        & (r.shift(3) < p.prior_max)
        & (ind["close"] > ind["sma"])
    )
    if p.vix_max is not None:
        if "vix" not in ind.columns:
            raise ValueError("vix_max set but no 'vix' column; refusing to silently ignore a requested filter")
        cond = cond & (ind["vix"] < p.vix_max)      # unknown VIX (NaN) => False: fail closed
    return cond.fillna(False).astype(bool).rename("entry")


def exit_signal(ind: pd.DataFrame, p: TripleRSIParams = BASELINE) -> pd.Series:
    """True on day t when RSI crosses above the exit level: RSI[t-1] <= level and RSI[t] > level."""
    r = ind["rsi"]
    cond = (r.shift(1) <= p.exit_level) & (r > p.exit_level)
    return cond.fillna(False).astype(bool).rename("exit")


# ---------------------------------------------------------------- position sizing and risk (safeguards)

@dataclass(frozen=True)
class SizingInputs:
    equity: float                    # the strategy's OWN equity (configured notional + its own P&L), never the broker account equity
    price: float                     # estimated entry price
    atr: Optional[float]             # ATR at the signal day (None if unknown)
    atr_stop_mult: Optional[float]   # None = no ATR stop => risk-budget sizing not possible, allocation cap only
    max_alloc_pct: float = 0.20      # per-symbol cap
    max_combined_pct: float = 0.40   # all strategy positions combined
    risk_pct: float = 0.01           # planned loss budget per trade
    existing_alloc: float = 0.0      # dollars already allocated to other open positions of this strategy
    slippage_pct: float = 0.0005     # per side, fraction of price
    gap_buffer_pct: float = 0.01     # extra overnight-gap allowance, fraction of price
    fractional: bool = True
    min_notional: float = 1.0        # Alpaca minimum fractional order is $1


@dataclass(frozen=True)
class SizingResult:
    qty: float
    notional: float
    stop_price: Optional[float]
    est_loss: Optional[float]        # estimated loss at the stop INCLUDING slippage and the gap buffer (still not a guarantee)
    reason: str                      # "ok" or why the trade was refused


def size_position(s: SizingInputs) -> SizingResult:
    """Size = min(allocation cap, remaining combined cap, risk budget). Refuses (qty 0) when it cannot fit or is below the minimum.
    The estimated loss is an ESTIMATE: an overnight gap through the stop can lose more; stops are never a guaranteed cap."""
    if not (s.equity > 0 and s.price > 0):
        return SizingResult(0.0, 0.0, None, None, "non-positive equity or price")
    alloc_cap = min(s.max_alloc_pct * s.equity, max(0.0, s.max_combined_pct * s.equity - s.existing_alloc))
    if alloc_cap <= 0:
        return SizingResult(0.0, 0.0, None, None, "combined allocation cap reached")
    qty = alloc_cap / s.price
    stop_price = est_loss = None
    if s.atr_stop_mult:
        if not (s.atr and s.atr > 0):
            return SizingResult(0.0, 0.0, None, None, "ATR stop requested but ATR unavailable")
        stop_dist = s.atr_stop_mult * s.atr
        stop_price = s.price - stop_dist
        if stop_price <= 0:
            return SizingResult(0.0, 0.0, stop_price, None, "stop price would be non-positive")
        loss_per_share = stop_dist + s.price * (2 * s.slippage_pct + s.gap_buffer_pct)
        qty = min(qty, (s.risk_pct * s.equity) / loss_per_share)
    qty = math.floor(qty * 1e6) / 1e6 if s.fractional else float(math.floor(qty))
    notional = qty * s.price
    if qty <= 0 or notional < s.min_notional:
        return SizingResult(0.0, 0.0, stop_price, None, "position too small after caps (below minimum notional)")
    if s.atr_stop_mult:
        est_loss = qty * (s.atr_stop_mult * s.atr + s.price * (2 * s.slippage_pct + s.gap_buffer_pct))
    return SizingResult(qty, notional, stop_price, est_loss, "ok")


def daily_loss_breached(start_of_day_equity: float, current_equity: float, limit_pct: float = 0.02) -> bool:
    """True when realized+unrealized loss since the start of the day reaches limit_pct of the starting equity: block NEW entries."""
    if start_of_day_equity <= 0:
        return True
    return (start_of_day_equity - current_equity) >= limit_pct * start_of_day_equity


def with_params(p: TripleRSIParams, **kw) -> TripleRSIParams:
    return replace(p, **kw)
