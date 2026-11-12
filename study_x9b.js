/* Study 15 (read-only): the EMA9 x VWAP reel again (2nd @austin.daytrades reel, shared 2026-11-12): "3-minute chart for direction, 1-minute chart to fine-tune entries".
   REAL same-day option prices, SPY and QQQ, Mar 2024 - now. VWAP on (O+H+L+C)/4 as in the live X9 book.
   Variants (all: ATM same-day call/put at the next 1-minute open, -30% premium stop, out 15:30 ET, one position per symbol at a time, $0.01 per fill each way):
     '1min'        = the live X9 book: every 1-minute EMA9 x VWAP cross; exit on a 1-minute close back through EMA9, an opposite cross, -30%, or 15:30.
     '1min+3mSide' = same, but only take the cross if on the last COMPLETED 3-minute candle EMA9 is on the same side of VWAP (3-minute direction filter).
     '1min+3mSlope'= same, plus the 3-minute EMA9 must be rising (calls) / falling (puts) versus the previous 3-minute candle.
     '1min+3mWait' = after a 1-minute cross, wait up to 6 minutes for the 3-minute EMA9 to be on the same side of VWAP, then enter (1-minute exits).
     '3min'        = the cross and the exits on 3-minute candles only.
     '1min+3mExit' = the 3mSide filter, but exit on a 3-minute close back through the 3-minute EMA9 (direction chart manages the trade).
   Split: train before 2026-01-01, lock 2026 onward. Saved to kv 'bt15'. */
