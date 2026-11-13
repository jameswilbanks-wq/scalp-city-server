/* Study 20 (read-only): classic monthly CASH-SECURED PUT selling, on real historical option prices
   (James asked 2026-11-13, after bt18/bt19 showed covered-call selling losing money on AMZN/SPY/QQQ
   at every OTM distance and cadence tested, because all three underlyings spent the test window in
   a persistent uptrend -- a short CALL caps your upside exactly when the stock keeps running, which
   is the losing mechanism in both prior studies. A short PUT instead gets paid to agree to buy the
   dip: in an uptrend that put mostly just expires worthless (pure premium), and even when assigned
   you're buying stock cheaper than where it was trending from, not capping a winner -- the same
   uptrend that sank covered calls should, in theory, suit cash-secured puts far better).

   Rule tested: sell 1 put/cycle, 30-45 DTE (closest to ~37), struck 2% or 5% OTM below the session's
   open at entry. Close early at 50% of max profit (cost-to-close <= 50% of credit) or at 21 days to
   expiration if the target hasn't hit, otherwise hold to expiration -- assigned (buy 100 shares at
   strike) if the underlying closes below strike at expiry, worthless if it closes above. The moment
   one cycle closes, the next cycle opens the next session (approximating "get assigned or expire,
   then immediately sell another put" -- the textbook CSP wheel entry side, mirroring bt19's covered-
   call exit side exactly so the two studies are a fair apples-to-apples comparison).

   Underlyings: AMZN, SPY, QQQ -- the exact same three, same ~8-month lookback window, same OTM
   levels (2%/5%) as bt19, so a side-by-side comparison isolates "calls vs puts" as the only variable
   changed. Mechanics: same real-strike-grid probing and DAILY option bars as bt19 (one request per
   cycle, not per day -- a month-long hold only needs a daily price check). Same $1/contract/fill
   ($2 round trip) slippage convention as the rest of this codebase. P&L here only prices the short
   PUT premium leg, not what happens to the stock after an assignment (same scope restriction bt18/
   bt19 used for the call leg) -- if assigned, the "stock P&L" starts fresh at the strike price from
   that day forward, which is a separate, later question (what to do with the shares) not modeled here.

   Honest limitation: same ~8-month real per-symbol option-history ceiling as bt18/bt19, so each
   symbol/OTM level only produces a handful of cycles (~6-9) -- a fair comparison against bt19's
   same-sized call-selling sample, not a large-sample verdict on its own. Saved to kv opts.key
   (default 'bt20'). */
