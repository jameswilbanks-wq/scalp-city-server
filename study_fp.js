/* Study 14 (read-only): JJ Simon "fair pricing theory" (video shared 2026-11-12) on REAL same-day option prices, SPY and QQQ, Mar 2024 - now.
   Mirrors the live FP book. Fair price = the 9:30 ET 1-minute open.
   Continuation: once a day on the first 1-minute candle's color; with 'bias' it must agree with the overnight-reversion bias (opposite of prior close -> open gap).
     Levels from the first candle's close: stop 0.10%, target 0.15% (both doubled if the first candle's range > 0.10%). Entry at the 9:31 open.
   Reversion: a 1-minute displacement candle toward the open (body > previous body, close beyond the previous wick), signal candles 9:31-10:59,
     the open at least 1.5x the stop away; stop 0.10% from the signal close; target = the open ('open') or 1.5x the stop ('r15'). Stop after 3 losses in a row.
   One position per symbol at a time, entry at the next 1-minute open, all out by 11:30 ET, -50% premium stop. ATM same-day call/put, $0.01 per fill each way.
   Variants: bias on/off x reversion target open/r15. Split: train before 2026-01-01, lock 2026 onward. kv 'bt14'. */
module.exports = async function studyFp(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt14', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl, r) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, r: 0 }; c.n++; c.net += pnl; c.r += r; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), avgR: r2(c.r / c.n) }; }); };
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
    }
    return m;
  };
  const STOP = (opts.stopPct || 0.10) / 100, TGT = (opts.tgtPct || 0.15) / 100;
  const VARS = [];
  [true, false].forEach(bias => ['open', 'r15'].forEach(rt => VARS.push({ name: (bias ? 'bias' : 'nobias') + '|' + rt, bias, rt })));
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    out.progress = SYM + ' loading 1-minute bars'; await save();
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: opts.feed || 'sip', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const all = Object.keys(days).sort(), dayList = all.filter(d => days[d].length >= 300 && days[d][0].min === 570 && days[d][1].min === 571);
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10);
      const pi = all.indexOf(D), prevB = pi > 0 ? days[all[pi - 1]] : null, prevClose = prevB && prevB.length ? prevB[prevB.length - 1].c : null;
      const first = B[0], fair = first.o;
      try {
        // plan every variant's trades on the underlying
        const trades = [];
        VARS.forEach(V => {
          let busy = -1, losses = 0;
          const walk = (k1, dir, stopU, tgtU) => { for (let q = k1; q < B.length; q++) { const x = B[q]; if (x.min >= 690) return { q, xt: x.t, why: 'time', xu: x.o }; if (dir > 0 ? x.l <= stopU : x.h >= stopU) return { q, xt: x.t + 60000, why: 'stop', xu: stopU }; if (dir > 0 ? x.h >= tgtU : x.l <= tgtU) return { q, xt: x.t + 60000, why: 'target', xu: tgtU }; } const L = B[B.length - 1]; return { q: B.length - 1, xt: L.t, why: 'time', xu: L.c }; };
          const dirF = first.c > first.o ? 1 : first.c < first.o ? -1 : 0, biasD = prevClose ? (first.o > prevClose ? -1 : first.o < prevClose ? 1 : 0) : 0;
          if (dirF && !(V.bias && biasD && biasD !== dirF)) {
            const mult = (first.h - first.l) > first.o * STOP ? 2 : 1, ref = first.c, stopU = ref - dirF * ref * STOP * mult, tgtU = ref + dirF * ref * TGT * mult;
            const w = walk(1, dirF, stopU, tgtU); busy = w.q;
            trades.push({ V: V.name, kind: 'cont', dir: dirF, k1: 1, e: B[1].o, R: Math.abs(B[1].o - stopU), w });
          }
          for (let k = 1; k < B.length - 1 && B[k].min < 660; k++) {
            if (k <= busy || losses >= 3) continue;
            const b = B[k], p = B[k - 1], bodyB = Math.abs(b.c - b.o), bodyP = Math.abs(p.c - p.o), sd = b.c * STOP;
            let dir = 0;
            if (b.c > fair && b.c < b.o && bodyB > bodyP && b.c < p.l && b.c - fair >= 1.5 * sd) dir = -1;
            if (b.c < fair && b.c > b.o && bodyB > bodyP && b.c > p.h && fair - b.c >= 1.5 * sd) dir = 1;
            if (!dir) continue;
            const stopU = b.c - dir * sd, tgtU = V.rt === 'open' ? fair : b.c + dir * 1.5 * sd;
            const w = walk(k + 1, dir, stopU, tgtU); busy = w.q;
            const t = { V: V.name, kind: 'rev', dir, k1: k + 1, e: B[k + 1].o, R: Math.abs(B[k + 1].o - stopU), w };
            trades.push(t);
            const ur = dir * (w.xu - t.e); losses = ur > 0 ? 0 : losses + 1; // loss counter on the underlying result (live uses option P&L)
          }
        });
        if (!trades.length) { skip('no trades'); continue; }
        trades.forEach(t => { t.tIn = B[t.k1].t; t.s = SYM + ymd + (t.dir > 0 ? 'C' : 'P') + String(Math.round(t.e) * 1000).padStart(8, '0'); });
        const ob = await optBars([...new Set(trades.map(t => t.s))], Math.min(...trades.map(t => t.tIn)) - 60000, Date.parse(D + 'T17:00:00Z'));
        trades.forEach(t => {
          const arr = ob[t.s]; if (!arr) { skip('no option price'); return; }
          let pin = null, tFill = null; for (const b of arr) { if (b.t >= t.tIn && b.t <= t.tIn + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > t.tIn + 3 * 60000) break; }
          if (pin === null || !(pin >= 0.05)) { skip('no usable entry price'); return; }
          let xt = t.w.xt, why = t.w.why;
          for (let m = tFill + 60000; m < xt; m += 60000) { const v = pxAt(arr, m, 2); if (v !== null && v <= pin * 0.5) { xt = m; why = 'premium stop'; break; } }
          let pout = null; for (let j = 0; j <= 5 && pout === null; j++) pout = pxAt(arr, xt + j * 60000, 3); if (pout === null) pout = pxAt(arr, xt, 30);
          if (pout === null) { skip('no exit price'); return; }
          const pnl = (pout - pin) * 100 - 2, r = t.R > 0 ? t.dir * (t.w.xu - t.e) / t.R : 0, base = SYM + '|' + t.V + '|' + t.kind;
          acc(base + '|' + split, pnl, r); acc(base + '|why-' + why, pnl, r); acc(SYM + '|' + t.V + '|both|' + split, pnl, r);
          if (t.kind === 'rev') acc(base + '|' + (t.dir > 0 ? 'call' : 'put') + '|' + split, pnl, r);
        });
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++; if (done % 40 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
