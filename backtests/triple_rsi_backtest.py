"""Triple RSI backtests: Model A (original close-to-close) and Model B (executable next-open), plus robustness tooling.

Run from the repo root:
    python -m backtests.triple_rsi_backtest baseline  [--symbols SPY QQQ] [--source auto|yfinance|alpaca]
    python -m backtests.triple_rsi_backtest optimize
    python -m backtests.triple_rsi_backtest fetch

Model A  : signal on day t's close, fill AT that close (the published assumption; NOT reproducible live).
Model B  : signal on day t's completed bar, order fills at day t+1's OPEN (what the paper executor does), with slippage.
Neither model looks at any bar after the one a decision is made on; tests/test_triple_rsi.py proves that by perturbing future bars.
Prices are split+dividend ADJUSTED (total return). Results are HISTORICAL simulations, not profits.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, asdict, replace
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from strategies.triple_rsi import (  # noqa: E402
    BASELINE, SizingInputs, TripleRSIParams, compute_indicators, entry_signal, exit_signal, size_position,
)

NY = "America/New_York"
DEFAULT_CONFIG = ROOT / "config" / "triple_rsi.yaml"
REPORT_DIR = ROOT / "reports" / "triple_rsi"
CACHE_DIR = ROOT / "data" / "triple_rsi"


class DataError(RuntimeError):
    pass


# =============================================================================================== data

def _clean_frame(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Validate daily bars. Drops rows with missing/non-positive prices or high<low; reports gaps. Never forward-fills prices."""
    n0 = len(df)
    df = df.copy()
    df.index = pd.DatetimeIndex(pd.to_datetime(df.index)).tz_localize(None).normalize()
    df = df[~df.index.duplicated(keep="last")].sort_index()
    ohlc = df[["open", "high", "low", "close"]]
    bad = ohlc.isna().any(axis=1) | (ohlc <= 0).any(axis=1) | (df["high"] < df["low"])
    df = df[~bad]
    gaps = df.index.to_series().diff().dt.days
    report = {"rows_in": n0, "rows_out": len(df), "dropped_bad_rows": int(bad.sum()),
              "first": str(df.index[0].date()) if len(df) else None, "last": str(df.index[-1].date()) if len(df) else None,
              "gaps_over_7_calendar_days": [str(d.date()) for d in gaps[gaps > 7].index]}
    return df, report


def _drop_incomplete(df: pd.DataFrame, now: Optional[pd.Timestamp] = None) -> pd.DataFrame:
    """Drop today's bar if the regular session has not finished (NY time). Only completed daily candles are used."""
    now = pd.Timestamp.now(tz=NY) if now is None else now
    if len(df) and df.index[-1].date() == now.date() and (now.hour, now.minute) < (16, 5):
        return df.iloc[:-1]
    return df


def _fetch_yfinance(symbol: str, start: str) -> pd.DataFrame:
    import yfinance as yf
    raw = yf.download(symbol, start=start, auto_adjust=False, progress=False, actions=False)
    if raw is None or raw.empty:
        raise DataError(f"yfinance returned no data for {symbol}")
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)
    raw = raw.rename(columns=lambda c: str(c).lower().replace(" ", "_"))
    factor = raw["adj_close"] / raw["close"]               # split+dividend adjustment factor, applied to O/H/L too
    return pd.DataFrame({"open": raw["open"] * factor, "high": raw["high"] * factor, "low": raw["low"] * factor,
                         "close": raw["adj_close"], "raw_close": raw["close"], "volume": raw["volume"]})


def _alpaca_creds() -> tuple[Optional[str], Optional[str]]:
    return (os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY"),
            os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY"))


def _fetch_alpaca(symbol: str, start: str, feed: str = "sip") -> pd.DataFrame:
    import requests
    key, sec = _alpaca_creds()
    if not (key and sec):
        raise DataError("Alpaca credentials not found in the environment (APCA_API_KEY_ID / APCA_API_SECRET_KEY)")
    rows, token = [], None
    while True:
        params = {"symbols": symbol, "timeframe": "1Day", "start": start, "adjustment": "all", "feed": feed, "limit": 10000, "sort": "asc"}
        if token:
            params["page_token"] = token
        r = requests.get("https://data.alpaca.markets/v2/stocks/bars", params=params,
                         headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec}, timeout=30)
        if r.status_code != 200:
            raise DataError(f"Alpaca data HTTP {r.status_code} for {symbol}")     # body not echoed: it may contain account details
        j = r.json()
        rows += j.get("bars", {}).get(symbol, [])
        token = j.get("next_page_token")
        if not token:
            break
    if not rows:
        raise DataError(f"Alpaca returned no bars for {symbol}")
    df = pd.DataFrame(rows)
    idx = pd.to_datetime(df["t"], utc=True).dt.tz_convert(NY).dt.tz_localize(None).dt.normalize()
    return pd.DataFrame({"open": df["o"].to_numpy(), "high": df["h"].to_numpy(), "low": df["l"].to_numpy(), "close": df["c"].to_numpy(),
                         "raw_close": df["c"].to_numpy(), "volume": df["v"].to_numpy()}, index=pd.DatetimeIndex(idx))


