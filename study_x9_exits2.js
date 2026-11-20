/* bt31 (read-only; James approved 2026-11-20: "build the study"): X9 exit study v2 -- trail settings, trail on QQQ, target+trail hybrids and a breakeven lock, against the CURRENT live rules (QQQ flat +70% take-profit, SPY trail arm 25%/keep 50%).
   Spec and decision criteria fixed in advance: docs/x9-exit-study-spec.md. NOT TRADING: nothing here places an order or touches a live book. Saved to kv bt31 (resumable rows in bt31p), once.
   Setup is study_x9_exits.js (bt22) unchanged: Robinhood 1-minute bars -> 5-minute candles, Engine.x9Signals entries, real 1-minute option prices walked minute by minute, -30% premium stop, level/reverse/eod exits,
   $0.01 per fill each way ($0.03 also reported), train = first 2/3 of sessions, lock = last 1/3. All variants trade the same entries. */
'use strict';
const VARS = [
  { id: 'C0', rule: {} }, { id: 'C1', rule: { tp: 70 } }, { id: 'C2', rule: { trail: { arm: 25, give: 0.5 } } },
  { id: 'T1', rule: { trail: { arm: 40, give: 0.5 } } }, { id: 'T2', rule: { trail: { arm: 15, give: 0.5 } } }, { id: 'T3', rule: { trail: { arm: 25, give: 0.33 } } }, { id: 'T4', rule: { trail: { arm: 25, give: 0.65 } } },
  { id: 'H1', rule: { tp: 70, trail: { arm: 25, give: 0.5 } } }, { id: 'H2', rule: { tp: 100, trail: { arm: 25, give: 0.5 } } }, { id: 'H3', rule: { tp: 70, trail: { arm: 40, give: 0.5 } } },
  { id: 'B1', rule: { lock: { arm: 30, to: 0 } } }, { id: 'B2', rule: { tp: 70, lock: { arm: 30, to: 0 } } }
];
const CUR = { QQQ: 'C1', SPY: 'C2' }, STOP_PCT = 30, PEAK_MIN = 40, SPLITS = ['train', 'lock'], COSTS = [0.01, 0.03];
const ids = VARS.map(v => v.id), colOf = id => 6 + ids.indexOf(id); // rows: [sym, day, split, pin, baseWhy, pkPct, g_C0 ... g_B2]

function pxAt(arr, t, maxAge) { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; }
function sellAt(arr, t) { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); }
// Walk the option premium minute by minute from the fill to the rule exit time xt (as bt22): stop first, then flat target, then lock/trail. Returns the exit price, reason, the highest % reached and the exit time.
function walk(arr, pin, tFill, xt, baseWhy, rule) {
  let peak = -Infinity, hi = -Infinity, locked = false; rule = rule || {};
  for (let t = tFill + 60000; t < xt; t += 60000) {
    const v = pxAt(arr, t, 2); if (v === null) continue; const pct = (v / pin - 1) * 100; if (pct > hi) hi = pct;
    if (locked && pct <= rule.lock.to) return { pout: v, why: 'lock', pk: hi, t };
    if (pct <= -STOP_PCT) return { pout: v, why: 'premium stop', pk: hi, t };
    if (rule.tp !== undefined && pct >= rule.tp) return { pout: v, why: 'target', pk: hi, t };
    if (rule.trail) { if (pct > peak) peak = pct; if (peak >= rule.trail.arm && pct <= peak * (1 - rule.trail.give)) return { pout: v, why: 'trail', pk: hi, t }; }
    if (rule.lock && !locked && pct >= rule.lock.arm) locked = true;
  }
  return { pout: sellAt(arr, xt), why: baseWhy, pk: hi, t: xt };
}

