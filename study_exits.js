/* Study 9 (read-only), two parts on REAL Alpaca option prices, SPY and QQQ, train = before 2026-01-01 / lock = 2026 onward (spreads) or first 2/3 of sessions / last 1/3 (sweep).
   Part A, call-spread profit taking: sell the same-day call spread at 11:00 ET, short strike nearest 0.45% above the price, $2 wide.
     Exits: hold (settle at the close); take80 / take50 (buy back once the spread is worth <= 20% / 50% of the credit); stop2x / stop3x (buy back once it is worth >= 2x / 3x the credit);
     take80+stop2x; ustop (buy back when a 5-minute bar closes above the short strike). An exit fires only when BOTH legs traded in the same minute and the condition held on two consecutive such minutes. $0.01 per leg per fill.
   Part B, sweep signal-failure exits: buy the at-the-money same-day option on each sweep signal (as study 8).
     Exits: run (wick stop + 1R trail, the live rule); stall3 / stall5 (out when 3 / 5 bars pass without a new favorable extreme, wick stop still on); stall3+cut14 (same, plus no entries after 14:00 ET and all out by 14:00); run+cut13 (live rule, no entries after 13:00 ET).
   Saved to kv 'bt9' with progress. */
module.exports = async function studyExits(ap, rh, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst) }; }); };
  const save = async () => { fin(); try { await kset('bt9', out); } catch (e) {} };
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
  const idx = arr => { const m = new Map(); (arr || []).forEach(b => m.set(b.t, b.c)); return m; };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10), SYMS = opts.syms || ['SPY', 'QQQ'];
  /* ---------------- Part A ---------------- */
  for (const SYM of SYMS) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570);
    out.n['A|' + SYM] = { sessions: dayList.length };
    let done = 0;
    for (const D of dayList) {
      const B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = ymdOf(D), close = B[B.length - 1].c, tEnd = B[B.length - 1].t + 5 * 60000;
      try {
        const b = B.find(x => x.min === 655); if (!b) { skip('A no 11:00 bar'); continue; }
        const p = b.c, tT = b.t + 5 * 60000, ks = Math.round(p * 1.0045), kl = ks + 2;
        const S = SYM + ymd + 'C' + String(ks * 1000).padStart(8, '0'), L = SYM + ymd + 'C' + String(kl * 1000).padStart(8, '0');
        const ob = await optBars([S, L], tT - 6 * 60000, tEnd), s0 = pxAt(ob[S], tT, 5), l0 = pxAt(ob[L], tT, 5);
        if (s0 === null || l0 === null) { skip('A no price at entry'); continue; }
        const credit = s0 - l0; if (!(credit >= 0.03 && credit <= 1.8)) { skip('A credit out of range'); continue; }
        const settle = Math.min(2, Math.max(0, close - ks)), hold = (credit - settle) * 100 - 2;
        const iS = idx(ob[S]), iL = idx(ob[L]);
        // same-minute spread values after entry
        const vals = []; for (let t = tT + 60000; t < tEnd - 60000; t += 60000) { if (iS.has(t) && iL.has(t)) vals.push({ t, v: Math.min(2, Math.max(0, iS.get(t) - iL.get(t))) }); }
        let ustopT = null; for (const x of B) { if (x.t + 5 * 60000 <= tT || x.min >= 955) continue; if (x.c > ks) { ustopT = x.t + 5 * 60000; break; } }
        const rules = { take80: v => v <= 0.2 * credit, take50: v => v <= 0.5 * credit, stop2x: v => v >= 2 * credit, stop3x: v => v >= 3 * credit, 'take80+stop2x': v => v <= 0.2 * credit || v >= 2 * credit };
        const base = 'A|' + SYM + '|';
        acc(base + 'hold|' + split, hold); acc(base + 'credit', credit * 100);
        Object.keys(rules).forEach(nm => {
          let hit = null, prev = false;
          for (const x of vals) { const ok = rules[nm](x.v); if (ok && prev) { hit = x; break; } prev = ok; }
          const pnl = hit ? (credit - hit.v) * 100 - 4 : hold; acc(base + nm + '|' + split, pnl); if (hit) acc(base + nm + '|fired|' + split, pnl);
        });
        if (ustopT === null) acc(base + 'ustop|' + split, hold);
        else { const x = vals.find(z => z.t >= ustopT); const pnl = x ? (credit - x.v) * 100 - 4 : hold; acc(base + 'ustop|' + split, pnl); acc(base + 'ustop|fired|' + split, pnl); }
      } catch (e) { out.errs++; out.lastErr = 'A ' + SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++; if (done % 60 === 0) { out.progress = 'A ' + SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
  }
  await save();
  /* ---------------- Part B ---------------- */
  const now = Date.now(), daysBack = opts.days || 365;
  for (const SYM of SYMS) {
    try {
      out.progress = 'B ' + SYM + ' loading 1-minute bars'; await save();
      const st = {};
      for (let a = now - daysBack * 864e5; a < now; a += 4 * 864e5) {
        const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
        (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
      }
      const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n['B|' + SYM] = 'too few bars'; continue; }
      Engine.simulate(bars, {}, true);
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
      const sigs = Engine.signals(bars, { vwap: false, orb: false, ema: false }).filter(g => g.sig.trig === 'sweep' && g.sig.stopPx !== undefined && g.sig.stopPx !== null && bars[g.k + 1] && bars[g.k + 1].day === bars[g.k].day);
      out.n['B|' + SYM] = { sessions: dayList.length, signals: sigs.length };
      const byDay = {}; sigs.forEach(g => { (byDay[bars[g.k].day] = byDay[bars[g.k].day] || []).push(g); });
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        try {
          const plan = byDay[D].map(g => { const k = g.k, e = bars[k + 1], dir = g.sig.dir, R = Math.abs(e.o - g.sig.stopPx); if (!(R > 0.0001 * e.o)) return null; return { k, e, dir, R, s: SYM + ymdOf(D) + (dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') }; }).filter(Boolean);
          if (!plan.length) continue;
          const ob = await optBars([...new Set(plan.map(p => p.s))], bars[plan[0].k + 1].t - 60000, Date.parse(D + 'T21:05:00Z'));
          plan.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip('B no option price at entry'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.e.t && b.t <= p.e.t + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.e.t + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip('B no usable entry price'); return; }
            const walk = (mode, cutMin) => {
              let stop = p.e.o - p.dir * p.R, hi = p.e.o, since = 0;
              for (let q = p.k + 1; q < bars.length && bars[q].day === D; q++) {
                const x = bars[q]; if (x.min >= (cutMin || 930)) return x.t;
                if (p.dir > 0 ? x.l <= stop : x.h >= stop) return x.t + 60000;
                const ext = p.dir > 0 ? x.h : x.l, better = p.dir * (ext - hi) > 0; if (better) { hi = ext; since = 0; } else since++;
                if (mode === 'run') { const ns = hi - p.dir * p.R; if (p.dir * (ns - stop) > 0) stop = ns; if (p.dir * (x.c - stop) < 0) return x.t + 60000; }
                if (mode === 'stall3' && since >= 3) return x.t + 60000;
                if (mode === 'stall5' && since >= 5) return x.t + 60000;
              }
              return bars[p.k + 1].t + 60000;
            };
            const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
            const rec = (name, t) => { const pout = sellAt(t); if (pout === null) { skip('B no exit price'); return; } const pnl = (pout - pin) * 100 - 2; acc('B|' + SYM + '|' + name + '|' + split[D], pnl); acc('B|' + SYM + '|' + name + '|ALL', pnl); };
            rec('run', walk('run')); rec('stall3', walk('stall3')); rec('stall5', walk('stall5'));
            if (p.e.min < 840) rec('stall3+cut14', walk('stall3', 840));
            if (p.e.min < 780) rec('run+cut13', walk('run'));
          });
        } catch (e) { out.errs++; out.lastErr = 'B ' + SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++; if (done % 40 === 0) { out.progress = 'B ' + SYM + ' ' + done + ' signal days'; await save(); }
      }
    } catch (e) { out.errs++; out.lastErr = 'B ' + SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