def _cache_fresh(f: Path) -> bool:
    return f.exists() and (pd.Timestamp.now() - pd.Timestamp(f.stat().st_mtime, unit="s")) < pd.Timedelta(hours=12)


def load_daily(symbol: str, start: str = "1999-01-01", source: str = "auto", cache_dir: Path = CACHE_DIR,
               refresh: bool = False, now: Optional[pd.Timestamp] = None) -> tuple[pd.DataFrame, dict]:
    """Adjusted daily OHLC for ``symbol``. source: alpaca | yfinance | auto (alpaca if credentials exist, else yfinance)."""
    if source == "auto":
        key, sec = _alpaca_creds()
        source = "alpaca" if (key and sec) else "yfinance"
    cache_dir.mkdir(parents=True, exist_ok=True)
    f = cache_dir / f"{source}_{symbol.replace('^', '_')}.csv"
    if _cache_fresh(f) and not refresh:
        df = pd.read_csv(f, index_col=0, parse_dates=True)
    else:
        df = _fetch_alpaca(symbol, start) if source == "alpaca" else _fetch_yfinance(symbol, start)
        df.to_csv(f)
    df, rep = _clean_frame(df)
    df = _drop_incomplete(df, now)
    rep.update(symbol=symbol, source=source, adjusted="split+dividend (total return)", last=str(df.index[-1].date()))
    return df, rep