// ---- statistics ----
const r2 = x => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100, mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null, net = (g, c) => g - 200 * c;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function stats(rs, col) {
  const o = { n: rs.length }; if (!rs.length) return o;
  COSTS.forEach(c => { const k = c === 0.01 ? '01' : '03', pn = rs.map(r => net(r[col], c)), gw = pn.filter(x => x > 0).reduce((s, v) => s + v, 0), gl = -pn.filter(x => x <= 0).reduce((s, v) => s + v, 0); o['avg' + k] = r2(mean(pn)); o['win' + k] = Math.round(100 * pn.filter(x => x > 0).length / pn.length); o['pf' + k] = gl > 0.01 ? r2(gw / gl) : null; });
  const gs = rs.map(r => r[col]); o.best = Math.round(Math.max(...gs)); o.worst = Math.round(Math.min(...gs)); return o;
}
const dropBest5 = (rs, col) => { const pn = rs.map(r => net(r[col], 0.01)).sort((a, b) => b - a).slice(5); return pn.length ? mean(pn) : null; };
function bootDelta(rs, col, cc, reps, seed) {
  const days = {}; rs.forEach(r => { const d = days[r[1]] = days[r[1]] || [0, 0]; d[0] += r[col] - r[cc]; d[1]++; });
  const L = Object.keys(days).map(k => days[k]), rnd = rng(seed), out = [];
  for (let b = 0; b < reps; b++) { let s = 0, n = 0; for (let i = 0; i < L.length; i++) { const d = L[(rnd() * L.length) | 0]; s += d[0]; n += d[1]; } if (n) out.push(s / n); }
  out.sort((a, b) => a - b); return out.length ? [r2(out[Math.floor(out.length * 0.0025)]), r2(out[Math.ceil(out.length * 0.9975) - 1])] : [null, null];
}
function analyze(rows, opts) {
  opts = opts || {}; const reps = opts.reps || 4000, res = {};
  [...new Set(rows.map(r => r[0]))].sort().forEach((sym, si) => {
    const R = rows.filter(r => r[0] === sym), cc = colOf(CUR[sym]); res[sym] = { reference: CUR[sym], variants: {} };
    ids.forEach((id, vi) => {
      const c = colOf(id), P = R.filter(r => r[c] !== null && r[cc] !== null), v = { all: stats(P, c) }, delta = {};
      SPLITS.forEach(sp => { const Q = P.filter(r => r[2] === sp); v[sp] = stats(Q, c); delta[sp] = Q.length ? r2(mean(Q.map(r => r[c] - r[cc]))) : null; });
      delta.all = P.length ? r2(mean(P.map(r => r[c] - r[cc]))) : null; v.delta = delta;
      v.ci995 = id === CUR[sym] ? null : bootDelta(P, c, cc, reps, 31 + si * 100 + vi);
      const dv = dropBest5(P, c), dr = dropBest5(P, cc); v.dropBest5 = { variant: r2(dv), reference: r2(dr) };
      const pk = P.filter(r => r[5] >= PEAK_MIN); v.peaked = { n: pk.length, avg01: pk.length ? r2(mean(pk.map(r => net(r[c], 0.01)))) : null, sharePositive: pk.length ? Math.round(100 * pk.filter(r => net(r[c], 0.01) > 0).length / pk.length) : null };
      const crit = { c1_delta_ge3_train_and_lock: delta.train !== null && delta.lock !== null && delta.train >= 3 && delta.lock >= 3, c2_ci995_excludes_zero: !!(v.ci995 && v.ci995[0] !== null && v.ci995[0] > 0), c3_dropBest5_beats_reference: dv !== null && dr !== null && dv > dr, c4_abs_avg_at_0_03_positive: v.all.avg03 !== undefined && v.all.avg03 > 0, c5_n_ge100_train_and_lock: v.train.n >= 100 && v.lock.n >= 100 };
      crit.pass = id !== CUR[sym] && Object.keys(crit).every(k => crit[k] === true); v.crit = crit; res[sym].variants[id] = v;
    });
    res[sym].candidates = ids.filter(id => res[sym].variants[id].crit.pass);
  });
  return res;
}
function verdict(res) {
  const L = []; Object.keys(res).forEach(sym => { const R = res[sym], ref = R.variants[R.reference];
    L.push(sym + ' reference ' + R.reference + ': n=' + ref.all.n + ', avg $' + ref.all.avg01 + ' at $0.01, $' + ref.all.avg03 + ' at $0.03; trades that peaked >= +' + PEAK_MIN + '%: n=' + ref.peaked.n + ', avg $' + ref.peaked.avg01 + ', ' + ref.peaked.sharePositive + '% positive');
    ids.forEach(id => { if (id === R.reference) return; const v = R.variants[id]; L.push(sym + ' ' + id + ': ' + (v.crit.pass ? 'PASSES all five criteria' : 'fails ' + Object.keys(v.crit).filter(k => k !== 'pass' && !v.crit[k]).join(', ')) + '; delta vs ' + R.reference + ' $' + v.delta.all + ' (train ' + v.delta.train + ', lock ' + v.delta.lock + ', 99.5% ' + JSON.stringify(v.ci995) + '); abs avg $' + v.all.avg01 + ' / $' + v.all.avg03 + ' at $0.03; peaked subset avg $' + v.peaked.avg01 + ' (' + v.peaked.sharePositive + '% pos)'); });
    L.push(sym + ' replacement candidates: ' + (R.candidates.length ? R.candidates.join(', ') : 'none (current rule stays)')); });
  return L;
}

