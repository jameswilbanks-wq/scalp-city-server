/* Study 13 (read-only): ORB variants from the "TradeX QuantORB" reel (shared 2026-11-11) on REAL same-day option prices, SPY and QQQ, Mar 2024 - now.
   Reel (MNQ futures, 15-minute chart): opening range = the first 15-minute candle; enter when a 15-minute candle closes beyond it; stop at the other side
   of the range; target 1.25x the risk (entry 29469, stop 29208, target 29795.25); stop later moved to break-even; range-size filters ("normalize the range").
   Here: range = 9:30-9:45 ET. Entry signal on a 15-minute close ('e15') or a 5-minute close ('e5') beyond the range, after 9:45 and by 15:00; one trade per day.
   Entry at the next 5-minute open; buy the at-the-money same-day call (up) or put (down). Stop = other side of the range. Targets 1R / 1.25R / 1.5R / 2R.
   Break-even: none / move the stop to entry once the trade has gone +0.5R / +1R. Everything out by 15:30 ET. Stop checked before target inside a bar.
   Option sold at the last trade at the exit time. $0.01 per fill each way. Also records avgR (the underlying result in R, a stand-in for futures before costs).
   Range-size buckets: range as % of price, cut at the tercile boundaries of the training period. Split: train before 2026-01-01, lock 2026 onward. kv 'bt13'. */
module.exports = async function studyOrb15(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt13', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {}, cuts: {} }, M = {};
  const acc = (key, pnl, r) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, r: 0 }; c.n++; c.net += pnl; c.r += r; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), avgR: r2(c.r / c.n) }; }); };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  const TG = [1, 1.25, 1.5, 2], BE = [0, 0.5, 1];
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570 && days[d][1].min === 575 && days[d][2].min === 580);
    // range-size cuts from the training period
    const pctOf = D => { const B = days[D], h = Math.max(B[0].h, B[1].h, B[2].h), l = Math.min(B[0].l, B[1].l, B[2].l); return (h - l) / B[0].o * 100; };
    const tr = dayList.filter(d => d < '2026-01-01').map(pctOf).sort((a, b) => a - b), c1 = tr[Math.floor(tr.length / 3)], c2 = tr[Math.floor(tr.length * 2 / 3)];
    out.cuts[SYM] = c1 === undefined ? null : { small: Math.round(c1 * 1000) / 1000, large: Math.round(c2 * 1000) / 1000 };
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10);
      const orH = Math.max(B[0].h, B[1].h, B[2].h), orL = Math.min(B[0].l, B[1].l, B[2].l), pc = pctOf(D), bucket = c1 === undefined ? 'na' : pc < c1 ? 'small' : pc < c2 ? 'mid' : 'large';
      try {
        const plans = [];
        // e5: first 5-minute close beyond the range
        for (let k = 3; k < B.length - 1; k++) { if (B[k].min > 900) break; const dir = B[k].c > orH ? 1 : B[k].c < orL ? -1 : 0; if (dir) { plans.push({ en: 'e5', dir, k1: k + 1 }); break; } }
        // e15: first 15-minute candle (585, 600, ...) closing beyond the range; the candle's close = close of its last 5-minute bar
        for (let k = 3; k + 2 < B.length - 1; k += 3) { if (B[k].min > 900) break; if (B[k + 2].min !== B[k].min + 10) { skip('gap in 15-minute candle'); break; } const c = B[k + 2].c, dir = c > orH ? 1 : c < orL ? -1 : 0; if (dir) { plans.push({ en: 'e15', dir, k1: k + 3 }); break; } }
        if (!plans.length) { skip('no breakout'); continue; }
        plans.forEach(p => { p.e = B[p.k1].o; p.tIn = B[p.k1].t; p.stop0 = p.dir > 0 ? orL : orH; p.R = Math.abs(p.e - p.stop0); p.s = SYM + ymd + (p.dir > 0 ? 'C' : 'P') + String(Math.round(p.e) * 1000).padStart(8, '0'); });
        const ob = await optBars([...new Set(plans.map(p => p.s))], Math.min(...plans.map(p => p.tIn)) - 60000, B[B.length - 1].t + 5 * 60000);
        plans.forEach(p => {
          if (!(p.R > 0.0001 * p.e) || p.dir * (p.e - p.stop0) <= 0) { skip('entry already through the stop'); return; }
          const arr = ob[p.s]; if (!arr) { skip('no option price'); return; }
          let pin = null; for (const b of arr) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pin = b.o; break; } if (b.t > p.tIn + 3 * 60000) break; }
          if (pin === null || !(pin >= 0.05)) { skip('no usable entry price'); return; }
          const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
          TG.forEach(tg => BE.forEach(be => {
            let stop = p.stop0, moved = false, xt = null, why = 'time', xr = null;
            for (let q = p.k1; q < B.length; q++) {
              const x = B[q];
              if (x.min >= 930) { xt = x.t; xr = p.dir * (x.o - p.e) / p.R; break; }
              if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 5 * 60000; why = moved ? 'breakeven' : 'stop'; xr = p.dir * (stop - p.e) / p.R; break; }
              if (p.dir > 0 ? x.h >= p.e + tg * p.R : x.l <= p.e - tg * p.R) { xt = x.t + 5 * 60000; why = 'target'; xr = tg; break; }
              if (be && !moved && p.dir * ((p.dir > 0 ? x.h : x.l) - p.e) >= be * p.R) { stop = p.e; moved = true; }
            }
            if (xt === null) { const L = B[B.length - 1]; xt = L.t; xr = p.dir * (L.c - p.e) / p.R; }
            const pout = sellAt(xt); if (pout === null) { skip('no exit price'); return; }
            const pnl = (pout - pin) * 100 - 2, base = SYM + '|' + p.en + '|t' + tg + '|be' + be;
            acc(base + '|' + split, pnl, xr); acc(base + '|' + bucket + '|' + split, pnl, xr); acc(base + '|why-' + why, pnl, xr);
            if (tg === 1.25 && be === 1) acc(SYM + '|' + p.en + '|reel|' + (p.dir > 0 ? 'call' : 'put') + '|' + split, pnl, xr);
          }));
          acc(SYM + '|' + p.en + '|cost', pin * 100, 0);
        });
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++; if (done % 60 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
