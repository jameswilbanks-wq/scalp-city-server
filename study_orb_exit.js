/* bt27 (read-only; James approved 2026-11-20: "yes"): ORB15 live-rules baseline (L0) and the pre-registered exit/filter variants V1-V9 from docs/orb-exit-study-spec.md, on REAL same-day option prices, SPY and QQQ, Mar 2024 to 2026-11-11.
   NOT TRADING: nothing here places an order or touches any live book. Saved to kv bt27 (progress and resumable rows in bt27p), once.
   Signal/entry/underlying-exit logic is copied from study_orb15.js (bt13): range 9:30-9:45, first 15-minute close beyond it, entry at the next 5-minute open, stop = other side of the range, target 1.25R, 5-minute underlying bars,
   option 1-minute bars; entry price = open of the entry-minute bar; everything out by 15:30 ET. Added here: option-premium exits scanned on closed 1-minute option bars (a bar is "closed" at bar.t+60s, exit price = that bar's close).
   Gross $ per contract stored per trade; costs applied afterwards at $0.01 and $0.03 per leg (2 legs). Rows are saved so drop-best-5 and bootstrap checks need no rerun. */
'use strict';
const TG = 1.25;

// Underlying-side exit exactly as bt13 (be = 0 or 0.5R); returns exit time and reason. B = 5-minute bars of the day, p = {dir,k1,e,stop0,R}.
function underlying(p, B, be) {
  let stop = p.stop0, moved = false, xt = null, why = 'time';
  for (let q = p.k1; q < B.length; q++) {
    const x = B[q];
    if (x.min >= 930) { xt = x.t; break; }
    if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 5 * 60000; why = moved ? 'breakeven' : 'stop'; break; }
    if (p.dir > 0 ? x.h >= p.e + TG * p.R : x.l <= p.e - TG * p.R) { xt = x.t + 5 * 60000; why = 'target'; break; }
    if (be && !moved && p.dir * ((p.dir > 0 ? x.h : x.l) - p.e) >= be * p.R) { stop = p.e; moved = true; }
  }
  if (xt === null) xt = B[B.length - 1].t;
  return { xt, why };
}
// First option-premium exit before time xt. mode: p50 = -50% stop (live), p35 = -35% stop, l30/l50 = -50% stop plus a premium lock (stop moves to entry premium once a close is >= +30% / +50%),
// tr = -50% stop plus X9's premium trail (arm at +25%, exit when the close gives back 50% of the peak gain). The lock/trail are checked on bars after the arming bar.
function scan(arr, i0, xt, pin, mode) {
  let armed = false, peak = pin; const floor = mode === 'p35' ? 0.65 : 0.5;
  for (let j = i0; j < arr.length; j++) {
    const b = arr[j]; if (b.t + 60000 > xt) break; const c = b.c;
    if (c <= floor * pin) return { t: b.t + 60000, p: c, why: 'premium' };
    if (armed) { if (mode === 'tr' ? c <= pin + 0.5 * (peak - pin) : c <= pin) return { t: b.t + 60000, p: c, why: 'premium lock' }; }
    if (c > peak) peak = c;
    if (mode === 'l30' && c >= 1.3 * pin) armed = true;
    if (mode === 'l50' && c >= 1.5 * pin) armed = true;
    if (mode === 'tr' && peak >= 1.25 * pin) armed = true;
  }
  return null;
}
function pxAt(arr, t, maxAge) { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; }
const sellAt = (arr, t) => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };

// One ORB15 trade under every mechanic. Returns { pin, rsn, g: [L0,V1,V2,V3,V4,V5] gross $ per contract (null = no exit price for that variant) } or { skip }.
function simTrade(p, B, arr) {
  if (!(p.R > 0.0001 * p.e) || p.dir * (p.e - p.stop0) <= 0) return { skip: 'entry already through the stop' };
  if (!arr) return { skip: 'no option price' };
  let i0 = -1; for (let j = 0; j < arr.length; j++) { const b = arr[j]; if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { i0 = j; break; } if (b.t > p.tIn + 3 * 60000) break; }
  if (i0 < 0 || !(arr[i0].o >= 0.05)) return { skip: 'no usable entry price' };
  const pin = arr[i0].o, u5 = underlying(p, B, 0.5), u0 = underlying(p, B, 0);
  const pu5 = sellAt(arr, u5.xt), pu0 = sellAt(arr, u0.xt), gr = v => v === null ? null : (v - pin) * 100;
  const e50 = scan(arr, i0, u5.xt, pin, 'p50'), e35 = scan(arr, i0, u5.xt, pin, 'p35'), l30 = scan(arr, i0, u0.xt, pin, 'l30'), l50 = scan(arr, i0, u0.xt, pin, 'l50'), tr = scan(arr, i0, u0.xt, pin, 'tr');
  const withEv = (ev, pu) => ev ? (ev.p - pin) * 100 : gr(pu);
  return { pin, rsn: e50 ? 'premium' : u5.why, g: [withEv(e50, pu5), gr(pu5), withEv(e35, pu5), withEv(l30, pu0), withEv(l50, pu0), withEv(tr, pu0)] };
}