module.exports = async function studyWheelCsp(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const SYMS = opts.syms || ['AMZN', 'SPY', 'QQQ'], OTM_LEVELS = opts.otmLevels || [0.02, 0.05], KEY = opts.key || 'bt20';
  const days = opts.days || 260, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {}, cycles: [] }, M = {};
  const acc = (key, pnl, assigned, heldDays) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, assigned: 0, heldSum: 0 }; c.n++; c.net += pnl; c.heldSum += heldDays; if (assigned) c.assigned++; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => {
    const r2 = x => Math.round(x * 100) / 100; out.res = {};
    Object.keys(M).sort().forEach(k => {
      const c = M[k], avgHeld = c.heldSum / c.n;
      out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgPerCycle: r2(c.net / c.n), net: r2(c.net), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), assignedPct: Math.round(100 * c.assigned / c.n), avgDaysHeld: Math.round(avgHeld), impliedMonthly: r2(c.net / c.n / avgHeld * 30) };
    });
  };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const thirdFriday = (y, m) => { const first = new Date(Date.UTC(y, m - 1, 1)), dow = first.getUTCDay(), fri = 1 + ((5 - dow + 7) % 7); return new Date(Date.UTC(y, m - 1, fri + 14)); };
  const pickExpiry = entryDate => { // 3rd-Friday date 28-49 days from entry, closest to 37
    const e = new Date(entryDate + 'T00:00:00Z'), cands = [];
    for (let dm = 0; dm <= 2; dm++) { const d0 = new Date(e); d0.setUTCMonth(d0.getUTCMonth() + dm); const tf = thirdFriday(d0.getUTCFullYear(), d0.getUTCMonth() + 1); const diff = Math.round((tf - e) / 864e5); if (diff >= 28 && diff <= 49) cands.push({ tf, diff }); }
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs(a.diff - 37) - Math.abs(b.diff - 37));
    return cands[0].tf.toISOString().slice(0, 10);
  };
  const optBarsDailyMulti = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Day', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ day: b.t.slice(0, 10), t: Date.parse(b.t), c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    Object.values(m).forEach(a => a.sort((x, y) => x.t - y.t));
    return m;
  };
  // put strikes sit AT/BELOW the entry open (0% to -(otm+2%)), mirroring bt19's call grid which sat
  // AT/ABOVE open -- otherwise identical real-strike-probing approach.
  const strikeGrid = (open, otm) => {
    const hi = open, lo = open * (1 - otm - 0.02), set = new Set();
    [1, 2.5, 5].forEach(inc => { for (let s = Math.ceil(lo / inc) * inc; s <= hi; s += inc) { if (s > 0) set.add(Math.round(s * 100) / 100); } });
    return [...set];
  };
  for (const SYM of SYMS) {
    try {
      out.progress = SYM + ': loading daily bars'; await save();
      const bars = [];
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Day', start: iso(now - days * 864e5), end: iso(now - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'raw' });
      (d.bars || []).forEach(b => bars.push({ day: b.t.slice(0, 10), t: Date.parse(b.t), o: b.o, c: b.c }));
      out.n[SYM] = { sessions: bars.length };
      if (bars.length < 10) continue;
      for (const otm of OTM_LEVELS) {
        let i = 0, loopGuard = 0;
        while (i < bars.length - 1 && loopGuard++ < 500) {
          const D = bars[i];
          const expiry = pickExpiry(D.day);
          if (!expiry) { i++; continue; } // not enough runway left in the data window for a fresh 30-45 DTE cycle
          try {
            const grid = strikeGrid(D.o, otm);
            const symOf = s => SYM + ymdOf(expiry) + 'P' + String(Math.round(s * 1000)).padStart(8, '0');
            const target = D.o * (1 - otm);
            const windowEnd = Date.parse(expiry + 'T21:05:00Z');
            const byS = await optBarsDailyMulti(grid.map(symOf), D.t, windowEnd);
            const sortedGrid = [...grid].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
            let strike = null, arr = null;
            for (const s of sortedGrid) { const a = byS[symOf(s)]; if (a && a.length >= 3 && a[0].c >= 0.02) { strike = s; arr = a; break; } }
            if (!strike) { skip(SYM + ' otm' + Math.round(otm * 100) + ' no real strike with usable data'); i++; continue; }
            const pin = arr[0].c; // entry credit = first available daily close on/after entry
            const dte21Cutoff = windowEnd - 21 * 864e5;
            let exitRow = null, why = null;
            for (const row of arr) {
              if (row.t <= arr[0].t) continue; // skip the entry print itself
              if (row.c <= pin * 0.5) { exitRow = row; why = 'profit50'; break; }
              if (row.t >= dte21Cutoff) { exitRow = row; why = 'dte21'; break; }
            }
            let exitDay, exitPrice, assigned = false;
            if (exitRow) { exitDay = exitRow.day; exitPrice = exitRow.c; }
            else {
              const uClose = bars.find(b => b.day >= expiry) || bars[bars.length - 1]; // held to expiration: judge assignment off the underlying
              assigned = uClose.c < strike; exitPrice = Math.max(strike - uClose.c, 0); exitDay = uClose.day;
            }
            const pnl = (pin - exitPrice) * 100 - 2;
            const heldDays = Math.max(1, Math.round((Date.parse(exitDay) - D.t) / 864e5));
            const lvl = 'otm' + Math.round(otm * 100);
            acc(SYM + '|' + lvl, pnl, assigned, heldDays);
            out.cycles.push({ sym: SYM, lvl, entry: D.day, exit: exitDay, strike, credit: Math.round(pin * 100) / 100, pnl: Math.round(pnl * 100) / 100, assigned, why: why || (assigned ? 'assigned' : 'expired-otm'), heldDays });
            const ni = bars.findIndex(b => b.day > exitDay); // next cycle starts the session after this one closes
            i = ni === -1 ? bars.length : ni;
          } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D.day + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); i++; }
          await save();
        }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