module.exports = async function studyX9Exits2(ap, rh, Engine, kset, opts) {
  opts = opts || {}; const kget = opts.kget;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const KEY = opts.key || 'bt31', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, rows: [] }, last = {}; let now = opts.now || Date.now(); const days = opts.days || 365;
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  try { if (kget) { const pp = await kget(KEY + 'p'); if (pp && Array.isArray(pp.rows)) { out.rows = pp.rows; out.skipped = pp.skipped || {}; Object.assign(last, pp.last || {}); if (pp.now) now = pp.now; out.resumed = true; } } } catch (e) {}
  out.now = now;
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, skipped: out.skipped, last, now, rows: out.rows, at: iso(Date.now()) }); } catch (e) {} };
  const optBars = async (syms, start, end) => { const m = {}; let pt; for (let i = 0; i < syms.length; i += 90) { do { const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt }); Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); }); pt = d.next_page_token; await sleep(gap); } while (pt); } return m; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const agg5 = raw => { const o = [], by = {}; raw.forEach(x => { const t = Date.parse(x.begins_at), k = Math.floor(t / 300000) * 300000; (by[k] = by[k] || []).push(x); }); Object.keys(by).sort((a, b) => a - b).forEach(k => { const g = by[k]; o.push({ begins_at: iso(+k), open_price: g[0].open_price, high_price: Math.max(...g.map(x => +x.high_price)), low_price: Math.min(...g.map(x => +x.low_price)), close_price: g[g.length - 1].close_price, volume: g.reduce((s, x) => s + (+x.volume || 0), 0) }); }); return o; };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await progressSave();
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) { const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' }); (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; }); }
      const raw = Object.keys(st).sort((a, b) => a - b).map(k => st[k]), bars = Engine.prepare(agg5(raw), { partial: true }); Engine.simulate(bars, {}, true);
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
      out.n[SYM] = { sessions: dayList.length, signals: list.length, first: dayList[0], last: dayList[dayList.length - 1] };
      const byDay = {}; list.forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });
      const D0 = Object.keys(byDay).sort(); let done = 0;
      for (const D of D0) {
        if (last[SYM] && D <= last[SYM]) continue;
        try {
          const todays = byDay[D], first = Math.min(...todays.map(p => p.tIn)), ob = await optBars([...new Set(todays.map(p => p.s))], first - 60000, Date.parse(D + 'T21:05:00Z'));
          todays.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip(SYM + ' no option price'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.tIn + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip(SYM + ' no usable entry price'); return; }
            const rs = VARS.map(v => walk(arr, pin, tFill, p.xt, p.why, v.rule)), gs = rs.map(r => r.pout === null ? null : r2((r.pout - pin) * 100));
            if (gs.some(g => g === null)) skip(SYM + ' no exit price for some variant (kept, that variant excluded)');
            out.rows.push([SYM, D, split[D], r2(pin), p.why, r2(rs[0].pk)].concat(gs));
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); continue; }
        last[SYM] = D; done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + D0.length + ' days'; await progressSave(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'analysing'; await progressSave();
  out.variants = VARS.map(v => ({ id: v.id, rule: v.rule })); out.analysis = analyze(out.rows); out.verdict = verdict(out.analysis);
  try { // control: C0/C1/C2 versus the saved bt22 cells (window is one week newer, so tolerance: count within 5%, average within $3)
    const b22 = kget ? await kget('bt22') : null, ctl = { ok: null, cells: {} };
    if (b22 && b22.res) { ctl.ok = true; Object.keys(out.analysis).forEach(sym => [['C0', 'baseline'], ['C1', 'tp70'], ['C2', 'trail']].forEach(([id, nm]) => { const ref = b22.res[sym + '|' + nm + '|ALL'], mine = out.analysis[sym].variants[id].all; const ok = !!ref && Math.abs(ref.n - mine.n) <= 0.05 * ref.n && Math.abs(ref.avg - mine.avg01) <= 3; ctl.cells[sym + '|' + id] = { bt22: ref ? { n: ref.n, avg: ref.avg } : null, bt31: { n: mine.n, avg: mine.avg01 }, ok }; if (!ok) ctl.ok = false; })); }
    out.control = ctl;
  } catch (e) { out.control = { ok: null, error: String(e && e.message || e) }; }
  out.verdictNote = out.control && out.control.ok === true ? 'Control reproduced bt22 within tolerance (window one week newer): results usable. Judged at $0.01 per fill with $0.03 stress.' : 'CONTROL NOT VERIFIED against bt22: per the spec, report this plainly and treat every result as unverified.';
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
};
module.exports.walk = walk; module.exports.analyze = analyze; module.exports.verdict = verdict; module.exports.VARS = VARS;