// ---- statistics (pure functions, tested) ----
const r2 = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// rows: [sym, day, entryMin, rangePct, pin, rsn, gL0, gV1, gV2, gV3, gV4, gV5]
const VARS = {
  L0: { c: 6 }, V1: { c: 7 }, V2: { c: 8 }, V3: { c: 9 }, V4: { c: 10 }, V5: { c: 11 },
  V6: { c: 6, take: r => r[2] <= 645 }, V7: { c: 6, take: r => r[2] <= 690 }, V8: { c: 6, take: (r, cuts) => !(cuts && cuts[r[0]] && r[3] >= cuts[r[0]].p90) },
  V9a: { c: 9, take: r => r[2] <= 645 }, V9b: { c: 9, take: r => r[2] <= 690 }
};
const period = d => d < '2026-01-01' ? 'dev' : 'conf', COSTS = [0.01, 0.03];
const net = (g, c) => g - 200 * c;
function cellStats(rs, col, base) {
  const o = { n: rs.length }; if (!rs.length) return o;
  COSTS.forEach(c => { const k = c === 0.01 ? '01' : '03', pn = rs.map(r => net(r[col], c)), w = pn.filter(x => x > 0).length, gw = pn.filter(x => x > 0).reduce((s, v) => s + v, 0), gl = -pn.filter(x => x <= 0).reduce((s, v) => s + v, 0); o['avg' + k] = r2(mean(pn)); o['win' + k] = Math.round(100 * w / pn.length); o['pf' + k] = gl > 0.01 ? r2(gw / gl) : null; o['delta' + k] = r2(mean(pn) - mean(base.map(r => net(r[6], c)))); });
  return o;
}
function bootDelta(base, take, col, reps, seed) {
  const days = {}; base.forEach(r => { const d = days[r[1]] = days[r[1]] || [0, 0, 0, 0]; d[2] += net(r[6], 0.01); d[3]++; });
  take.forEach(r => { const d = days[r[1]]; d[0] += net(r[col], 0.01); d[1]++; });
  const L = Object.keys(days).map(k => days[k]), rnd = rng(seed), out = [];
  for (let b = 0; b < reps; b++) { let sv = 0, nv = 0, sl = 0, nl = 0; for (let i = 0; i < L.length; i++) { const d = L[(rnd() * L.length) | 0]; sv += d[0]; nv += d[1]; sl += d[2]; nl += d[3]; } if (nv && nl) out.push(sv / nv - sl / nl); }
  out.sort((a, b) => a - b); return out.length ? [r2(out[Math.floor(out.length * 0.025)]), r2(out[Math.ceil(out.length * 0.975) - 1])] : [null, null];
}
function analyze(rows, cuts, opts) {
  opts = opts || {}; const reps = opts.reps || 2000, res = {}; const syms = [...new Set(rows.map(r => r[0]))].sort();
  const days = [...new Set(rows.map(r => r[1]))].sort(), blockOf = d => Math.min(3, Math.floor(days.indexOf(d) * 4 / days.length));
  Object.keys(VARS).forEach((name, vi) => {
    const V = VARS[name], base = rows.filter(r => r[6] !== null && r[V.c] !== null), take = base.filter(r => !V.take || V.take(r, cuts)), cells = {};
    syms.forEach(s => ['dev', 'conf'].forEach(pr => { const b = base.filter(r => r[0] === s && period(r[1]) === pr), t = take.filter(r => r[0] === s && period(r[1]) === pr); cells[s + '|' + pr] = cellStats(t, V.c, b); }));
    const pooled = cellStats(take, V.c, base), best5 = k => { const pn = take.map(r => net(r[V.c], k)).sort((a, b) => b - a).slice(5); return pn.length ? r2(mean(pn)) : null; };
    pooled.dropBest5avg01 = best5(0.01); pooled.dropBest5avg03 = best5(0.03);
    pooled.ci95delta01 = name === 'L0' ? null : bootDelta(base, take, V.c, reps, 27 + vi);
    const blocks = [0, 1, 2, 3].map(k => { const bb = base.filter(r => blockOf(r[1]) === k), tt = take.filter(r => blockOf(r[1]) === k); return tt.length && bb.length ? { n: tt.length, delta01: r2(mean(tt.map(r => net(r[V.c], 0.01))) - mean(bb.map(r => net(r[6], 0.01)))) } : { n: tt.length, delta01: null }; });
    const cs = Object.keys(cells).map(k => cells[k]), crit = {
      c1_delta_ge5_all4cells: cs.every(c => c.delta01 !== undefined && c.delta01 >= 5),
      c2_ci_excludes_zero: !!(pooled.ci95delta01 && pooled.ci95delta01[0] !== null && pooled.ci95delta01[0] > 0),
      c3_positive_after_drop_best5: pooled.dropBest5avg01 !== null && pooled.dropBest5avg01 > 0,
      c4_delta_ge5_all4cells_at_03: cs.every(c => c.delta03 !== undefined && c.delta03 >= 5),
      c5_n_ge100_each_cell: cs.every(c => c.n >= 100)
    };
    crit.pass = name !== 'L0' && Object.keys(crit).every(k => crit[k] === true);
    res[name] = { n: pooled.n, cells, pooled, blocks, crit, absAvg03Positive: pooled.avg03 !== null && pooled.avg03 > 0 };
  });
  // V9 rule (pre-registered): V3 plus the better of V6/V7, only if both V3 and that filter pass alone. V9a/V9b are both computed and logged; only the rule-selected one is reported as V9.
  const elig = [['V6', 'V9a'], ['V7', 'V9b']].filter(([f]) => res.V3.crit.pass && res[f].crit.pass).map(([f, v]) => ({ filter: f, v9: v, delta: res[f].pooled.delta01 })).sort((a, b) => b.delta - a.delta);
  const sel = elig[0] || null; res.V9 = sel ? { selected: sel.v9, filter: sel.filter, same_as: sel.v9 } : { selected: null, note: 'V9 not run: V3 and the V6/V7 filter must both pass alone (see crit of V3, V6, V7)' };
  return res;
}
// Plain-language per-variant verdict lines (facts only; any replacement stays James's decision).
function verdict(res) {
  const L = []; Object.keys(res).forEach(k => { if (k === 'V9') { L.push('V9: ' + (res.V9.selected ? 'selected ' + res.V9.selected + ' (V3 + ' + res.V9.filter + ')' : res.V9.note)); return; } const v = res[k]; if (k === 'L0') { L.push('L0 (live rules incl. -50% premium stop): pooled avg $' + v.pooled.avg01 + ' at $0.01, $' + v.pooled.avg03 + ' at $0.03 per leg, n=' + v.n); return; } L.push(k + ': ' + (v.crit.pass ? 'PASSES all five replacement criteria' : 'fails ' + Object.keys(v.crit).filter(c => c !== 'pass' && !v.crit[c]).join(', ')) + '; pooled delta vs L0 $' + v.pooled.delta01 + ' (95% ' + JSON.stringify(v.pooled.ci95delta01) + '), n=' + v.n + '; absolute avg at $0.03: $' + v.pooled.avg03); });
  return L;
}

