/* Study 7 (read-only): reliability checks for selling 0DTE call credit spreads, on REAL Alpaca option prices.
   Symbols SPY and QQQ. Short strike = round(price x (1 + p)) with p = 0.30% / 0.45% / 0.60% at T = 10:00 / 11:00 / 12:00 / 13:00 / 14:00 ET.
   Width $1 and $2. Exits: 'hold' = settle at the close; 'c330' = buy back at 15:30 ET; 'ustop' = buy back when a 5-minute bar closes beyond the short strike, else settle.
   Put spreads (mirror, $1 wide, hold) are included as a reference. $0.01 per leg per fill assumed; res.fills lets you re-cost.
   Split: train = before 2026-01-01, lock = 2026 onward. Saved to kv 'bt7' with progress. */
module.exports = async function study0dte2(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const out = { started: new Date().toISOString(), from: opts.from || '2024-03-01', progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl, fills) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, fills: 0, worst: 0 }; c.n++; c.net += pnl; c.fills += fills; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), fills: r2(c.fills / c.n) }; }); };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  const px = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const SLIP = 1, TS = [600, 660, 720, 780, 840], PS = [0.003, 0.0045, 0.006];
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: out.from + 'T00:00:00Z', end: opts.to || new Date(Date.now() - 20 * 60000).toISOString(), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570);
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10), close = B[B.length - 1].c, tEnd = B[B.length - 1].t + 5 * 60000;
      const sym = (type, k) => SYM + ymd + type + String(Math.round(k * 1000)).padStart(8, '0');
      try {
        const plan = [], need = new Set(); let tFirst = null;
        TS.forEach(T => {
          const b = B.find(x => x.min === T - 5); if (!b) return; const p = b.c, tT = b.t + 5 * 60000; if (tFirst === null) tFirst = tT;
          PS.forEach((pc, pi) => {
            const cs = Math.round(p * (1 + pc)), ps = Math.round(p * (1 - pc));
            [1, 2].forEach(w => { plan.push({ T, tT, pi, w, type: 'call', ks: cs, kl: cs + w, S: sym('C', cs), L: sym('C', cs + w) }); need.add(sym('C', cs)); need.add(sym('C', cs + w)); });
            plan.push({ T, tT, pi, w: 1, type: 'put', ks: ps, kl: ps - 1, S: sym('P', ps), L: sym('P', ps - 1) }); need.add(sym('P', ps)); need.add(sym('P', ps - 1));
          });
        });
        if (!need.size) { skip('no entries'); continue; }
        const ob = await optBars([...need], tFirst - 6 * 60000, tEnd);
        const b330 = B.find(x => x.min === 925), t330 = b330 ? b330.t + 5 * 60000 : null;
        plan.forEach(pl => {
          const s0 = px(ob[pl.S], pl.tT, 5), l0 = px(ob[pl.L], pl.tT, 5);
          if (s0 === null || l0 === null) { skip('no price at entry'); return; }
          const credit = s0 - l0; if (!(credit >= 0.03 && credit <= 0.9 * pl.w)) { skip('credit out of range'); return; }
          const intr = k => pl.type === 'put' ? Math.max(0, k - close) : Math.max(0, close - k), settle = Math.min(pl.w, Math.max(0, intr(pl.ks) - intr(pl.kl)));
          const hold = (credit - settle) * 100 - 2 * SLIP, base = SYM + '|' + pl.type + '|p' + pl.pi + '|T' + pl.T + '|w' + pl.w;
          acc(base + '|hold|' + split, hold, 2);
          if (pl.type !== 'call') return;
          acc(SYM + '|credit|p' + pl.pi + '|T' + pl.T + '|w' + pl.w, credit * 100, 0);
          const valAt = t => { for (let k = 0; k <= 15; k++) { const a = px(ob[pl.S], t + k * 60000, 5), b2 = px(ob[pl.L], t + k * 60000, 5); if (a !== null && b2 !== null) return Math.min(pl.w, Math.max(0, a - b2)); } return null; };
          // close at 15:30 ET
          if (t330 && t330 > pl.tT) { const v = valAt(t330); if (v === null) { skip('c330 no price'); acc(base + '|c330|' + split, hold, 2); } else acc(base + '|c330|' + split, (credit - v) * 100 - 4 * SLIP, 4); }
          // underlying stop: a 5-minute bar closes beyond the short strike
          let st = null; for (const x of B) { if (x.t + 5 * 60000 <= pl.tT || x.min >= 955) continue; if (x.c > pl.ks) { st = x.t + 5 * 60000; break; } }
          if (st === null) acc(base + '|ustop|' + split, hold, 2);
          else { const v = valAt(st); if (v === null) { skip('ustop no price'); acc(base + '|ustop|' + split, hold, 2); } else { acc(base + '|ustop|' + split, (credit - v) * 100 - 4 * SLIP, 4); acc(SYM + '|ustop-hit|' + split, (credit - v) * 100 - 4 * SLIP, 4); } }
        });
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++;
      if (done % 40 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length + ' days (' + D + ')'; fin(); try { await kset('bt7', out); } catch (e) {} }
    }
  }
  out.progress = 'done'; out.done = new Date().toISOString(); fin();
  return out;
};
