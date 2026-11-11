/* Study 6 (read-only): 0DTE SPY strategies on REAL historical option prices (Alpaca 1-minute option bars, trades-based, since 2024-03).
   - Credit spreads $1 wide: put, call, iron condor; short strike d = 2/3/4 dollars from the price at T = 10:00 / 11:00 / 13:00 ET.
     exit 'hold' = settle at the close; 'man' = close when the spread costs 2x the credit (stop) or 0.5x (profit), else settle.
   - ORB buy: first 5-minute bar range, first later 5-minute close beyond it, buy the at-the-money call/put, stop = other side of the range, target 2R (underlying), else out 15:30.
   Bars are trade prices, not quotes, so each fill pays an assumed $0.01 per leg (res.fills lets you re-cost at $0.02).
   Split: train = before 2026-01-01, lock = 2026 onward. Saved to kv 'bt6' with progress. */
module.exports = async function study0dte(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const out = { started: new Date().toISOString(), from: opts.from || '2024-03-01', progress: 'loading SPY bars', errs: 0, skipped: {}, res: {} }, M = {};
  const acc = (key, pnl, fills) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, fills: 0, worst: 0 }; c.n++; c.net += pnl; c.fills += fills; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), total: Math.round(c.net), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), fills: r2(c.fills / c.n) }; }); };
  // 1) SPY 5-minute bars, grouped by ET day (regular hours only)
  const days = {}; let tok;
  do {
    const d = await ap('/v2/stocks/SPY/bars', { timeframe: '5Min', start: out.from + 'T00:00:00Z', end: opts.to || new Date(Date.now() - 20 * 60000).toISOString(), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
    (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
    tok = d.next_page_token; await sleep(gap);
  } while (tok);
  const dayList = Object.keys(days).sort().filter(d => days[d].length >= 60 && days[d][0].min === 570);
  out.sessions = dayList.length; out.first = dayList[0]; out.last = dayList[dayList.length - 1];
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  // last trade price at or before t, no older than maxAge minutes
  const px = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const SLIP = 1; // dollars per leg per fill ($0.01 x 100)
  let done = 0;
  for (const D of dayList) {
    const B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10), close = B[B.length - 1].c, tEnd = B[B.length - 1].t + 5 * 60000;
    const sym = (type, k) => 'SPY' + ymd + type + String(Math.round(k * 1000)).padStart(8, '0');
    try {
      // ---- credit spreads
      const plan = [], need = new Set();
      [600, 660, 780].forEach(T => {
        const b = B.find(x => x.min === T - 5); if (!b) return; const p = b.c, tT = b.t + 5 * 60000;
        [2, 3, 4].forEach(d => {
          const ps = Math.round(p - d), cs = Math.round(p + d);
          plan.push({ T, tT, d, type: 'put', S: sym('P', ps), L: sym('P', ps - 1), ks: ps, kl: ps - 1 }, { T, tT, d, type: 'call', S: sym('C', cs), L: sym('C', cs + 1), ks: cs, kl: cs + 1 });
          [sym('P', ps), sym('P', ps - 1), sym('C', cs), sym('C', cs + 1)].forEach(x => need.add(x));
        });
      });
      // ---- ORB signal (5-minute bars)
      let orb = null; const orH = B[0].h, orL = B[0].l;
      for (let k = 1; k < B.length - 1; k++) {
        if (B[k].min > 900) break; const dir = B[k].c > orH ? 1 : B[k].c < orL ? -1 : 0; if (!dir) continue;
        const e = B[k + 1].o, stop = dir > 0 ? orL : orH, risk = Math.abs(e - stop); if (!(risk > 0.0001 * e) || dir * (e - stop) <= 0) break;
        let xt = null, why = 'time';
        for (let q = k + 1; q < B.length; q++) { const x = B[q]; if (x.min >= 930) { xt = x.t; break; } if (dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 5 * 60000; why = 'stop'; break; } if (dir > 0 ? x.h >= e + 2 * risk : x.l <= e - 2 * risk) { xt = x.t + 5 * 60000; why = 'target'; break; } }
        if (xt === null) xt = B[B.length - 1].t;
        orb = { dir, tIn: B[k + 1].t, xt, why, s: sym(dir > 0 ? 'C' : 'P', Math.round(e)) }; need.add(orb.s); break;
      }
      if (!need.size) { skip('no entries'); continue; }
      const ob = await optBars([...need], B[0].t, tEnd);
      const pnlOf = {};
      plan.forEach(pl => {
        const s0 = px(ob[pl.S], pl.tT, 5), l0 = px(ob[pl.L], pl.tT, 5);
        if (s0 === null || l0 === null) { skip('no price at entry'); return; }
        const credit = s0 - l0; if (!(credit >= 0.03 && credit <= 0.9)) { skip('credit out of range'); return; }
        const intr = k => pl.type === 'put' ? Math.max(0, k - close) : Math.max(0, close - k), settle = Math.min(1, Math.max(0, intr(pl.ks) - intr(pl.kl)));
        const hold = (credit - settle) * 100 - 2 * SLIP;
        let man = null;
        for (let t = pl.tT + 60000; t <= tEnd - 5 * 60000; t += 60000) {
          const a = px(ob[pl.S], t, 10), b2 = px(ob[pl.L], t, 10); if (a === null || b2 === null) continue;
          const v = Math.max(0, a - b2);
          if (v >= 2 * credit || v <= 0.5 * credit) { man = (credit - v) * 100 - 4 * SLIP; break; }
        }
        const manFills = man === null ? 2 : 4; if (man === null) man = hold;
        const base = pl.type + '|d' + pl.d + '|T' + pl.T;
        acc(base + '|hold|' + split, hold, 2); acc(base + '|man|' + split, man, manFills);
        pnlOf[pl.type + pl.d + pl.T] = { hold, man, manFills, credit };
        acc('credit|' + pl.type + '|d' + pl.d + '|T' + pl.T, credit * 100, 0);
      });
      [600, 660, 780].forEach(T => [2, 3, 4].forEach(d => { const a = pnlOf['put' + d + T], b = pnlOf['call' + d + T]; if (!a || !b) return; acc('condor|d' + d + '|T' + T + '|hold|' + split, a.hold + b.hold, 4); acc('condor|d' + d + '|T' + T + '|man|' + split, a.man + b.man, a.manFills + b.manFills); }));
      if (orb) {
        const arr = ob[orb.s]; let pin = null;
        if (arr) for (const b of arr) { if (b.t >= orb.tIn && b.t <= orb.tIn + 3 * 60000) { pin = b.o; break; } }
        const pout = px(arr, orb.xt, 5);
        if (pin === null || pout === null) skip('orb no option price');
        else { const pnl = (pout - pin) * 100 - 2 * SLIP; acc('orbbuy|2R|' + split, pnl, 2); acc('orbbuy|2R|' + (orb.dir > 0 ? 'call' : 'put') + '|' + split, pnl, 2); acc('orbbuy|2R|why-' + orb.why, pnl, 2); acc('orbbuy|cost', pin * 100, 0); }
      }
    } catch (e) { out.errs++; out.lastErr = D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
    done++;
    if (done % 40 === 0) { out.progress = done + ' of ' + dayList.length + ' days (' + D + ')'; fin(); try { await kset('bt6', out); } catch (e) {} }
  }
  out.progress = 'done'; out.done = new Date().toISOString(); fin();
  return out;
};