module.exports = async function studyOrbExit(ap, kset, opts) {
  opts = opts || {}; const kget = opts.kget;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt27', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, cuts: {}, rows: [] }, last = {};
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  try { if (kget) { const pp = await kget(KEY + 'p'); if (pp && Array.isArray(pp.rows)) { out.rows = pp.rows; out.skipped = pp.skipped || {}; Object.assign(last, pp.last || {}); out.resumed = true; } } } catch (e) {}
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, skipped: out.skipped, last, rows: out.rows, at: iso(Date.now()) }); } catch (e) {} };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  const END = opts.to || '2026-11-12T00:00:00Z';
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: END, feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570 && days[d][1].min === 575 && days[d][2].min === 580);
    const pctOf = D => { const B = days[D], h = Math.max(B[0].h, B[1].h, B[2].h), l = Math.min(B[0].l, B[1].l, B[2].l); return (h - l) / B[0].o * 100; };
    const tr = dayList.filter(d => d < '2026-01-01').map(pctOf).sort((a, b) => a - b);
    out.cuts[SYM] = tr.length ? { p90: Math.round(tr[Math.floor(tr.length * 0.9)] * 1000) / 1000 } : null;
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      if (last[SYM] && D <= last[SYM]) continue;
      const B = days[D], orH = Math.max(B[0].h, B[1].h, B[2].h), orL = Math.min(B[0].l, B[1].l, B[2].l), ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10);
      try {
        let plan = null;
        for (let k = 3; k + 2 < B.length - 1; k += 3) { if (B[k].min > 900) break; if (B[k + 2].min !== B[k].min + 10) { skip('gap in 15-minute candle'); break; } const c = B[k + 2].c, dir = c > orH ? 1 : c < orL ? -1 : 0; if (dir) { plan = { dir, k1: k + 3 }; break; } }
        if (!plan) skip('no breakout');
        else {
          plan.e = B[plan.k1].o; plan.tIn = B[plan.k1].t; plan.stop0 = plan.dir > 0 ? orL : orH; plan.R = Math.abs(plan.e - plan.stop0);
          plan.s = SYM + ymd + (plan.dir > 0 ? 'C' : 'P') + String(Math.round(plan.e) * 1000).padStart(8, '0');
          const ob = await optBars([plan.s], plan.tIn - 60000, B[B.length - 1].t + 5 * 60000), t = simTrade(plan, B, ob[plan.s]);
          if (t.skip) skip(t.skip); else out.rows.push([SYM, D, B[plan.k1].min, r2(pctOf(D)), r2(t.pin), t.rsn].concat(t.g.map(r2)));
        }
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); continue; }
      last[SYM] = D; done++; if (done % 60 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await progressSave(); }
    }
  }
  out.progress = 'analysing'; await progressSave();
  out.analysis = analyze(out.rows, out.cuts); out.verdict = verdict(out.analysis);
  // Diagnostics for "why does ORB lose": what the live -50% premium stop does, on the same trades.
  const l0 = out.rows.filter(r => r[6] !== null), ps = l0.filter(r => r[5] === 'premium'), both = ps.filter(r => r[7] !== null), mixOf = k => l0.filter(r => r[5] === k);
  out.diag = { l0n: l0.length, exitMix: ['stop', 'breakeven', 'target', 'time', 'premium'].reduce((o, k) => { const m = mixOf(k); o[k] = { n: m.length, avgGross: r2(mean(m.map(r => r[6]))) }; return o; }, {}), avgEntryPremium: r2(mean(l0.map(r => r[4]))), premiumStops: { n: ps.length, avgGrossWithStop: r2(mean(both.map(r => r[6]))), avgGrossIfNoPremiumStop: r2(mean(both.map(r => r[7]))), shareWinnersIfNoPremiumStop: both.length ? Math.round(100 * both.filter(r => net(r[7], 0.01) > 0).length / both.length) : null } };
  // Control: V1 (no premium stop) must reproduce the saved bt13 cells for e15 / 1.25R / BE 0.5R at $0.01.
  try {
    const b13 = kget ? await kget('bt13') : null, ctl = { ok: null, cells: {} };
    if (b13 && b13.res) { ctl.ok = true; Object.keys(out.analysis.V1.cells).forEach(k => { const [s, pr] = k.split('|'), ref = b13.res[s + '|e15|t1.25|be0.5|' + (pr === 'dev' ? 'train' : 'lock')], mine = out.analysis.V1.cells[k]; const ok = !!ref && Math.abs(ref.n - mine.n) <= 3 && Math.abs(ref.avg - mine.avg01) <= 0.5; ctl.cells[k] = { bt13: ref ? { n: ref.n, avg: ref.avg } : null, bt27: { n: mine.n, avg: mine.avg01 }, ok }; if (!ok) ctl.ok = false; }); }
    out.control = ctl;
  } catch (e) { out.control = { ok: null, error: String(e && e.message || e) }; }
  out.verdictNote = out.control && out.control.ok === true ? 'Control reproduced bt13 (V1 = no premium stop): results usable. Judged at $0.01 per leg, $0.03 shown beside it.' : 'CONTROL NOT VERIFIED against bt13: per the spec, report this plainly and treat every result as unverified.';
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
};
module.exports.simTrade = simTrade; module.exports.analyze = analyze; module.exports.verdict = verdict; module.exports.scan = scan; module.exports.underlying = underlying;
