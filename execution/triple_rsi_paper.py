"""Triple RSI paper-trading executor (Model B: signal on a completed daily bar, order fills at the NEXT regular-session open).

    python -m execution.triple_rsi_paper --once                                # DRY_RUN (default): records signals, cannot submit orders
    python -m execution.triple_rsi_paper --once --mode PAPER --confirm-paper   # Alpaca PAPER endpoint only

SAFETY (each point has a test in tests/test_triple_rsi.py):
  * Only DRY_RUN and PAPER exist. Any other mode (including 'LIVE') raises. The trading base URL is the PAPER host constant; a different host raises.
  * DRY_RUN never calls broker.submit_order. PAPER additionally requires --confirm-paper.
  * Baseline parameters only, unless reports/triple_rsi/promotion.json says gate_passed AND human_approved for exactly that label.
  * Orders carry deterministic client_order_ids (trsi-<SYM>-<signal date>-<side>): a restart, a re-run or a retry can never duplicate a trade.
  * Only completed daily bars; refuses to act while the market is open or when the newest bar is stale.
  * Sells only the quantity THIS strategy recorded (the paper account is shared and may hold the same ticker for other reasons).
  * API keys come from the environment and are never logged or written.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Callable, Optional, Protocol

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backtests.triple_rsi_backtest import NY, load_config, load_daily, params_from_cfg, prepare  # noqa: E402
from strategies.triple_rsi import BASELINE, SizingInputs, TripleRSIParams, daily_loss_breached, size_position  # noqa: E402

PAPER_BASE_URL = "https://paper-api.alpaca.markets"     # the ONLY trading host this module will talk to
ALLOWED_MODES = ("DRY_RUN", "PAPER")
TERMINAL = {"filled", "canceled", "cancelled", "expired", "rejected", "done_for_day"}
EPS = 1e-6


class SafetyError(RuntimeError):
    pass


class Broker(Protocol):
    def get_clock(self) -> dict: ...
    def get_positions(self) -> dict[str, float]: ...
    def get_open_orders(self) -> list[dict]: ...
    def get_order_by_client_id(self, client_order_id: str) -> Optional[dict]: ...
    def submit_order(self, symbol: str, side: str, qty: float, client_order_id: str) -> dict: ...
    def cancel_order(self, order_id: str) -> None: ...


# ----------------------------------------------------------------------------------------- Alpaca adapter

class AlpacaPaperBroker:
    """Thin REST adapter for Alpaca's PAPER trading API. The existing Alpaca MCP server exposes the same operations (clock, positions, orders,
    order status/cancel, place_stock_order) but cannot be called from Python, so this adapter talks to the same paper API with env credentials."""

    def __init__(self, base_url: str = PAPER_BASE_URL, retries: int = 3, session=None):
        if base_url.rstrip("/") != PAPER_BASE_URL:
            raise SafetyError("refusing to use any trading host other than the Alpaca PAPER endpoint")
        key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
        sec = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
        if not (key and sec):
            raise SafetyError("Alpaca paper credentials are not set in the environment (APCA_API_KEY_ID / APCA_API_SECRET_KEY)")
        import requests
        self._s = session or requests.Session()
        self._h = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec}
        self._retries = retries

    def _req(self, method: str, path: str, **kw):
        last = None
        for attempt in range(self._retries):
            try:
                r = self._s.request(method, PAPER_BASE_URL + path, headers=self._h, timeout=20, **kw)
                if r.status_code in (429, 500, 502, 503, 504):
                    last = RuntimeError(f"HTTP {r.status_code}")
                    time.sleep(min(2 ** attempt, 8))
                    continue
                return r
            except Exception as e:                      # network outage: retry, never echo headers
                last = e
                time.sleep(min(2 ** attempt, 8))
        raise RuntimeError(f"Alpaca request failed after {self._retries} attempts: {type(last).__name__}")

    def get_clock(self) -> dict:
        r = self._req("GET", "/v2/clock")
        r.raise_for_status()
        return r.json()

    def get_positions(self) -> dict[str, float]:
        r = self._req("GET", "/v2/positions")
        r.raise_for_status()
        return {p["symbol"]: float(p["qty"]) for p in r.json()}

    def get_open_orders(self) -> list[dict]:
        r = self._req("GET", "/v2/orders", params={"status": "open", "limit": 500})
        r.raise_for_status()
        return r.json()

    def get_order_by_client_id(self, client_order_id: str) -> Optional[dict]:
        r = self._req("GET", "/v2/orders:by_client_order_id", params={"client_order_id": client_order_id})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def submit_order(self, symbol: str, side: str, qty: float, client_order_id: str) -> dict:
        body = {"symbol": symbol, "qty": str(qty), "side": side, "type": "market", "time_in_force": "day", "client_order_id": client_order_id}
        r = self._req("POST", "/v2/orders", json=body)
        if r.status_code >= 400:
            return {"status": "rejected", "reject_reason": f"HTTP {r.status_code}", "client_order_id": client_order_id}
        return r.json()

    def cancel_order(self, order_id: str) -> None:
        self._req("DELETE", f"/v2/orders/{order_id}")


# ------------------------------------------------------------------------------------------- persistence

class Store:
    """Persistent state + append-only JSONL records (signals, orders, executions, events). State is written atomically."""

    def __init__(self, state_dir: Path):
        self.dir = Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "state.json"
        self.state = json.loads(self.path.read_text("utf-8")) if self.path.exists() else {"positions": {}, "orders": {}, "realized_pnl": 0.0, "halt_entries": False}

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2), "utf-8")
        os.replace(tmp, self.path)

    def append(self, name: str, row: dict) -> None:
        with open(self.dir / f"{name}.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, default=str) + "\n")


# --------------------------------------------------------------------------------------------- executor

def check_params_allowed(p: TripleRSIParams, promotion_path: Path) -> None:
    if p == BASELINE:
        return
    if p.atr_stop_mult is not None or p.vix_max is not None:
        raise SafetyError("atr_stop_mult / vix_max are backtest-only in this executor (no broker-resident stop or VIX feed is wired); use the baseline")
    try:
        promo = json.loads(Path(promotion_path).read_text("utf-8"))
    except Exception:
        raise SafetyError("non-baseline parameters need reports/triple_rsi/promotion.json; none found")
    if not (promo.get("gate_passed") and promo.get("human_approved") and (promo.get("candidate") or {}).get("label") == p.label()):
        raise SafetyError(f"parameters {p.label()} are not gate-passed AND human-approved; refusing to trade them")


class TripleRSIExecutor:
    def __init__(self, cfg: dict, broker: Optional[Broker], bars_fn: Callable[[str], pd.DataFrame], store: Store,
                 now_fn: Callable[[], pd.Timestamp] = lambda: pd.Timestamp.now(tz=NY), confirm_paper: bool = False,
                 promotion_path: Optional[Path] = None, log: Optional[logging.Logger] = None):
        self.mode = str(cfg.get("mode", "DRY_RUN")).upper()
        if self.mode not in ALLOWED_MODES:
            raise SafetyError(f"mode {self.mode!r} is not allowed; only {ALLOWED_MODES} exist (live trading is not implemented)")
        if self.mode == "DRY_RUN":
            broker = None                                    # DRY_RUN ignores any broker object entirely: no reads, no writes
        self.cfg, self.broker, self.bars_fn, self.store, self.now_fn = cfg, broker, bars_fn, store, now_fn
        if self.mode == "PAPER" and not confirm_paper:
            raise SafetyError("PAPER mode requires the explicit --confirm-paper flag")
        if self.mode == "PAPER" and broker is None:
            raise SafetyError("PAPER mode needs a broker")
        if str(cfg.get("execution", {}).get("paper_base_url", PAPER_BASE_URL)).rstrip("/") != PAPER_BASE_URL:
            raise SafetyError("execution.paper_base_url must be the Alpaca PAPER endpoint")
        self.p = params_from_cfg(cfg)
        check_params_allowed(self.p, promotion_path or ROOT / "reports" / "triple_rsi" / "promotion.json")
        self.log = log or logging.getLogger("triple_rsi")
        self.run_id = uuid.uuid4().hex[:8]

    # -- helpers
    def _emit(self, event: str, **kw) -> None:
        row = {"ts": str(self.now_fn()), "run": self.run_id, "event": event, **kw}
        self.log.info(json.dumps(row, default=str))
        self.store.append("events", row)

    def _equity(self, closes: dict[str, float]) -> float:
        st = self.store.state
        unreal = sum(p["qty"] * (closes.get(s, p["entry_px"]) - p["entry_px"]) for s, p in st["positions"].items())
        return float(self.cfg["account"]["initial_equity"]) + st["realized_pnl"] + unreal

    # -- order lifecycle
    def sync_orders(self) -> None:
        """Pull the status of every non-terminal order we recorded; apply fills ONCE (delta since last applied), handle partial fills and rejections."""
        if self.broker is None:
            return
        st = self.store.state
        for cid, o in st["orders"].items():
            if o["status"] in TERMINAL or o["status"] == "dry_run":
                continue
            b = self.broker.get_order_by_client_id(cid)
            if b is None:
                continue
            o["status"], o["broker_id"] = str(b.get("status", o["status"])).lower(), b.get("id", o.get("broker_id"))
            filled = float(b.get("filled_qty") or 0)
            avg = float(b.get("filled_avg_price") or 0)
            delta = filled - o.get("applied_qty", 0.0)
            if delta > EPS and avg > 0:
                o["fill_date"] = str(b.get("filled_at") or self.now_fn())[:10]
                self._apply_fill(o, delta, avg)
                o["applied_qty"] = filled
                self.store.append("executions", {"ts": str(self.now_fn()), "client_order_id": cid, "symbol": o["symbol"], "side": o["side"], "qty": delta, "price": avg, "order_status": o["status"]})
            if o["status"] == "rejected":
                self._emit("order_rejected", client_order_id=cid, reason=b.get("reject_reason"))
        self.store.save()

    def _apply_fill(self, o: dict, qty: float, price: float) -> None:
        st = self.store.state
        pos = st["positions"].get(o["symbol"])
        if o["side"] == "buy":
            if pos:
                tot = pos["qty"] + qty
                pos["entry_px"] = (pos["entry_px"] * pos["qty"] + price * qty) / tot
                pos["qty"] = tot
            else:
                st["positions"][o["symbol"]] = {"qty": qty, "entry_px": price, "entry_date": o["fill_date"], "signal_date": o["signal_date"]}
        elif pos:
            sold = min(qty, pos["qty"])
            st["realized_pnl"] += (price - pos["entry_px"]) * sold
            pos["qty"] -= sold
            if pos["qty"] <= EPS:
                st["positions"].pop(o["symbol"])

    def reconcile(self) -> list[str]:
        """Compare strategy records with the broker. A shortfall halts NEW entries (never auto-trades to 'fix' it)."""
        problems = []
        if self.broker is None:
            return problems
        held = self.broker.get_positions()
        for s, p in self.store.state["positions"].items():
            if held.get(s, 0.0) + EPS < p["qty"]:
                problems.append(f"{s}: broker holds {held.get(s, 0.0)} but strategy recorded {p['qty']}")
        self.store.state["halt_entries"] = bool(problems)
        if problems:
            self._emit("reconcile_mismatch", problems=problems)
        return problems

    def cancel_stale_orders(self, latest_signal_date: str) -> None:
        """Cancel our still-open orders that belong to a signal day OLDER than the newest completed bar (a newer decision supersedes them)."""
        if self.broker is None:
            return
        for b in self.broker.get_open_orders():
            cid = str(b.get("client_order_id", ""))
            if cid.startswith("trsi-") and cid.rsplit("-", 1)[0][-10:] < latest_signal_date and b.get("id"):
                self.broker.cancel_order(b["id"])
                self._emit("stale_order_cancelled", client_order_id=cid)

    def _submit(self, sym: str, side: str, qty: float, signal_date: str, reason: str) -> dict:
        cid = f"trsi-{sym}-{signal_date}-{side}"
        st = self.store.state
        prev = st["orders"].get(cid)
        if prev is not None and not (self.mode == "PAPER" and prev["status"] == "dry_run"):     # a DRY_RUN record must never suppress a real PAPER order
            self._emit("duplicate_skipped", client_order_id=cid)
            return {"client_order_id": cid, "result": "duplicate_skipped"}
        rec = {"symbol": sym, "side": side, "qty": qty, "signal_date": signal_date, "expected_fill": "next regular-session open", "reason": reason,
               "status": "dry_run" if self.mode == "DRY_RUN" else "pending_submit", "applied_qty": 0.0}
        if self.mode == "DRY_RUN":                           # DRY_RUN: record the decision; the broker object is never touched
            st["orders"][cid] = rec
            self.store.append("orders", {"client_order_id": cid, **rec})
            self.store.save()
            return {"client_order_id": cid, "result": "dry_run"}
        existing = self.broker.get_order_by_client_id(cid)  # restart safety: an order that reached the broker before a crash is adopted, not re-sent
        if existing is None:
            st["orders"][cid] = rec                          # persisted BEFORE sending so a crash mid-send cannot lose track of it
            self.store.save()
            try:
                resp = self.broker.submit_order(sym, side, qty, cid)
            except Exception as e:
                self._emit("submit_error", client_order_id=cid, error=type(e).__name__)
                resp = self.broker.get_order_by_client_id(cid) or {"status": "unknown"}     # did it land despite the error?
        else:
            resp = existing
            self._emit("adopted_existing_order", client_order_id=cid)
        rec["status"] = str(resp.get("status", "unknown")).lower()
        rec["broker_id"] = resp.get("id")
        st["orders"][cid] = rec
        self.store.append("orders", {"client_order_id": cid, **rec})
        self.store.save()
        return {"client_order_id": cid, "result": rec["status"]}

    # -- main entry
    def run_once(self) -> dict:
        if not self.cfg.get("enabled", True):
            return {"skipped": "disabled"}
        now = self.now_fn()
        today = pd.Timestamp(now.date())
        report = {"run": self.run_id, "mode": self.mode, "decisions": [], "errors": []}
        if self.broker is not None:
            if self.broker.get_clock().get("is_open"):
                report["skipped"] = "market_open: decisions use completed bars only and orders must fill at the next open"
                self._emit("skipped_market_open")
                return report
            self.sync_orders()
            report["reconcile_problems"] = self.reconcile()
        st = self.store.state
        stale_days = int(self.cfg["execution"].get("stale_data_max_days", 4))
        frames, closes, prev_closes = {}, {}, {}
        for s in self.cfg.get("universe", ["SPY", "QQQ"]):
            try:
                raw = self.bars_fn(s)
                age = (today - raw.index[-1]).days
                if age > stale_days:
                    raise SafetyError(f"{s}: newest completed bar {raw.index[-1].date()} is {age} days old (limit {stale_days})")
                frames[s] = prepare({s: raw}, self.p)[s]
                closes[s], prev_closes[s] = float(frames[s]["close"].iloc[-1]), float(frames[s]["close"].iloc[-2])
            except Exception as e:
                report["errors"].append(f"{s}: {e}")
                self._emit("data_error", symbol=s, error=str(e))
        if self.broker is not None and frames:
            self.cancel_stale_orders(str(max(f.index[-1] for f in frames.values()).date()))
        eq = self._equity(closes)
        day_pnl = sum(p["qty"] * (closes[s] - prev_closes[s]) for s, p in st["positions"].items() if s in closes)
        blocked = daily_loss_breached(eq - day_pnl, eq, float(self.cfg["risk"]["daily_loss_pct"]))
        alloc = sum(p["qty"] * closes.get(s, p["entry_px"]) for s, p in st["positions"].items())
        r = self.cfg["risk"]
        for s, f in frames.items():
            row, t = f.iloc[-1], f.index[-1]
            sig_date = str(t.date())
            pos = st["positions"].get(s)
            pending = [o for o in st["orders"].values() if o["symbol"] == s and o["status"] not in TERMINAL and o["status"] != "dry_run"]
            decision = {"symbol": s, "signal_date": sig_date, "close": float(row["close"]), "rsi": [float(x) for x in f["rsi"].iloc[-4:]],
                        "sma": float(row["sma"]) if pd.notna(row["sma"]) else None,
                        "regime_above_sma": bool(row["close"] > row["sma"]) if pd.notna(row["sma"]) else None,
                        "entry_signal": bool(row["entry"]), "exit_signal": bool(row["exit"]), "holding": bool(pos), "action": "none", "reason": "no signal"}
            if pos:
                held = int(((f.index >= pd.Timestamp(pos["entry_date"])) & (f.index <= t)).sum())
                why = "rsi_cross" if row["exit"] else ("time_stop" if self.p.max_hold and held >= self.p.max_hold else None)
                if why and not pending:
                    decision.update(action="sell", reason=why, qty=pos["qty"], **self._submit(s, "sell", pos["qty"], sig_date, why))
            elif row["entry"] and not pending:
                if st.get("halt_entries"):
                    decision.update(action="blocked", reason="reconcile mismatch: entries halted")
                elif blocked:
                    decision.update(action="blocked", reason="daily loss limit")
                else:
                    a = float(row["atr"])
                    sz = size_position(SizingInputs(equity=eq, price=float(row["close"]), atr=a if pd.notna(a) else None, atr_stop_mult=self.p.atr_stop_mult,
                                                    max_alloc_pct=r["max_alloc_pct"], max_combined_pct=r["max_combined_pct"], risk_pct=r["risk_pct"], existing_alloc=alloc,
                                                    slippage_pct=r["slippage_bps"] / 1e4, gap_buffer_pct=r["gap_buffer_pct"], fractional=self.cfg["account"].get("fractional", True)))
                    if sz.qty <= 0:
                        decision.update(action="blocked", reason=sz.reason)
                    else:
                        alloc += sz.notional
                        decision.update(action="buy", reason="triple_rsi_entry", qty=sz.qty, notional=sz.notional,
                                        expected_risk_note="baseline has no stop: loss is not capped (see docs)", **self._submit(s, "buy", sz.qty, sig_date, "triple_rsi_entry"))
            self.store.append("signals", decision)
            report["decisions"].append(decision)
        self.store.save()
        return report


# -------------------------------------------------------------------------------------------------- CLI

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config" / "triple_rsi.yaml"))
    ap.add_argument("--mode", choices=list(ALLOWED_MODES), help="overrides config mode (DRY_RUN or PAPER only)")
    ap.add_argument("--confirm-paper", action="store_true", help="required to submit orders to the Alpaca PAPER endpoint")
    ap.add_argument("--once", action="store_true", required=True, help="evaluate once after the daily close and exit (schedule this externally)")
    a = ap.parse_args(argv)
    cfg = load_config(Path(a.config))
    if a.mode:
        cfg["mode"] = a.mode
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    (ROOT / cfg["execution"]["log_dir"]).mkdir(parents=True, exist_ok=True)
    broker = AlpacaPaperBroker(retries=int(cfg["execution"].get("max_retries", 3))) if str(cfg.get("mode")).upper() == "PAPER" else None
    source = cfg["backtest"].get("data_source", "auto")
    ex = TripleRSIExecutor(cfg, broker, lambda s: load_daily(s, "2015-01-01", source, refresh=True)[0], Store(ROOT / cfg["execution"]["state_dir"]), confirm_paper=a.confirm_paper)
    print(json.dumps(ex.run_once(), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