module.exports = async function studyX9b(ap, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const KEY = opts.key || 'bt15', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best) }; }); };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    for (let i = 0; i < syms.length; i += 90) {
      do {
        const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
        Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
        pt = d.next_page_token; await sleep(gap);
      } while (pt);
      pt = undefined;
    }
    return m;
  };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const agg = (raw, ms) => { const o = [], by = {}; raw.forEach(x => { const k = Math.floor(Date.parse(x.begins_at) / ms) * ms; (by[k] = by[k] || []).push(x); }); Object.keys(by).sort((a, b) => a - b).forEach(k => { const g = by[k]; o.push({ begins_at: iso(+k), open_price: g[0].open_price, high_price: Math.max(...g.map(x => +x.high_price)), low_price: Math.min(...g.map(x => +x.low_price)), close_price: g[g.length - 1].close_price, volume: g.reduce((s, x) => s + (+x.volume || 0), 0) }); }); return o; };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await save();
      const raw = []; let tok;
      do {
        const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: opts.feed || 'sip', limit: 10000, adjustment: 'split', page_token: tok });
        (d.bars || []).forEach(b => raw.push({ begins_at: b.t, open_price: b.o, high_price: b.h, low_price: b.l, close_price: b.c, volume: b.v }));
        tok = d.next_page_token; await sleep(gap);
      } while (tok);
      const b1 = Engine.prepare(raw), keep = {}; b1.forEach(b => { keep[b.day] = 1; });
      const b3 = Engine.prepare(agg(raw, 180000), { partial: true }).filter(b => keep[b.day]);
      Engine.simulate(b1, {}, true); Engine.simulate(b3, {}, true);
      if (b1.length < 1000) { out.n[SYM] = 'too few bars'; continue; }
      // last COMPLETED 3-minute candle at time T (a candle beginning at t is complete at t + 3 min)
      const last3 = T => { let lo = 0, hi = b3.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (b3[mid].t + 180000 <= T) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a; };
      const dayList = []; b1.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      const plans = { '1min': [], '1min+3mSide': [], '1min+3mSlope': [], '1min+3mWait': [], '3min': [], '1min+3mExit': [] };
      // 1-minute entry variants
      const sig1 = Engine.x9Signals(b1, 585, 930);
      const run1 = (name, filt, exit3) => {
        let busy = -1;
        sig1.forEach(g => {
          let k = g.k, b = b1[k], e = b1[k + 1]; const dir = g.sig.dir; if (!e || e.day !== b.day || b.t < busy) return;
          if (filt === 'wait') { // wait up to 6 minutes for the last completed 3-minute candle to agree, while the 1-minute EMA9 stays on the trade's side of VWAP
            let q = k, ok = false;
            for (; q <= g.k + 6 && b1[q + 1] && b1[q + 1].day === b.day && b1[q].min <= 930; q++) { const x = b1[q]; if (!(dir * (x.e9 - x.vwap4) > 0)) break; const jj = last3(x.t + 60000), cc = jj >= 0 ? b3[jj] : null; if (cc && cc.day === b.day && dir * (cc.e9 - cc.vwap4) > 0) { ok = true; break; } }
            if (!ok) return; k = q; b = b1[k]; e = b1[k + 1];
          }
          const j = last3(b.t + 60000), c3 = j >= 0 ? b3[j] : null, p3 = j > 0 ? b3[j - 1] : null;
          if (filt && filt !== 'wait') { if (!c3 || c3.day !== b.day || !(dir * (c3.e9 - c3.vwap4) > 0)) return; if (filt === 'slope' && !(p3 && p3.day === b.day && dir * (c3.e9 - p3.e9) > 0)) return; }
          let xt = null, why = 'time';
          if (!exit3) {
            for (let q = k + 1; q < b1.length && b1[q].day === b.day; q++) { const x = b1[q]; if (x.min >= 930) { xt = x.t; break; } if (Engine.x9Exit(x, dir)) { xt = x.t + 60000; why = 'level'; break; } const o = Engine.x9At(b1, q); if (o && o.dir === -dir) { xt = x.t + 60000; why = 'reverse'; break; } }
          } else {
            for (let q = Math.max(j + 1, 0); q < b3.length && b3[q].day === b.day; q++) { const x = b3[q]; if (x.t + 180000 <= e.t) continue; if (x.min >= 930) { xt = x.t; break; } if (Engine.x9Exit(x, dir)) { xt = x.t + 180000; why = 'level3'; break; } const o = Engine.x9At(b3, q); if (o && o.dir === -dir) { xt = x.t + 180000; why = 'reverse3'; break; } }
          }
          if (xt === null) xt = Date.parse(b.day + 'T20:00:00Z');
          busy = xt; plans[name].push({ day: b.day, dir, tIn: e.t, xt, why, s: SYM + ymdOf(b.day) + (dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') });
        });
      };
      run1('1min', null, false); run1('1min+3mSide', 'side', false); run1('1min+3mSlope', 'slope', false); run1('1min+3mExit', 'side', true); run1('1min+3mWait', 'wait', false);
      // 3-minute only
      { let busy = -1; Engine.x9Signals(b3, 585, 930).forEach(g => { const k = g.k, b = b3[k], dir = g.sig.dir; const T = b.t + 180000; if (b.t < busy) return; const ie = b1.findIndex(x => x.t >= T); const e = b1[ie]; if (!e || e.day !== b.day) return; let xt = null, why = 'time'; for (let q = k + 1; q < b3.length && b3[q].day === b.day; q++) { const x = b3[q]; if (x.min >= 930) { xt = x.t; break; } if (Engine.x9Exit(x, dir)) { xt = x.t + 180000; why = 'level3'; break; } const o = Engine.x9At(b3, q); if (o && o.dir === -dir) { xt = x.t + 180000; why = 'reverse3'; break; } } if (xt === null) xt = Date.parse(b.day + 'T20:00:00Z'); busy = xt; plans['3min'].push({ day: b.day, dir, tIn: e.t, xt, why, s: SYM + ymdOf(b.day) + (dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') }); }); }
      out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] }; Object.keys(plans).forEach(n => { out.n[SYM][n] = plans[n].length; });
      const byDay = {}; Object.keys(plans).forEach(n => plans[n].forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(Object.assign({ n }, p)); }));
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        const split = D < '2026-01-01' ? 'train' : 'lock';
        try {
          const todays = byDay[D], first = Math.min(...todays.map(p => p.tIn));
          const ob = await optBars([...new Set(todays.map(p => p.s))], first - 60000, Date.parse(D + 'T21:05:00Z'));
          todays.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip(SYM + ' no option price'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.tIn + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip(SYM + ' no usable entry price'); return; }
            let xt = p.xt, why = p.why;
            for (let t = tFill + 60000; t < p.xt; t += 60000) { const v = pxAt(arr, t, 2); if (v !== null && v <= pin * 0.7) { xt = t; why = 'premium stop'; break; } }
            let pout = null; for (let j = 0; j <= 5 && pout === null; j++) pout = pxAt(arr, xt + j * 60000, 3); if (pout === null) pout = pxAt(arr, xt, 30);
            if (pout === null) { skip(SYM + ' no exit price'); return; }
            const pnl = (pout - pin) * 100 - 2;
            acc(SYM + '|' + p.n + '|' + split, pnl); acc(SYM + '|' + p.n + '|why-' + why, pnl); acc(SYM + '|' + p.n + '|' + (p.dir > 0 ? 'call' : 'put') + '|' + split, pnl);
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + Object.keys(byDay).length + ' days'; await save(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
