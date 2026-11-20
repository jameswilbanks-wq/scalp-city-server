/* bt33 (read-only; James approved 2026-11-20: "test away as proposed (and this would not replace our 0DTE. it would be in addition."): CSK MULTI-DAY call-spread study.
   Does selling a $2-wide call spread that expires 1-5 trading days out (short strike 0.45%/0.75%/1.0%/1.5% above price) add something on top of 0DTE CSK? Spec and decision criteria fixed in advance: docs/csk-multiday-study-spec.md.
   NOT TRADING: nothing here places an order or touches a live book. Saved to kv bt33 (resumable rows in bt33p), once.
   Loader and entry logic copied from study_exits.js (bt9 part A): IEX 5-minute bars from 2024-03-01, one entry per symbol per session at the 11:00 ET bar close, real Alpaca option prices, credit 3c-1.80, train = before 2026-01-01.
   Exits: H hold to expiry (settle capped at width); S 3x-credit buy-back on two consecutive same-bar 30-minute reads; D close the session before expiry at the 15:30 bar; SD = S until D else D. $0.01/$0.03 per leg per fill. Control = dte0 0.45% H must reproduce bt9. */
'use strict';
const PCTS = [0.45, 0.75, 1.0, 1.5], DTES = [0, 1, 2, 3, 4, 5], EXITS = ['H', 'S', 'D', 'SD'], WIDTH = 2, TRAIN_END = '2026-01-01', CTRL_LAST = '2026-11-10', HALF = 30 * 60000;
const r2 = x => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100, mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const FILLS = { H: () => 2, S: r => (r[8] ? 4 : 2), D: () => 4, SD: () => 4 };
const GCOL = { H: 6, S: 7, D: 9, SD: 10 }; // row columns holding each exit's gross P&L ($ per spread, before costs)
// rows: [sym, day, 'T'|'L', dte, pctIdx, credit, holdG, sG, sF, dG, sdG, sdF]
function scan(vals, credit, limitEnd) { let prev = false; for (const x of vals) { if (x.end > limitEnd) break; const ok = x.v >= 3 * credit; if (ok && prev) return x; prev = ok; } return null; }
// One spread: credit received, short strike ks, expiry-day close, same-bar 30-minute spread values after entry (vals: [{end, v}] v clamped 0..WIDTH), close time of the session before expiry (tD) and the spread value then (vD).
function evalSpread(a) {
  const settle = Math.min(WIDTH, Math.max(0, a.closeE - a.ks)), holdG = (a.credit - settle) * 100, hit = scan(a.vals, a.credit, Infinity);
  const out = { holdG, sG: hit ? (a.credit - hit.v) * 100 : holdG, sF: hit ? 1 : 0, dG: null, sdG: null, sdF: 0 };
  if (a.dte >= 1) {
    if (a.vD !== null && a.vD !== undefined) out.dG = (a.credit - a.vD) * 100;
    const h2 = a.tD ? scan(a.vals, a.credit, a.tD) : null;
    if (h2) { out.sdG = (a.credit - h2.v) * 100; out.sdF = 1; } else out.sdG = out.dG;
  }
  return out;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const net = (g, fills, c) => g - 100 * c * fills;
// days: { SYM: [[day, 'T'|'L'], ...] } = every session in the window; opts.b9 = the stored bt9 object for the control; opts.reps = bootstrap resamples
function analyze(rows, days, opts) {
  opts = opts || {}; const reps = opts.reps || 4000, res = {}, cells = {};
  Object.keys(days).sort().forEach((sym, si) => {
    const D = days[sym], didx = {}; D.forEach(([d], i) => { didx[d] = i; });
    const nS = { T: D.filter(x => x[1] === 'T').length, L: D.filter(x => x[1] === 'L').length };
    DTES.forEach(dte => PCTS.forEach((pc, pi) => EXITS.forEach(ex => {
      if (dte === 0 && (ex === 'D' || ex === 'SD')) return;
      const T = rows.filter(r => r[0] === sym && r[3] === dte && r[4] === pi && r[GCOL[ex]] !== null && r[GCOL[ex]] !== undefined), c = { sym, dte, pct: pc, exit: ex, n: T.length };
      const P1 = T.map(r => net(r[GCOL[ex]], FILLS[ex](r), 0.01)), P3 = T.map(r => net(r[GCOL[ex]], FILLS[ex](r), 0.03));
      ['T', 'L'].forEach(sp => { const ix = T.map((r, i) => r[2] === sp ? i : -1).filter(i => i >= 0), p1 = ix.map(i => P1[i]); c[sp] = { n: ix.length, avg01: r2(mean(p1)), avgDay01: p1.length ? r2(p1.reduce((s, v) => s + v, 0) / nS[sp]) : 0 }; });
      c.avg01 = r2(mean(P1)); c.avg03 = r2(mean(P3)); c.win = P1.length ? Math.round(100 * P1.filter(x => x > 0).length / P1.length) : null; c.worst = P1.length ? r2(Math.min(...P1)) : null;
      const srt = P1.slice().sort((a, b) => a - b), k5 = Math.max(1, Math.ceil(srt.length * 0.05)); c.worst5pct = srt.length ? r2(mean(srt.slice(0, k5))) : null; c.credit = T.length ? r2(mean(T.map(r => r[5])) * 100) : null;
      c._sum = new Array(D.length).fill(0); c._cnt = new Array(D.length).fill(0); T.forEach((r, i) => { const j = didx[r[1]]; if (j !== undefined) { c._sum[j] += P1[i]; c._cnt[j]++; } });
      cells[sym + '|' + dte + '|' + pi + '|' + ex] = c;
    })));
    // criteria
    Object.keys(cells).filter(k => cells[k].sym === sym).forEach(k => {
      const c = cells[k], cr = { c1_avg01_ge3_train_and_lock: c.n > 0 && c.T.avg01 !== null && c.L.avg01 !== null && c.T.avg01 >= 3 && c.L.avg01 >= 3, c2_avg03_positive: c.avg03 !== null && c.avg03 > 0,
        c4_n_ge100_train_and_lock: c.T.n >= 100 && c.L.n >= 100, c5_lock_avgDay01_ge3: c.L.avgDay01 >= 3 };
      const pre = cr.c1_avg01_ge3_train_and_lock && cr.c2_avg03_positive && cr.c4_n_ge100_train_and_lock && cr.c5_lock_avgDay01_ge3;
      if (pre) { const rnd = rng(33 + si * 1000 + k.length), ms = []; for (let b = 0; b < reps; b++) { let s = 0, n = 0; for (let i = 0; i < D.length; i++) { const j = (rnd() * D.length) | 0; s += c._sum[j]; n += c._cnt[j]; } ms.push(n ? s / n : 0); } ms.sort((a, b) => a - b); c.ci99 = [r2(ms[Math.floor(reps * 0.005)]), r2(ms[Math.ceil(reps * 0.995) - 1])]; cr.c3_ci99_lower_gt0 = c.ci99[0] > 0; } else cr.c3_ci99_lower_gt0 = false;
      c.crit = cr;
    });
    Object.keys(cells).filter(k => cells[k].sym === sym).forEach(k => { // plateau: a neighbouring cell (adjacent strike distance same dte, or adjacent dte same strike distance, same exit) also positive overall
      const c = cells[k], pi = PCTS.indexOf(c.pct), nb = [[c.dte, pi - 1], [c.dte, pi + 1], [c.dte - 1, pi], [c.dte + 1, pi]].map(([d2, p2]) => cells[sym + '|' + d2 + '|' + p2 + '|' + c.exit]).filter(Boolean);
      c.crit.c6_plateau_neighbour_positive = nb.some(x => x.n >= 30 && x.avg01 > 0); c.crit.pass = Object.keys(c.crit).every(q => q === 'pass' || c.crit[q] === true);
    });
  });
  Object.keys(cells).forEach(k => { delete cells[k]._sum; delete cells[k]._cnt; });
  Object.keys(days).forEach(sym => { res[sym] = { cells: {}, candidates: [] }; });
  Object.keys(cells).forEach(k => { const c = cells[k]; res[c.sym].cells[k.split('|').slice(1).join('|')] = c; if (c.crit.pass) res[c.sym].candidates.push(k.split('|').slice(1).join('|')); });
  // control: dte0 0.45% H restricted to sessions up to CTRL_LAST vs bt9
  const ctl = { ok: null, cells: {} };
  if (opts.b9 && opts.b9.res) { ctl.ok = true; Object.keys(days).forEach(sym => { ['T', 'L'].forEach(sp => {
    const T = rows.filter(r => r[0] === sym && r[3] === 0 && r[4] === 0 && r[2] === sp && r[1] <= CTRL_LAST), mine = { n: T.length, avg: r2(mean(T.map(r => net(r[6], 2, 0.01)))) }, ref = opts.b9.res['A|' + sym + '|hold|' + (sp === 'T' ? 'train' : 'lock')];
    const ok = !!ref && Math.abs(ref.n - mine.n) <= 0.02 * ref.n && mine.avg !== null && Math.abs(ref.avg - mine.avg) <= 0.5; ctl.cells[sym + '|' + (sp === 'T' ? 'train' : 'lock')] = { bt9: ref ? { n: ref.n, avg: ref.avg } : null, bt33: mine, ok }; if (!ok) ctl.ok = false; }); }); }
  return { res, control: ctl };
}
function verdict(an) {
  const L = [], ctl = an.control; L.push('control vs bt9 (dte0, 0.45%, hold): ' + (ctl.ok === true ? 'REPRODUCED' : ctl.ok === false ? 'NOT reproduced' : 'not checked') + ' ' + JSON.stringify(ctl.cells));
  Object.keys(an.res).forEach(sym => { const R = an.res[sym], all = Object.keys(R.cells).map(k => [k, R.cells[k]]).filter(x => x[1].n >= 100);
    L.push(sym + ' replacement/forward-paper candidates (all six criteria): ' + (R.candidates.length ? R.candidates.join(', ') : 'none'));
    all.sort((a, b) => b[1].avg01 - a[1].avg01).slice(0, 8).forEach(([k, c]) => L.push(sym + ' top by avg: ' + k + ' n=' + c.n + ' $' + c.avg01 + '/spread at $0.01 ($' + c.avg03 + ' at $0.03), train $' + c.T.avg01 + ' lock $' + c.L.avg01 + ', win ' + c.win + '%, worst $' + c.worst + (c.crit.pass ? ' PASSES' : ' fails ' + Object.keys(c.crit).filter(q => q !== 'pass' && !c.crit[q]).join(',')))); });
  return L;
}

module.exports = async function studyCskMultiday(ap, rh, Engine, kset, opts) {
  opts = opts || {}; const kget = opts.kget;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const todayET = et(Date.now()).day, KEY = opts.key || 'bt33', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, rows: [], days: {} }, last = {};
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  try { if (kget) { const pp = await kget(KEY + 'p'); if (pp && Array.isArray(pp.rows)) { out.rows = pp.rows; out.skipped = pp.skipped || {}; Object.assign(last, pp.last || {}); out.resumed = true; } } } catch (e) {}
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, skipped: out.skipped, last, rows: out.rows, at: iso(Date.now()) }); } catch (e) {} };
  const optBars = async (syms, start, end, tf) => { const m = {}; let pt; for (let i = 0; i < syms.length; i += 90) { do { const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: tf, start: iso(start), end: iso(end), limit: 10000, page_token: pt }); Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), c: b.c }))); }); pt = d.next_page_token; await sleep(gap); } while (pt); pt = undefined; } return m; };
  const idx = arr => { const m = new Map(); (arr || []).forEach(b => m.set(b.t, b.c)); return m; };
  const pxAt = (arr, t, maxAgeMin) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAgeMin * 60000 ? arr[a].c : null; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10), clamp = v => Math.min(WIDTH, Math.max(0, v));
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      const dayBars = {}; let tok; out.progress = SYM + ' loading underlying'; await progressSave();
      do { const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
        (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (dayBars[e.day] = dayBars[e.day] || []).push({ t, min: e.min, c: b.c }); }); tok = d.next_page_token; await sleep(gap); } while (tok);
      const dayList = Object.keys(dayBars).sort().filter(d => dayBars[d].length >= 70 && dayBars[d][0].min === 570 && d < todayET), split = d => d < TRAIN_END ? 'T' : 'L';
      out.days[SYM] = dayList.map(d => [d, split(d)]); out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
      let done = 0;
      for (let i = 0; i < dayList.length; i++) {
        const D = dayList[i]; if (last[SYM] && D <= last[SYM]) continue;
        try {
          const B = dayBars[D], b = B.find(x => x.min === 655); if (!b) { skip('no 11:00 bar'); last[SYM] = D; continue; }
          const p = b.c, tT = b.t + 5 * 60000, legs = [], syms = new Set();
          DTES.forEach(dte => { const E = dayList[i + dte]; if (!E) { skip('dte' + dte + ' no expiry session'); return; } PCTS.forEach((pc, pi) => { const ks = Math.round(p * (1 + pc / 100)), kl = ks + WIDTH; if (!(ks > p)) { skip('strike not above price'); return; }
            const S = SYM + ymdOf(E) + 'C' + String(ks * 1000).padStart(8, '0'), L = SYM + ymdOf(E) + 'C' + String(kl * 1000).padStart(8, '0'); legs.push({ dte, pi, ks, E, S, L }); syms.add(S); syms.add(L); }); });
          if (!legs.length) { last[SYM] = D; continue; }
          const lastE = legs.reduce((m, g) => g.E > m ? g.E : m, D), ob1 = await optBars([...syms], tT - 6 * 60000, tT + 60000, '1Min'), ob30 = await optBars([...syms], tT, Date.parse(lastE + 'T21:05:00Z'), '30Min');
          for (const g of legs) {
            const s0 = pxAt(ob1[g.S], tT, 5), l0 = pxAt(ob1[g.L], tT, 5); if (s0 === null || l0 === null) { skip('dte' + g.dte + ' no price at entry'); continue; }
            const credit = s0 - l0; if (!(credit >= 0.03 && credit <= 1.8)) { skip('dte' + g.dte + ' credit out of range'); continue; }
            const eb = dayBars[g.E], closeE = eb[eb.length - 1].c, tEndE = eb[eb.length - 1].t + 5 * 60000, iS = idx(ob30[g.S]), iL = idx(ob30[g.L]), vals = [];
            [...iS.keys()].sort((a, c) => a - c).forEach(t => { if (iL.has(t) && t >= tT && t + HALF < tEndE) vals.push({ end: t + HALF, v: clamp(iS.get(t) - iL.get(t)) }); });
            let tD = null, vD = null; if (g.dte >= 1) { const pb = dayBars[dayList[i + g.dte - 1]]; tD = pb[pb.length - 1].t + 5 * 60000; const a1 = pxAt(ob30[g.S], tD - HALF, 180), a2 = pxAt(ob30[g.L], tD - HALF, 180); if (a1 !== null && a2 !== null) vD = clamp(a1 - a2); }
            const ev = evalSpread({ credit, ks: g.ks, closeE, vals, tD, vD, dte: g.dte }), q = x => x === null ? null : Math.round(x * 100) / 100;
            out.rows.push([SYM, D, split(D), g.dte, g.pi, Math.round(credit * 1000) / 1000, q(ev.holdG), q(ev.sG), ev.sF, q(ev.dG), q(ev.sdG), ev.sdF]);
          }
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); continue; }
        last[SYM] = D; done++; if (done % 40 === 0) { out.progress = SYM + ' ' + (i + 1) + ' of ' + dayList.length + ' sessions'; await progressSave(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'analysing'; await progressSave();
  let b9 = null; try { b9 = kget ? await kget('bt9') : null; } catch (e) {}
  const an = analyze(out.rows, out.days, { b9 }); out.analysis = an.res; out.control = an.control; out.verdict = verdict(an);
  out.verdictNote = an.control.ok === true ? 'Control (dte0 0.45% hold) reproduced bt9 within tolerance: results usable. Judged at $0.01 per leg per fill with $0.03 stress; candidates are forward-paper candidates only, in addition to 0DTE CSK.' : 'CONTROL NOT VERIFIED against bt9: per the spec, report this plainly and treat every result as unverified.';
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
};
Object.assign(module.exports, { evalSpread, analyze, verdict, scan, PCTS, DTES, EXITS });
