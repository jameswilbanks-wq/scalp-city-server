/* Study 19 (read-only): the CLASSIC monthly wheel cycle (James asked to test this 2026-11-13 after the daily 1-DTE
   version, bt18, lost money at every OTM distance tested on AMZN) -- sell a covered call ~30-45 DTE out, 2% or 5%
   OTM, close early at 50% of max profit (cost-to-close <= 50% of credit received) or at 21 days to expiration if
   the profit target hasn't hit yet, otherwise hold to expiration (assigned if ITM at expiry, worthless if OTM);
   the moment one cycle closes, the next cycle opens the following session (approximating "buy shares back
   immediately and sell another call"). This is the textbook wheel cadence most real-world income-strategy claims
   are actually built on -- bt18 tested a daily cycle instead, which gives almost no time premium relative to
   gap/slippage risk, a likely structural reason it lost money regardless of strike distance.

   Underlyings: AMZN (what Wheel2 is funded for), plus SPY and QQQ side by side -- James wanted to see whether the
   underlying itself, not just the cadence, was part of why the daily version lost (AMZN trended hard and gapped
   often over the test window; SPY/QQQ are typically calmer, which should, in theory, suit short-premium selling
   better). OTM levels: 2% and 5%, spanning the "2-5% OTM" range from the original approved rule.

   Expiration picked as the standard 3rd-Friday monthly listed date landing 28-49 days from entry (closest to ~37
   days, the midpoint of 30-45 DTE) -- approximate, no real historical options-chain listing lookup available,
   same caveat as every strike/expiry approximation elsewhere in this codebase.

   Mechanics per cycle: probe a grid of real candidate strikes (same batched-request, pick-whichever-has-data
   approach as bt18) around the OTM target for that one expiration, using DAILY option bars -- a month-long hold
   only needs one price check per day, so daily bars give the same decision quality at a small fraction of the
   data/requests a minute-bar pull would cost (one request per cycle, not per day). Same $1/contract/fill ($2
   round trip) slippage convention as the rest of this codebase.

   Honest limitation: only ~8 months of real per-symbol option history exists on this feed (same ceiling bt18 hit),
   so a monthly cadence only produces a handful of cycles per symbol/OTM level here (roughly 6-8) -- too few on
   their own for a confident verdict, but a fair like-for-like comparison against bt18's much larger (and also
   losing) daily-cycle sample. Saved to kv opts.key (default 'bt19'). */
module.exports = async function studyWheelMonthly(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const SYMS = opts.syms || ['AMZN', 'SPY', 'QQQ'], OTM_LEVELS = opts.otmLevels || [0.02, 0.05], KEY = opts.key || 'bt19';
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
  const strikeGrid = (open, otm) => {
    const lo = open, hi = open * (1 + otm + 0.02), set = new Set();
    [1, 2.5, 5].forEach(inc => { for (let s = Math.floor(lo / inc) * inc; s <= hi; s += inc) { if (s > 0) set.add(Math.round(s * 100) / 100); } });
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
            const symOf = s => SYM + ymdOf(expiry) + 'C' + String(Math.round(s * 1000)).padStart(8, '0');
            const target = D.o * (1 + otm);
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
              assigned = uClose.c > strike; exitPrice = Math.max(uClose.c - strike, 0); exitDay = uClose.day;
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
