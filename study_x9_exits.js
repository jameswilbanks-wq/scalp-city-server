/* Study 22 (read-only): X9 exit/profit-taking variants on real same-day option prices, SPY and QQQ,
   past year, on the 5-minute candle frame that's now live (bt12 already showed 5-minute beating
   1-minute for this signal; this study only varies what happens AFTER entry, on top of that same
   frame and signal).

   James noticed (2026-11-13) that a live X9 position was sitting at about +$90 unrealized and not
   selling -- correct, by design: the live exit logic (x9Manage in server.js) has NO profit target at
   all, only a trend-reversal exit (candle closes back through EMA9, or an opposite cross), a -30%
   premium stop, and end-of-day. A big unrealized gain just rides until the signal itself reverses,
   which can give most or all of it back first (the same whipsaw mechanism already identified when
   X9's win rate was diagnosed earlier).

   Variants tested here, all on top of the same entry signal, same -30% stop, same flat-by-close:
   - 'baseline': current live behavior, no take-profit at all (exit only on level/reverse/stop/eod)
   - 'tp50' .. 'tp100': a fixed take-profit at +50/60/70/80/90/100% of the entry premium
   - 'trail': a trailing stop on the premium -- once the unrealized gain reaches +25% of entry premium
     it arms, then exits if the gain falls back to 50% of its peak (e.g. peaks at +60%, exits at +30%)
     -- same "let it run but protect the peak" idea the sweep book already uses, just tuned for X9's
     shorter-lived 5-minute signal.

   Same scaffolding as bt12 (study_x9.js): Robinhood 1-minute equity bars aggregated to 5-minute
   candles, Engine.simulate for EMA9/VWAP, Engine.x9Signals for entries, real 1-minute OPTION prices
   walked minute-by-minute from entry to the rule's exit time applying whichever premium rule is
   being tested. $0.01/fill slippage each way ($2/contract round trip). Split: first 2/3 of sessions
   = train, last 1/3 = lock. Saved to kv opts.key (default 'bt22'). */
module.exports = async function studyX9Exits(ap, rh, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const days = opts.days || 365, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best) }; }); };
  const save = async () => { fin(); try { await kset(opts.key || 'bt22', out); } catch (e) {} };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    for (let i = 0; i < syms.length; i += 90) {
      do {
        const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
        Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
        pt = d.next_page_token; await sleep(gap);
      } while (pt);
    }
    return m;
  };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const agg5 = raw => { const out = [], by = {}; raw.forEach(x => { const t = Date.parse(x.begins_at), k = Math.floor(t / 300000) * 300000; (by[k] = by[k] || []).push(x); }); Object.keys(by).sort((a, b) => a - b).forEach(k => { const g = by[k]; out.push({ begins_at: iso(+k), open_price: g[0].open_price, high_price: Math.max(...g.map(x => +x.high_price)), low_price: Math.min(...g.map(x => +x.low_price)), close_price: g[g.length - 1].close_price, volume: g.reduce((s, x) => s + (+x.volume || 0), 0) }); }); return out; };
  const TP_LEVELS = opts.tpLevels || [50, 60, 70, 80, 90, 100];
  const STOP_PCT = opts.stopPct === undefined ? 30 : opts.stopPct;
  const TRAIL = opts.trail || { arm: 25, give: 0.5 };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await save();
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
        const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
        (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
      }
      const raw = Object.keys(st).sort((a, b) => a - b).map(k => st[k]);
      const bars = Engine.prepare(agg5(raw), { partial: true });
      Engine.simulate(bars, {}, true);
      if (bars.length < 200) { out.n[SYM] = 'too few bars'; continue; }
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
      const step = 300000, list = []; let busyUntil = -1;
      Engine.x9Signals(bars, 585, 930).forEach(g => {
        const k = g.k, b = bars[k], e = bars[k + 1]; if (!e || e.day !== b.day || b.t < busyUntil) return;
        let xt = null, why = 'time';
        for (let q = k + 1; q < bars.length && bars[q].day === b.day; q++) { const x = bars[q]; if (x.min >= 930) { xt = x.t; break; } if (Engine.x9Exit(x, g.sig.dir)) { xt = x.t + step; why = 'level'; break; } const o = Engine.x9At(bars, q); if (o && o.dir === -g.sig.dir) { xt = x.t + step; why = 'reverse'; break; } }
        if (xt === null) xt = bars[bars.length - 1].t;
        busyUntil = xt; list.push({ day: b.day, dir: g.sig.dir, tIn: e.t, xt, why, s: SYM + ymdOf(b.day) + (g.sig.dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') });
      });
      out.n[SYM] = { sessions: dayList.length, signals: list.length };
      const byDay = {}; list.forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        try {
          const todays = byDay[D], first = Math.min(...todays.map(p => p.tIn));
          const ob = await optBars([...new Set(todays.map(p => p.s))], first - 60000, Date.parse(D + 'T21:05:00Z'));
          todays.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip(SYM + ' no option price'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.tIn + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip(SYM + ' no usable entry price'); return; }
            const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
            const rec = (name, pout, why) => { if (pout === null) { skip(SYM + ' no exit price'); return; } const pnl = (pout - pin) * 100 - 2; acc(SYM + '|' + name + '|' + split[D], pnl); acc(SYM + '|' + name + '|ALL', pnl); };
            // walk the option price minute by minute up to the rule exit, applying whichever profit-taking rule is under test
            const run = (tpPct, trail) => {
              let peakPct = -Infinity;
              for (let t = tFill + 60000; t < p.xt; t += 60000) {
                const v = pxAt(arr, t, 2); if (v === null) continue;
                const pct = (v / pin - 1) * 100;
                if (STOP_PCT !== null && pct <= -STOP_PCT) return { pout: v, why: 'premium stop' };
                if (tpPct !== null && pct >= tpPct) return { pout: v, why: 'target' };
                if (trail) {
                  if (pct > peakPct) peakPct = pct;
                  if (peakPct >= trail.arm && pct <= peakPct * (1 - trail.give)) return { pout: v, why: 'trail' };
                }
              }
              return { pout: sellAt(p.xt), why: p.why };
            };
            let r = run(null, null); rec('baseline', r.pout, r.why);
            TP_LEVELS.forEach(tp => { const r2 = run(tp, null); rec('tp' + tp, r2.pout, r2.why); });
            const r3 = run(null, TRAIL); rec('trail', r3.pout, r3.why);
            acc(SYM + '|cost', pin * 100);
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + Object.keys(byDay).length + ' days'; await save(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
