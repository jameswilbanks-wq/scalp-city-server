/* Study 8 (read-only): the SWEEP entry on REAL option prices, by symbol.
   Symbols: SPY, QQQ (same-day expiry) and PLTR, NVDA, TSLA (nearest Friday expiry; same-day only on Fridays).
   Signal: Engine sweepSignal on 1-minute bars (same as live). Buy the at-the-money call/put at the next minute.
   Exits (decided on the underlying unless noted, option sold at the last trade price at that time):
     run   = wick stop, then a trail one stop-distance behind the best price (the live rule)
     tgt2R = wick stop, 2x target
     t10   = out after 10 minutes
     prem  = option-based: +$25 or -$20 per contract, or 15 minutes (the old live rule)
   All out by 15:30 ET. Slippage per fill: $0.01 ETFs, $0.03 single stocks. Split: first 2/3 of sessions = train, last 1/3 = lock.
   Saved to kv 'bt8' with progress. */
module.exports = async function studySweep(ap, rh, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const days = opts.days || 365, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), days, progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst) }; }); };
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
  const nextFri = d => { const t = new Date(d + 'T12:00:00Z'); const add = (5 - t.getUTCDay() + 7) % 7; t.setUTCDate(t.getUTCDate() + add); return t.toISOString().slice(0, 10); };
  for (const SYM of (opts.syms || ['SPY', 'QQQ', 'PLTR', 'NVDA', 'TSLA'])) {
    const etf = SYM === 'SPY' || SYM === 'QQQ', SLIP = etf ? 1 : 3;
    try {
      out.progress = SYM + ' loading 1-minute bars'; try { await kset('bt8', out); } catch (e) {}
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
        const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
        (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
      }
      const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[SYM] = 'too few bars: ' + bars.length; continue; }
      Engine.simulate(bars, {}, true); // fills indicators
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
      const sigs = Engine.signals(bars, { vwap: false, orb: false, ema: false }).filter(g => g.sig.trig === 'sweep' && g.sig.stopPx !== undefined && g.sig.stopPx !== null && bars[g.k + 1] && bars[g.k + 1].day === bars[g.k].day);
      out.n[SYM] = { bars: bars.length, sessions: dayList.length, signals: sigs.length, lockFrom: dayList[Math.ceil(dayList.length * 2 / 3)] };
      const byDay = {}; sigs.forEach(g => { (byDay[bars[g.k].day] = byDay[bars[g.k].day] || []).push(g); });
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        try {
          const exp = etf ? D : nextFri(D), isZero = exp === D, tag = etf ? '' : (isZero ? '|fri0dte' : '|notExpiryDay');
          const plan = byDay[D].map(g => {
            const k = g.k, e = bars[k + 1], dir = g.sig.dir, R = Math.abs(e.o - g.sig.stopPx); if (!(R > 0.0001 * e.o)) return null;
            const ks = etf ? [Math.round(e.o)] : [...new Set([Math.round(e.o), Math.round(e.o / 2.5) * 2.5, Math.round(e.o / 5) * 5])];
            return { k, e, dir, R, cands: ks.map(x => ({ k: x, s: SYM + ymdOf(exp) + (dir > 0 ? 'C' : 'P') + String(Math.round(x * 1000)).padStart(8, '0') })) };
          }).filter(Boolean);
          if (!plan.length) continue;
          const first = bars[plan[0].k + 1].t, dayEnd = Date.parse(D + 'T21:05:00Z');
          const ob = await optBars([...new Set(plan.flatMap(p => p.cands.map(c => c.s)))], first - 60000, dayEnd);
          plan.forEach(p => {
            const tIn = p.e.t; let best = null;
            p.cands.sort((a, b) => Math.abs(a.k - p.e.o) - Math.abs(b.k - p.e.o)).forEach(c => { if (best) return; const arr = ob[c.s]; if (!arr) return; for (const b of arr) { if (b.t >= tIn && b.t <= tIn + 3 * 60000) { best = { arr, pin: b.o, tFill: b.t }; break; } if (b.t > tIn + 3 * 60000) break; } });
            if (!best) { skip(SYM + ' no option price at entry'); return; }
            if (!(best.pin >= 0.05)) { skip(SYM + ' option under 5 cents'); return; }
            const exitT = {};
            // underlying-driven exits
            const walk = mode => { let stop = p.e.o - p.dir * p.R, hi = p.e.o; for (let q = p.k + 1; q < bars.length && bars[q].day === D; q++) { const x = bars[q]; if (x.min >= 930) return x.t; if (p.dir > 0 ? x.l <= stop : x.h >= stop) return x.t + 60000; if (mode === 'tgt2R' && (p.dir > 0 ? x.h >= p.e.o + 2 * p.R : x.l <= p.e.o - 2 * p.R)) return x.t + 60000; if (mode === 'run') { hi = p.dir > 0 ? Math.max(hi, x.h) : Math.min(hi, x.l); const ns = hi - p.dir * p.R; if (p.dir * (ns - stop) > 0) stop = ns; if (p.dir * (x.c - stop) < 0) return x.t + 60000; } if (mode === 't10' && q - p.k >= 10) return x.t + 60000; } return bars[p.k + 1].t + 60000; };
            exitT.run = walk('run'); exitT.tgt2R = walk('tgt2R'); exitT.t10 = walk('t10');
            const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(best.arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(best.arr, t, 30); };
            const rec = (name, pout) => { if (pout === null) { skip(SYM + ' no option price at exit'); return; } const pnl = (pout - best.pin) * 100 - 2 * SLIP; acc(SYM + '|' + name + '|ALL', pnl); acc(SYM + '|' + name + '|' + split[D], pnl); acc(SYM + '|' + name + '|' + (p.dir > 0 ? 'call' : 'put'), pnl); if (tag) acc(SYM + '|' + name + tag, pnl); };
            ['run', 'tgt2R', 't10'].forEach(n => rec(n, sellAt(exitT[n])));
            let pp = null; for (const b of best.arr) { if (b.t < best.tFill) continue; const g = (b.c - best.pin) * 100; pp = b.c; if (g >= 25 || g <= -20 || b.t - best.tFill >= 15 * 60000) break; }
            rec('prem', pp);
            acc(SYM + '|cost', best.pin * 100);
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++;
        if (done % 40 === 0) { out.progress = SYM + ' ' + done + ' signal days done (' + D + ')'; fin(); try { await kset('bt8', out); } catch (e) {} }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
