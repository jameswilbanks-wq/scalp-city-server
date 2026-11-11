/* Study 10 (read-only): James's profit-lock idea on REAL same-day option prices, SPY and QQQ, past year.
   Buy the at-the-money same-day option on each sweep signal and on each EMA-cross signal (EMA filter applied), as the live bot does.
   Exits measured on the OPTION price (percent of the entry price), checked every minute:
     lock40_35_25 = take profit at +40%; once +35% has been reached, exit if it falls back to +25%  (James's rule)
     lock30_25_15, lock50_40_30 = the same shape with other numbers (neighbors)
     floor35_25   = no take-profit; once +35% is reached, exit at +25%
   Downside while unarmed: the live stops (sweep: wick stop on the underlying; EMA: 1 ATR stop and a close back through the EMA), plus a -50% premium stop and out at 15:30 ET.
   Baselines: sweep 'run' (live: wick stop + 1R underlying trail); EMA 'live' (+$25 / -$20 per contract, 15-minute time stop, ATR stop, level exit).
   'run+lock40_35_25' = the live sweep trail with James's lock added on top.
   $0.01 per fill assumed each way. Split: first 2/3 of sessions = train, last 1/3 = lock. Saved to kv 'bt10'. */
module.exports = async function studyLock(ap, rh, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const days = opts.days || 365, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best) }; }); };
  const save = async () => { fin(); try { await kset('bt10', out); } catch (e) {} };
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
  const LOCKS = { lock40_35_25: [40, 35, 25], lock30_25_15: [30, 25, 15], lock50_40_30: [50, 40, 30], floor35_25: [null, 35, 25] };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await save();
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
        const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
        (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
      }
      const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[SYM] = 'too few bars'; continue; }
      Engine.simulate(bars, {}, true);
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
      const sigs = Engine.signals(bars, { vwap: false, orb: false }).filter(g => bars[g.k + 1] && bars[g.k + 1].day === bars[g.k].day).filter(g => {
        if (g.sig.trig === 'sweep') return g.sig.stopPx !== undefined && g.sig.stopPx !== null;
        if (g.sig.trig !== 'ema') return false;
        const b = bars[g.k], pk = bars[g.k - 5] || bars[g.k - 1]; return !(g.sig.dir * (b.e50 - pk.e50) > 0 && g.sig.dir * (b.c - b.vwap) > 0); // EMA filter
      });
      out.n[SYM] = { sessions: dayList.length, sweep: sigs.filter(g => g.sig.trig === 'sweep').length, ema: sigs.filter(g => g.sig.trig === 'ema').length };
      const byDay = {}; sigs.forEach(g => { (byDay[bars[g.k].day] = byDay[bars[g.k].day] || []).push(g); });
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        try {
          const plan = byDay[D].map(g => { const k = g.k, e = bars[k + 1], dir = g.sig.dir, b = bars[k]; const stopPx = g.sig.trig === 'sweep' ? g.sig.stopPx : e.o - dir * Math.max(b.atr || 0, 0.05); const R = Math.abs(e.o - stopPx); if (!(R > 0.0001 * e.o)) return null; return { k, e, dir, R, stopPx, trig: g.sig.trig, s: SYM + ymdOf(D) + (dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') }; }).filter(Boolean);
          if (!plan.length) continue;
          const ob = await optBars([...new Set(plan.map(p => p.s))], bars[plan[0].k + 1].t - 60000, Date.parse(D + 'T21:05:00Z'));
          plan.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip(SYM + ' no option price'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.e.t && b.t <= p.e.t + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.e.t + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip(SYM + ' no usable entry price'); return; }
            const lastT = (() => { for (let q = p.k + 1; q < bars.length && bars[q].day === D; q++) if (bars[q].min >= 930) return bars[q].t; return bars[bars.length - 1].t; })();
            const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
            // minute-by-minute simulation. mode: {trail:bool, lock:[tp,arm,floor]|null, dollar:bool (EMA live), level:bool}
            const sim = mode => {
              let stop = p.stopPx, hi = p.e.o, peakPct = -Infinity, armed = false;
              for (let q = p.k + 1; q < bars.length && bars[q].day === D; q++) {
                const x = bars[q], tq = x.t + 60000; if (x.min >= 930) return lastT;
                if (p.dir > 0 ? x.l <= stop : x.h >= stop) return tq;
                if (mode.level && x.t > p.e.t && (p.dir > 0 ? x.c < x.e50 : x.c > x.e50)) return tq;
                if (mode.trail) { hi = p.dir > 0 ? Math.max(hi, x.h) : Math.min(hi, x.l); const ns = hi - p.dir * p.R; if (p.dir * (ns - stop) > 0) stop = ns; if (p.dir * (x.c - stop) < 0) return tq; }
                const op = pxAt(arr, tq, 2); if (op === null) continue;
                const pct = (op / pin - 1) * 100, gain = (op - pin) * 100; peakPct = Math.max(peakPct, pct);
                if (pct <= -50) return tq;
                if (mode.dollar) { if (gain >= 25 || gain <= -20 || tq - tFill >= 15 * 60000) return tq; }
                if (mode.lock) { const [tp, arm, fl] = mode.lock; if (tp !== null && pct >= tp) return tq; if (peakPct >= arm) armed = true; if (armed && pct <= fl) return tq; }
              }
              return lastT;
            };
            const rec = (name, t) => { const pout = sellAt(t); if (pout === null) { skip(SYM + ' no exit price'); return; } const pnl = (pout - pin) * 100 - 2; acc(SYM + '|' + p.trig + '|' + name + '|' + split[D], pnl); acc(SYM + '|' + p.trig + '|' + name + '|ALL', pnl); };
            if (p.trig === 'sweep') { rec('run', sim({ trail: true })); rec('run+lock40_35_25', sim({ trail: true, lock: LOCKS.lock40_35_25 })); }
            else rec('live', sim({ dollar: true, level: true }));
            Object.keys(LOCKS).forEach(nm => rec(nm, sim({ lock: LOCKS[nm], level: p.trig === 'ema' })));
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + Object.keys(byDay).length + ' signal days'; await save(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