def load_vix(start: str, cache_dir: Path = CACHE_DIR) -> pd.Series:
    """VIX close from yfinance (^VIX). Alpaca has no VIX; if this fails the caller must not run VIX variants."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    f = cache_dir / "yfinance__VIX.csv"
    if _cache_fresh(f):
        s = pd.read_csv(f, index_col=0, parse_dates=True)["close"]
    else:
        import yfinance as yf
        raw = yf.download("^VIX", start=start, auto_adjust=False, progress=False, actions=False)
        if raw is None or raw.empty:
            raise DataError("no VIX data")
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        s = raw["Close"].rename("close")
        s.to_frame().to_csv(f)
    s.index = pd.DatetimeIndex(pd.to_datetime(s.index)).tz_localize(None).normalize()
    return s[~s.index.duplicated(keep="last")].sort_index()


def prepare(raw: dict[str, pd.DataFrame], p: TripleRSIParams, vix: Optional[pd.Series] = None) -> dict[str, pd.DataFrame]:
    """Indicators + entry/exit signals per symbol (each row uses only rows <= itself)."""
    out = {}
    for s, df in raw.items():
        d = df[["open", "high", "low", "close"]].copy()
        if vix is not None:
            d["vix"] = vix.reindex(d.index).ffill(limit=3)    # same-day VIX close (known at the close); short holiday mismatches only
        ind = compute_indicators(d, p)
        ind["entry"] = entry_signal(ind, p)
        ind["exit"] = exit_signal(ind, p)
        out[s] = ind
    return out


# ====================================================================================== simulation

@dataclass
class SimConfig:
    model: str = "B"                  # "A" = close-to-close (original), "B" = next-open (executable)
    initial_equity: float = 2000.0
    slippage_bps: float = 5.0         # per side, applied against us on every fill and on stop fills
    commission_per_trade: float = 0.0  # Alpaca equities are commission-free; SEC/TAF fees on sells are a few cents and ignored
    max_alloc_pct: float = 0.20
    max_combined_pct: float = 0.40
    risk_pct: float = 0.01
    gap_buffer_pct: float = 0.01
    daily_loss_pct: float = 0.02
    fractional: bool = True
    start: Optional[str] = None       # trading window (indicators still use full history)
    end: Optional[str] = None


@dataclass
class SimResult:
    trades: pd.DataFrame
    equity: pd.Series
    deployed: pd.Series               # fraction of equity held in positions at each close
    refused: pd.DataFrame


TRADE_COLS = ["symbol", "signal_date", "entry_date", "entry_ref", "entry_px", "exit_date", "exit_ref", "exit_px", "exit_reason",
              "qty", "notional", "stop", "pnl", "ret_pct", "hold_sessions", "model"]


def simulate(frames: dict[str, pd.DataFrame], p: TripleRSIParams, cfg: SimConfig) -> SimResult:
    if cfg.model not in ("A", "B"):
        raise ValueError("model must be 'A' or 'B'")
    slip = cfg.slippage_bps / 1e4
    syms = sorted(frames)
    all_dates = sorted(set().union(*[set(f.index) for f in frames.values()]))
    lo = pd.Timestamp(cfg.start) if cfg.start else all_dates[0]
    hi = pd.Timestamp(cfg.end) if cfg.end else all_dates[-1]
    dates = [d for d in all_dates if lo <= d <= hi]
    if not dates:
        raise ValueError("no dates in the requested window")
    di = pd.DatetimeIndex(dates)
    arr = {s: {c: frames[s][c].to_numpy(float) for c in ("open", "high", "low", "close", "atr")} |
              {"entry": frames[s]["entry"].to_numpy(bool), "exit": frames[s]["exit"].to_numpy(bool)} for s in syms}
    idx = {s: frames[s].index.get_indexer(di) for s in syms}

    cash = cfg.initial_equity
    pos: dict[str, dict] = {}
    pend_in: dict[str, dict] = {}
    pend_out: dict[str, str] = {}
    last: dict[str, float] = {}
    trades: list[dict] = []
    refused: list[dict] = []
    eq_list, dep_list = [], []
    prev_eq = cfg.initial_equity
    comm = cfg.commission_per_trade

    def close_pos(s, ref_px, fill_px, d, reason):
        nonlocal cash
        p_ = pos.pop(s)
        cash += p_["qty"] * fill_px - comm
        pnl = (fill_px - p_["entry_px"]) * p_["qty"] - 2 * comm
        notional = p_["qty"] * p_["entry_px"]
        trades.append({"symbol": s, "signal_date": str(p_["signal_date"].date()), "entry_date": str(p_["entry_date"].date()),
                       "entry_ref": p_["entry_ref"], "entry_px": p_["entry_px"], "exit_date": str(d.date()), "exit_ref": ref_px,
                       "exit_px": fill_px, "exit_reason": reason, "qty": p_["qty"], "notional": notional, "stop": p_["stop"],
                       "pnl": pnl, "ret_pct": pnl / notional * 100, "hold_sessions": p_["held"], "model": cfg.model})

    def open_pos(s, ref_px, d, qty, atr_sig, signal_date):
        nonlocal cash
        fill = ref_px * (1 + slip)
        q = min(qty, (cash - comm) / fill)                 # never spend more than cash: no leverage, no margin
        q = math.floor(q * 1e6) / 1e6 if cfg.fractional else float(math.floor(q))
        if q * fill < 1.0:
            refused.append({"date": str(d.date()), "symbol": s, "reason": "insufficient cash at fill"})
            return
        cash -= q * fill + comm
        stop = max(fill - p.atr_stop_mult * atr_sig, 0.0) if p.atr_stop_mult and not np.isnan(atr_sig) else None
        pos[s] = {"qty": q, "entry_px": fill, "entry_ref": ref_px, "entry_date": d, "signal_date": signal_date, "stop": stop, "held": 0}

    for k, d in enumerate(dates):
        bars = {s: int(idx[s][k]) for s in syms if idx[s][k] >= 0}
        if cfg.model == "B":                                               # orders queued at yesterday's close fill at today's OPEN
            for s in list(pend_out):
                if s not in pos:
                    pend_out.pop(s)
                elif s in bars:
                    o = arr[s]["open"][bars[s]]
                    close_pos(s, o, o * (1 - slip), d, pend_out.pop(s))
            for s in list(pend_in):
                if s in bars:
                    o = pend_in.pop(s)
                    open_pos(s, arr[s]["open"][bars[s]], d, o["qty"], o["atr"], o["signal_date"])
        for s in list(pos):                                                # protective stop (safeguard, not an original rule)
            sp = pos[s]["stop"]
            if sp is None or s not in bars or (cfg.model == "A" and pos[s]["entry_date"] == d):
                continue
            o, lw = arr[s]["open"][bars[s]], arr[s]["low"][bars[s]]
            if o <= sp:                                                    # gapped through the stop: fills at the open, not at the stop
                close_pos(s, o, o * (1 - slip), d, "atr_stop_gap")
            elif lw <= sp:
                close_pos(s, sp, sp * (1 - slip), d, "atr_stop")
        for s in bars:
            last[s] = arr[s]["close"][bars[s]]
        for s in pos:
            if s in bars:
                pos[s]["held"] += 1
        eq = cash + sum(q["qty"] * last[s] for s, q in pos.items())
        blocked = (prev_eq - eq) >= cfg.daily_loss_pct * prev_eq
        alloc = sum(q["qty"] * last[s] for s, q in pos.items()) + sum(o["notional"] for o in pend_in.values())
        for s in syms:                                                     # decisions at the close, using only today's completed bar
            if s not in bars:
                continue
            i, c = bars[s], arr[s]["close"][bars[s]]
            if s in pos:
                if s in pend_out:
                    continue
                reason = "rsi_cross" if arr[s]["exit"][i] else ("time_stop" if p.max_hold and pos[s]["held"] >= p.max_hold else None)
                if reason:
                    if cfg.model == "B":
                        pend_out[s] = reason
                    else:
                        close_pos(s, c, c * (1 - slip), d, reason)
            elif s not in pend_in and arr[s]["entry"][i]:
                if blocked:
                    refused.append({"date": str(d.date()), "symbol": s, "reason": "daily loss limit"})
                    continue
                a = float(arr[s]["atr"][i])
                r = size_position(SizingInputs(equity=eq, price=c, atr=None if np.isnan(a) else a, atr_stop_mult=p.atr_stop_mult,
                                               max_alloc_pct=cfg.max_alloc_pct, max_combined_pct=cfg.max_combined_pct, risk_pct=cfg.risk_pct,
                                               existing_alloc=alloc, slippage_pct=slip, gap_buffer_pct=cfg.gap_buffer_pct, fractional=cfg.fractional))
                if r.qty <= 0:
                    refused.append({"date": str(d.date()), "symbol": s, "reason": r.reason})
                    continue
                alloc += r.notional
                if cfg.model == "B":
                    pend_in[s] = {"qty": r.qty, "atr": a, "signal_date": d, "notional": r.notional}
                else:
                    open_pos(s, c, d, r.qty, a, d)
        mv = sum(q["qty"] * last[s] for s, q in pos.items())
        eq2 = cash + mv
        eq_list.append(eq2)
        dep_list.append(mv / eq2 if eq2 > 0 else 0.0)
        prev_eq = eq2
    for s in list(pos):                                                    # still open at the end of the window: mark at the last close, flagged
        close_pos(s, last[s], last[s], dates[-1], "end_of_data")
    return SimResult(pd.DataFrame(trades, columns=TRADE_COLS), pd.Series(eq_list, index=di, name="equity"),
                     pd.Series(dep_list, index=di, name="deployed"), pd.DataFrame(refused))


# ============================================================================================ metrics

def wilson_ci(wins: int, n: int, z: float = 1.96) -> tuple[Optional[float], Optional[float]]:
    if n == 0:
        return None, None
    ph = wins / n
    den = 1 + z * z / n
    centre = (ph + z * z / (2 * n)) / den
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return max(0.0, centre - half), min(1.0, centre + half)


def _f(x) -> Optional[float]:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def compute_metrics(equity: pd.Series, trades: pd.DataFrame, initial: float, deployed: Optional[pd.Series] = None) -> dict:
    eq = equity.astype(float)
    rets = eq.pct_change().dropna()
    yrs = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    total = eq.iloc[-1] / initial - 1
    dd = eq / eq.cummax() - 1
    under = (dd < 0).astype(int)
    longest = int((under.groupby((under == 0).cumsum()).cumsum()).max()) if len(under) else 0
    sd = rets.std()
    dsd = math.sqrt(float((np.minimum(rets.to_numpy(), 0.0) ** 2).mean())) if len(rets) else 0.0   # standard downside deviation vs 0 over ALL days
    n = len(trades)
    out = {"start": str(eq.index[0].date()), "end": str(eq.index[-1].date()), "years": round(yrs, 2), "initial_equity": initial,
           "final_equity": _f(eq.iloc[-1]), "net_return_pct": _f(total * 100),
           "cagr_pct": _f(((eq.iloc[-1] / initial) ** (1 / yrs) - 1) * 100) if eq.iloc[-1] > 0 else None,
           "max_drawdown_pct": _f(dd.min() * 100), "max_drawdown_date": str(dd.idxmin().date()), "longest_underwater_sessions": longest,
           "sharpe": _f(rets.mean() / sd * math.sqrt(252)) if sd and sd > 0 else None,
           "sortino": _f(rets.mean() / dsd * math.sqrt(252)) if dsd and dsd > 0 else None,
           "trades": n}
    if deployed is not None:
        out["exposure_days_pct"] = _f((deployed > 0).mean() * 100)
        out["avg_capital_deployed_pct"] = _f(deployed.mean() * 100)
    if n:
        w, lo_t = trades[trades["pnl"] > 0], trades[trades["pnl"] <= 0]
        lo_, hi_ = wilson_ci(len(w), n)
        gl = -lo_t["pnl"].sum()
        out.update(win_rate_pct=_f(len(w) / n * 100), win_rate_ci95_pct=[_f(lo_ * 100), _f(hi_ * 100)],
                   profit_factor=_f(w["pnl"].sum() / gl) if gl > 0 else None,
                   expectancy_usd=_f(trades["pnl"].mean()), expectancy_pct=_f(trades["ret_pct"].mean()),
                   avg_win_usd=_f(w["pnl"].mean()) if len(w) else None, avg_loss_usd=_f(lo_t["pnl"].mean()) if len(lo_t) else None,
                   avg_win_pct=_f(w["ret_pct"].mean()) if len(w) else None, avg_loss_pct=_f(lo_t["ret_pct"].mean()) if len(lo_t) else None,
                   avg_hold_sessions=_f(trades["hold_sessions"].mean()), net_pnl_usd=_f(trades["pnl"].sum()),
                   worst_trade_pct=_f(trades["ret_pct"].min()), open_at_end=int((trades["exit_reason"] == "end_of_data").sum()))
    out["sample_flag"] = "INSUFFICIENT (<30 trades): win rate and every ratio below are statistically unreliable" if n < 30 else (
        "LOW (<100 trades): treat results as indicative only" if n < 100 else "ok")
    ann = eq.resample("YE").last()
    base = pd.concat([pd.Series([initial]), ann.iloc[:-1]]).to_numpy() if len(ann) else np.array([])
    out["annual_returns_pct"] = {str(d.year): _f((v / b - 1) * 100) for d, v, b in zip(ann.index, ann.to_numpy(), base)}
    return out


def breakdowns(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {"by_ticker": {}, "by_year": {}}
    t = trades.copy()
    t["year"] = pd.to_datetime(t["exit_date"]).dt.year

    def agg(g):
        n = len(g)
        lo_, hi_ = wilson_ci(int((g["pnl"] > 0).sum()), n)
        return {"trades": n, "win_rate_pct": _f((g["pnl"] > 0).mean() * 100), "win_rate_ci95_pct": [_f(lo_ * 100), _f(hi_ * 100)],
                "net_pnl_usd": _f(g["pnl"].sum()), "expectancy_pct": _f(g["ret_pct"].mean())}
    return {"by_ticker": {k: agg(g) for k, g in t.groupby("symbol")}, "by_year": {str(k): agg(g) for k, g in t.groupby("year")}}


def buy_and_hold(raw: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, initial: float) -> dict:
    c = raw["close"].loc[start:end]
    m = compute_metrics(initial * c / c.iloc[0], pd.DataFrame(columns=["pnl", "ret_pct", "hold_sessions", "exit_reason"]), initial)
    m.pop("sample_flag", None)
    return m


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return _f(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, pd.Timestamp):
        return str(o)
    return o


def _plot(res: SimResult, bh: dict[str, pd.Series], title: str, out_dir: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(res.equity.index, res.equity, label="Triple RSI (simulated)", lw=1.6)
    for k, s in bh.items():
        ax.plot(s.index, s, label=f"{k} buy & hold", lw=1, alpha=0.8)
    ax.set_title(title + " - equity (hypothetical, not profits)")
    ax.set_ylabel("USD")
    ax.set_yscale("log")
    ax.legend()
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_dir / "equity.png", dpi=110)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(11, 3.5))
    dd = (res.equity / res.equity.cummax() - 1) * 100
    ax.fill_between(dd.index, dd, 0, color="tab:red", alpha=0.4)
    ax.set_title(title + " - drawdown %")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_dir / "drawdown.png", dpi=110)
    plt.close(fig)


# ============================================================================================ configs

def load_config(path: Path = DEFAULT_CONFIG) -> dict:
    import yaml
    with open(path, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def params_from_cfg(cfg: dict) -> TripleRSIParams:
    return TripleRSIParams(**{k: v for k, v in (cfg.get("strategy") or {}).items() if k in TripleRSIParams.__dataclass_fields__})


def simcfg_from_cfg(cfg: dict, model: str, **over) -> SimConfig:
    r, a, b = cfg.get("risk", {}), cfg.get("account", {}), cfg.get("backtest", {})
    slip = b.get("model_a_slippage_bps", 0.0) if model == "A" else r.get("slippage_bps", 5.0)
    kw = dict(model=model, initial_equity=a.get("initial_equity", 2000.0), slippage_bps=slip,
              max_alloc_pct=r.get("max_alloc_pct", 0.20), max_combined_pct=r.get("max_combined_pct", 0.40), risk_pct=r.get("risk_pct", 0.01),
              gap_buffer_pct=r.get("gap_buffer_pct", 0.01), daily_loss_pct=r.get("daily_loss_pct", 0.02), fractional=a.get("fractional", True))
    kw.update(over)
    return SimConfig(**kw)


def load_universe(symbols: list[str], cfg: dict, source: str, refresh: bool = False) -> tuple[dict[str, pd.DataFrame], dict]:
    start = cfg.get("backtest", {}).get("history_start", "1999-01-01")
    raw, reports = {}, {}
    for s in sorted(set(symbols)):
        raw[s], reports[s] = load_daily(s, start, source, CACHE_DIR, refresh)
    return raw, reports


# ============================================================================================== runs

def run_one(raw: dict[str, pd.DataFrame], symbols: list[str], p: TripleRSIParams, sc: SimConfig, tag: str, out_dir: Path,
            vix: Optional[pd.Series] = None, bench: Optional[dict[str, pd.DataFrame]] = None) -> dict:
    frames = prepare({s: raw[s] for s in symbols}, p, vix if p.vix_max is not None else None)
    if sc.start is None:                                   # report from the first date every symbol has a valid trend filter (warmup excluded)
        sc = replace(sc, start=str(max(f.index[f["sma"].notna()][0] for f in frames.values()).date()))
    res = simulate(frames, p, sc)
    out_dir.mkdir(parents=True, exist_ok=True)
    res.trades.to_csv(out_dir / "trades.csv", index=False)
    if len(res.refused):
        res.refused.to_csv(out_dir / "refused.csv", index=False)
    m = compute_metrics(res.equity, res.trades, sc.initial_equity, res.deployed)
    first_sig = {s: (str(frames[s].index[frames[s]["entry"]][0].date()) if frames[s]["entry"].any() else None) for s in symbols}
    bh, bh_eq = {}, {}
    for b, df in (bench or {}).items():
        bh[b] = buy_and_hold(df, res.equity.index[0], res.equity.index[-1], sc.initial_equity)
        c = df["close"].loc[res.equity.index[0]:res.equity.index[-1]]
        bh_eq[b] = sc.initial_equity * c / c.iloc[0]
    summary = {"tag": tag, "model": sc.model, "params": asdict(p), "label": p.label(), "sim_config": asdict(sc), "symbols": symbols,
               "first_signal_date": first_sig, "metrics": m, **breakdowns(res.trades), "buy_and_hold_same_dates": bh,
               "refused_entries": int(len(res.refused)),
               "note": "HISTORICAL simulation on adjusted prices; not profits. Model A fills at the signal close (not reproducible live); Model B fills at the next open."}
    with open(out_dir / "summary.json", "w", encoding="utf-8") as fh:
        json.dump(_clean(summary), fh, indent=2)
    _plot(res, bh_eq, tag, out_dir)
    return summary


def cmd_baseline(args) -> int:
    cfg = load_config(Path(args.config))
    symbols = args.symbols or cfg.get("universe", ["SPY", "QQQ"])
    source = args.source or cfg.get("backtest", {}).get("data_source", "auto")
    raw, data_reports = load_universe(list(set(symbols) | {"SPY", "QQQ"}), cfg, source, args.refresh)
    results = {}
    for model, name in (("A", "A_original_close_to_close"), ("B", "B_executable_next_open")):
        results[name] = run_one(raw, symbols, BASELINE, simcfg_from_cfg(cfg, model), name, REPORT_DIR / name, bench={"SPY": raw["SPY"], "QQQ": raw["QQQ"]})
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    with open(REPORT_DIR / "baseline_summary.json", "w", encoding="utf-8") as fh:
        json.dump(_clean({"data": data_reports, "results": {k: {"metrics": v["metrics"], "by_ticker": v["by_ticker"], "buy_and_hold": v["buy_and_hold_same_dates"]} for k, v in results.items()}}), fh, indent=2)
    for name, v in results.items():
        m = v["metrics"]
        print(f"{name}: {m['start']}..{m['end']}  trades={m['trades']}  net={m['net_return_pct']:.2f}%  cagr={m['cagr_pct']}  maxDD={m['max_drawdown_pct']:.2f}%  [{m['sample_flag']}]")
    return 0


# ====================================================================== optimization / robustness

def build_variants() -> list[tuple[str, TripleRSIParams]]:
    """One-at-a-time variants around the baseline (NOT a full grid, to limit multiple-testing). Baseline is always first and never changes."""
    b = BASELINE
    v: list[tuple[str, TripleRSIParams]] = [("baseline", b)]
    for n in (3, 7, 9):
        v.append((f"rsi_len={n}", replace(b, rsi_len=n)))
    for n in (20, 25, 35):
        v.append((f"oversold={n}", replace(b, oversold=float(n))))
    for n in (45, 55, 60):
        v.append((f"exit={n}", replace(b, exit_level=float(n))))
    for n in (100, 150):
        v.append((f"sma={n}", replace(b, sma_len=n)))
    v.append(("atr_stop=2", replace(b, atr_stop_mult=2.0)))
    for n in (5, 10, 15):
        v.append((f"max_hold={n}", replace(b, max_hold=n)))
    for n in (25, 35):
        v.append((f"vix_max={n}", replace(b, vix_max=float(n))))
    return v


STAT_KEYS = ("trades", "net_return_pct", "cagr_pct", "max_drawdown_pct", "sharpe", "sortino", "profit_factor", "expectancy_pct", "win_rate_pct", "avg_hold_sessions", "sample_flag")


def _window_stats(frames, p, sc, start, end) -> dict:
    res = simulate(frames, p, replace(sc, start=start, end=end))
    m = compute_metrics(res.equity, res.trades, sc.initial_equity, res.deployed)
    return {k: m.get(k) for k in STAT_KEYS}


def cmd_optimize(args) -> int:
    cfg = load_config(Path(args.config))
    symbols = args.symbols or cfg.get("universe", ["SPY", "QQQ"])
    source = args.source or cfg.get("backtest", {}).get("data_source", "auto")
    sp, sel = cfg["backtest"]["splits"], cfg["selection"]
    raw, _ = load_universe(symbols, cfg, source, args.refresh)
    vix = load_vix(cfg.get("backtest", {}).get("history_start", "1999-01-01"))
    sc = simcfg_from_cfg(cfg, "B")
    first = max(df.index[0] for df in raw.values()) + pd.Timedelta(days=int(260 * 7 / 5))        # clear the 200-bar warmup
    t0, t_end, v_end = str(first.date()), sp["train_end"], sp["validation_end"]
    v0 = str((pd.Timestamp(t_end) + pd.Timedelta(days=1)).date())
    s0 = str((pd.Timestamp(v_end) + pd.Timedelta(days=1)).date())
    variants = build_variants()
    rows, frames_by = [], {}
    for name, p in variants:
        fr = prepare(raw, p, vix if p.vix_max is not None else None)
        frames_by[name] = fr
        rows.append({"variant": name, "label": p.label(), "train": _window_stats(fr, p, sc, t0, t_end), "validation": _window_stats(fr, p, sc, v0, v_end)})
    base = rows[0]
    cands = []
    for r in rows[1:]:
        tr, va = r["train"], r["validation"]
        ok = (va["trades"] >= sel["min_validation_trades"] and (tr["expectancy_pct"] or -1) > 0 and (va["expectancy_pct"] or -1) > 0 and (va["profit_factor"] or 0) > 1
              and (va["sharpe"] or -9) >= (base["validation"]["sharpe"] or -9) and (va["max_drawdown_pct"] or -99) >= (base["validation"]["max_drawdown_pct"] or -99) - sel["max_extra_drawdown_pts"])
        r["passes_train_validation_gate"] = bool(ok)
        if ok:
            cands.append(r)
    chosen = max(cands, key=lambda r: min(r["train"]["sharpe"] or -9, r["validation"]["sharpe"] or -9)) if cands else None
    # Walk-forward (expanding train, 2y blocks) inside train+validation ONLY: the final test period is not touched here.
    wf, blocks = [], []
    y = pd.Timestamp(t0).year + 6
    while y + 1 <= pd.Timestamp(v_end).year:
        blocks.append((f"{y}-01-01", f"{y + 1}-12-31"))
        y += 2
    for bs, be in blocks:
        best, best_score = "baseline", -1e9
        for name, p in variants:
            st = _window_stats(frames_by[name], p, sc, t0, str((pd.Timestamp(bs) - pd.Timedelta(days=1)).date()))
            score = st["expectancy_pct"] if (st["trades"] or 0) >= sel["walk_forward_min_train_trades"] and st["expectancy_pct"] is not None else -1e9
            if score > best_score:
                best, best_score = name, score
        bp = dict(variants)[best]
        wf.append({"block": [bs, be], "chosen_on_prior_data": best, "oos_chosen": _window_stats(frames_by[best], bp, sc, bs, be),
                   "oos_baseline": _window_stats(frames_by["baseline"], BASELINE, sc, bs, be)})
    # Final untouched test: evaluated ONCE, only for the baseline and the single frozen candidate (if any).
    final = {"period": [s0, "end of data"], "baseline": _window_stats(frames_by["baseline"], BASELINE, sc, s0, None)}
    promotion = {"promoted": False, "candidate": None, "reasons": []}
    if chosen is None:
        promotion["reasons"].append("no variant passed the train+validation gate; baseline stays the paper strategy")
    else:
        name = chosen["variant"]
        cp = dict(variants)[name]
        final["candidate"] = {"variant": name, "stats": _window_stats(frames_by[name], cp, sc, s0, None)}
        promotion["candidate"] = {"variant": name, "label": cp.label()}
        ct, bt = final["candidate"]["stats"], final["baseline"]
        checks = {"test trades >= min": (ct["trades"] or 0) >= sel["min_test_trades"],
                  "test expectancy > 0": (ct["expectancy_pct"] or -1) > 0,
                  "test sharpe >= baseline": (ct["sharpe"] or -9) >= (bt["sharpe"] or -9),
                  "test max drawdown not materially worse": (ct["max_drawdown_pct"] or -99) >= (bt["max_drawdown_pct"] or -99) - sel["max_extra_drawdown_pts"],
                  # Materiality (added AFTER the first run, where sma=150 tied the baseline to 4 decimals of Sharpe and still passed the checks above):
                  "test sharpe improves by a material margin": (ct["sharpe"] or -9) >= (bt["sharpe"] or -9) + sel["min_sharpe_improvement"],
                  "test expectancy improves by a material margin": (ct["expectancy_pct"] or -9) >= (bt["expectancy_pct"] or -9) + sel["min_expectancy_improvement_pct"]}
        promotion["checks"] = checks
        promotion["gate_passed"] = all(checks.values())
        promotion["promoted"] = False                       # the gate alone never promotes: a human must also approve (see human_approved)
        promotion["human_approved"] = False
        promotion["reasons"] += [f"FAILED: {k}" for k, v in checks.items() if not v] or ["all out-of-sample checks passed; still needs explicit human approval"]
        promotion["note"] = (f"{len(variants) - 1} variants were compared with the baseline; a pass here is weak evidence. "
                             "The materiality checks were added after the first run (the first-run gate let a statistical tie through).")
    wf_n = sum(w["oos_chosen"]["trades"] or 0 for w in wf)
    wf_summary = {"blocks": len(wf), "pooled_oos_trades_chosen": wf_n,
                  "pooled_oos_expectancy_pct_chosen": (sum((w["oos_chosen"]["trades"] or 0) * (w["oos_chosen"]["expectancy_pct"] or 0) for w in wf) / wf_n) if wf_n else None,
                  "pooled_oos_trades_baseline": sum(w["oos_baseline"]["trades"] or 0 for w in wf),
                  "pooled_oos_expectancy_pct_baseline": (sum((w["oos_baseline"]["trades"] or 0) * (w["oos_baseline"]["expectancy_pct"] or 0) for w in wf) / max(1, sum(w["oos_baseline"]["trades"] or 0 for w in wf))),
                  "blocks_where_chosen_beat_baseline": sum(1 for w in wf if (w["oos_chosen"]["expectancy_pct"] or -9) > (w["oos_baseline"]["expectancy_pct"] or -9))}
    out = {"variants_tested": len(variants), "multiple_testing_note": f"{len(variants) - 1} variants compared with the baseline; with this many looks, some will look good by chance",
           "windows": {"train": [t0, t_end], "validation": [v0, v_end], "final_test": [s0, "end of data"]}, "universe": symbols,
           "variants": rows, "walk_forward": wf, "walk_forward_summary": wf_summary, "final_test": final, "promotion": promotion}
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    with open(REPORT_DIR / "optimization.json", "w", encoding="utf-8") as fh:
        json.dump(_clean(out), fh, indent=2)
    with open(REPORT_DIR / "promotion.json", "w", encoding="utf-8") as fh:
        json.dump(_clean(promotion), fh, indent=2)
    flat = [{"variant": r["variant"], **{f"train_{k}": v for k, v in r["train"].items()}, **{f"val_{k}": v for k, v in r["validation"].items()},
             "gate": r.get("passes_train_validation_gate")} for r in rows]
    pd.DataFrame(flat).to_csv(REPORT_DIR / "variants_train_validation.csv", index=False)
    print(f"variants={len(variants)} windows={out['windows']} promoted={promotion['promoted']} reasons={promotion['reasons']}")
    return 0


def cmd_fetch(args) -> int:
    cfg = load_config(Path(args.config))
    syms = list(set((args.symbols or cfg.get("universe", ["SPY", "QQQ"])) + ["SPY", "QQQ"]))
    _, rep = load_universe(syms, cfg, args.source or cfg.get("backtest", {}).get("data_source", "auto"), True)
    print(json.dumps(_clean(rep), indent=2))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["baseline", "optimize", "fetch"])
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--symbols", nargs="*")
    ap.add_argument("--source", choices=["auto", "yfinance", "alpaca"])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args(argv)
    return {"baseline": cmd_baseline, "optimize": cmd_optimize, "fetch": cmd_fetch}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
