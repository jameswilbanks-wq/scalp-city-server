/* bt35 (read-only; James approved 2026-11-25: "yes, do your read only study"): CSK DOWNSIDE-PROTECTION study. Would a lower stop multiple, a dollar-loss cap, an underlying-price stop or an up-morning entry filter beat the live 3x-credit stop on the 0DTE call spreads?
   Spec and decision criteria fixed in advance: docs/csk-downside-study-spec.md. NOT TRADING: nothing here places an order or touches a live book; it only READS Alpaca market data and writes kv bt35 (partial rows in bt35p, resumable), once.
   Loader and entry logic copied from study_csk_multiday.js (bt33) / study_exits.js (bt9 part A): IEX 5-minute underlying bars from 2024-03-01, one entry per symbol per session at the 11:00 ET bar close (the 10:55 bar), short strike = round(price x 1.0045), $2 wide, credit 3c-1.80, real Alpaca option prices, train = before 2026-01-01.
   New: option bars at 5-minute resolution; every row keeps its whole path [minute, spread value, underlying close] so a variant can be re-scored later without a refetch. */
'use strict';
const WIDTH = 2, TRAIN_END = '2026-01-01', CTRL_LAST = '2026-11-10', BAR = 5 * 60000, PCT = 0.45;
const VARS = ['H', 'M3', 'M25', 'M2', 'M15', 'L75', 'L100', 'U0', 'U1', 'U2', 'F5', 'F75', 'F100', 'F3'];
const MULT = { M3: 3, M25: 2.5, M2: 2, M15: 1.5 }, LOSS = { L75: 0.75, L100: 1.0 }, UDIST = { U0: 0, U1: 0.001, U2: 0.002 }, FILT = { F5: 0.5, F75: 0.75, F100: 1.0 };
const NEIGH = { M15: ['M2'], M2: ['M15', 'M25'], M25: ['M2', 'M3'], M3: ['M25'], L75: ['L100'], L100: ['L75'], U0: ['U1'], U1: ['U0', 'U2'], U2: ['U1'], F5: ['F75'], F75: ['F5', 'F100'], F100: ['F75'], F3: ['F75'] };
const r2 = x => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100, mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// One spread under one variant. r = { credit, ks, closeU, openU, entryU, path: [[minute, spreadValue, underlyingClose], ...] } (bars after entry, in time order).
// Returns { g: gross dollars per spread before costs (null = entry skipped), fills: leg-fills (2 to open, 2 more to buy back), fired, holdG }.
function simulate(r, id) {
  const settle = Math.min(WIDTH, Math.max(0, r.closeU - r.ks)), holdG = (r.credit - settle) * 100, held = { g: holdG, fills: 2, fired: false, holdG };
  if (id === 'H') return held;
  const fl = FILT[id] !== undefined ? FILT[id] : id === 'F3' ? 0.75 : null;
  if (fl !== null && r.openU > 0 && (r.entryU / r.openU - 1) * 100 >= fl) return { g: null, fills: 0, fired: false, holdG, skipped: true };
  if (FILT[id] !== undefined) return held;
  let test, two = true;
  if (MULT[id] !== undefined || id === 'F3') { const m = id === 'F3' ? 3 : MULT[id]; test = (v) => v >= m * r.credit - 1e-9; }
  else if (LOSS[id] !== undefined) test = (v) => v >= r.credit + LOSS[id] - 1e-9;
  else if (UDIST[id] !== undefined) { two = false; test = (v, u) => u >= r.ks * (1 - UDIST[id]) - 1e-9; }
  else throw new Error('unknown variant ' + id);
  let prev = false;
  for (const [, v, u] of r.path) { const ok = test(v, u); if (ok && (!two || prev)) return { g: (r.credit - v) * 100, fills: 4, fired: true, holdG }; prev = ok; }
  return held;
}
// rows: [sym, day, 'T'|'L', credit, ks, closeU, openU, entryU, path]; days: { SYM: [[day, 'T'|'L'], ...] } = every session in the window; opts.b9 = stored bt9 for the control; opts.reps = bootstrap resamples
function analyze(rows, days, opts) {
  opts = opts || {}; const reps = opts.reps || 4000, res = {}, ctl = { ok: null, cells: {} };
  Object.keys(days).sort().forEach((sym, si) => {
    const D = days[sym], idx = {}; D.forEach(([d], i) => { idx[d] = i; });
    const R = rows.filter(r => r[0] === sym).map(r => ({ day: r[1], sp: r[2], credit: r[3], ks: r[4], closeU: r[5], openU: r[6], entryU: r[7], path: r[8] || [] })).filter(r => idx[r.day] !== undefined);
    const up = new Array(D.length).fill(null); R.forEach(r => { up[idx[r.day]] = r.closeU > r.entryU; });
    const cells = {}, per = {};
    VARS.forEach(id => {
      const n01 = new Array(D.length).fill(0), n03 = new Array(D.length).fill(0), tr = new Array(D.length).fill(false); let fired = 0, rec = 0, skipped = 0, traded = 0;
      R.forEach(r => { const j = idx[r.day], s = simulate(r, id); if (s.g === null) { skipped++; return; } traded++; tr[j] = true; n01[j] = s.g - 100 * 0.01 * s.fills; n03[j] = s.g - 100 * 0.03 * s.fills; if (s.fired) { fired++; if (s.holdG > 0) rec++; } });
      per[id] = n01;
      const stat = sp => { const ix = D.map((x, i) => i).filter(i => !sp || D[i][1] === sp), v = ix.map(i => n01[i]), srt = v.slice().sort((a, b) => a - b), k5 = Math.max(1, Math.ceil(v.length * 0.05)), t = ix.filter(i => tr[i]);
        const sub = f => { const q = ix.filter(i => f(i)); return { sessions: q.length, avgDay: q.length ? r2(q.reduce((s, i) => s + n01[i], 0) / q.length) : null }; };
        return { sessions: v.length, traded: t.length, avgDay: r2(mean(v)), avgDay03: r2(mean(ix.map(i => n03[i]))), worst5: r2(mean(srt.slice(0, k5))), worstDay: r2(srt[0]), win: t.length ? Math.round(100 * t.filter(i => n01[i] > 0).length / t.length) : null, upDays: sub(i => up[i] === true), otherDays: sub(i => up[i] === false) }; };
      cells[id] = { id, all: stat(null), T: stat('T'), L: stat('L'), fired, stopFirePct: traded ? Math.round(100 * fired / traded) : null, recoveredPct: fired ? Math.round(100 * rec / fired) : null, skipped, traded };
    });
    // criteria against the M3 control (spec section 6)
    const M = cells.M3, rnd = rng(35 + si * 1000);
    VARS.filter(id => id !== 'H' && id !== 'M3').forEach(id => {
      const c = cells[id], diff = per[id].map((x, i) => x - per.M3[i]), ms = [];
      for (let b = 0; b < reps; b++) { let s = 0; for (let i = 0; i < diff.length; i++) s += diff[(rnd() * diff.length) | 0]; ms.push(s / diff.length); } ms.sort((a, b) => a - b);
      c.diffCI99 = [r2(ms[Math.floor(reps * 0.005)]), r2(ms[Math.min(reps - 1, Math.floor(reps * 0.995))])];
      const atLeast = (v, m) => v !== null && m !== null && v >= m - 0.1 * Math.abs(m) - 1e-9, better5 = (v, m) => m < 0 ? (v - m) / Math.abs(m) >= 0.15 - 1e-9 : v >= m;
      c.crit = { c1_avgDay_ge90pct_of_M3_train_and_lock: atLeast(c.T.avgDay, M.T.avgDay) && atLeast(c.L.avgDay, M.L.avgDay), c2_worst5_better15pct_train_and_lock: better5(c.T.worst5, M.T.worst5) && better5(c.L.worst5, M.L.worst5),
        c3_lock_worstDay_not_worse: c.L.worstDay >= M.L.worstDay, c4_n_ge100_train_and_lock: c.T.traded >= 100 && c.L.traded >= 100, c5_avgDay03_positive: c.all.avgDay03 > 0, c6_diff_ci99_lower_above_minus1_50: c.diffCI99[0] > -1.5 };
    });
    VARS.filter(id => id !== 'H' && id !== 'M3').forEach(id => { const c = cells[id], nb = NEIGH[id].map(k => cells[k]).filter(x => x && x.crit); c.crit.c7_plateau_neighbour_meets_c1_and_c2 = nb.some(x => x.crit.c1_avgDay_ge90pct_of_M3_train_and_lock && x.crit.c2_worst5_better15pct_train_and_lock); c.pass = Object.keys(c.crit).every(q => c.crit[q] === true); });
    res[sym] = { cells, candidates: VARS.filter(id => cells[id].pass) };
    // control: H restricted to sessions up to CTRL_LAST vs bt9 hold (per split)
    if (opts.b9 && opts.b9.res) { if (ctl.ok === null) ctl.ok = true; ['T', 'L'].forEach(sp => { const T = R.filter(r => r.sp === sp && r.day <= CTRL_LAST), g = T.map(r => simulate(r, 'H').g - 2), mine = { n: T.length, avg: r2(mean(g)) }, ref = opts.b9.res['A|' + sym + '|hold|' + (sp === 'T' ? 'train' : 'lock')];
      const ok = !!ref && Math.abs(ref.n - mine.n) <= 0.02 * ref.n && mine.avg !== null && Math.abs(ref.avg - mine.avg) <= 0.5; ctl.cells[sym + '|' + (sp === 'T' ? 'train' : 'lock')] = { bt9: ref ? { n: ref.n, avg: ref.avg } : null, bt35: mine, ok }; if (!ok) ctl.ok = false; }); }
  });
  return { res, control: ctl };
}
function verdict(an) {
  const L = [], ctl = an.control; L.push('control H vs bt9 hold (per symbol and split): ' + (ctl.ok === true ? 'REPRODUCED' : ctl.ok === false ? 'NOT reproduced' : 'not checked') + ' ' + JSON.stringify(ctl.cells));
  Object.keys(an.res).forEach(sym => { const R = an.res[sym];
    L.push(sym + ' forward-paper candidates (all seven criteria vs the M3 control): ' + (R.candidates.length ? R.candidates.join(', ') : 'none'));
    VARS.forEach(id => { const c = R.cells[id]; L.push(sym + ' ' + id + ': per-day avg train $' + c.T.avgDay + ' lock $' + c.L.avgDay + ', worst-5% train $' + c.T.worst5 + ' lock $' + c.L.worst5 + ', worst day lock $' + c.L.worstDay + ', up-days avg $' + c.all.upDays.avgDay + ' other $' + c.all.otherDays.avgDay + ', stops ' + c.stopFirePct + '% (recovered ' + c.recoveredPct + '%), skipped ' + c.skipped + (c.crit ? (c.pass ? ' PASSES' : ' fails ' + Object.keys(c.crit).filter(q => c.crit[q] !== true).join(',')) : ' (control)')); }); });
  return L;
}

module.exports = async function studyCskDownside(ap, rh, Engine, kset, opts) {
  opts = opts || {}; const kget = opts.kget;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const todayET = et(Date.now()).day, KEY = opts.key || 'bt35', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, rows: [], days: {} }, last = {};
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
        (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (dayBars[e.day] = dayBars[e.day] || []).push({ t, min: e.min, c: b.c, o: b.o }); }); tok = d.next_page_token; await sleep(gap); } while (tok);
      const dayList = Object.keys(dayBars).sort().filter(d => dayBars[d].length >= 70 && dayBars[d][0].min === 570 && d < todayET), split = d => d < TRAIN_END ? 'T' : 'L';
      out.days[SYM] = dayList.map(d => [d, split(d)]); out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
      let done = 0;
      for (let i = 0; i < dayList.length; i++) {
        const D = dayList[i]; if (last[SYM] && D <= last[SYM]) continue;
        try {
          const B = dayBars[D], b = B.find(x => x.min === 655); if (!b) { skip('no 11:00 bar'); last[SYM] = D; continue; }
          const p = b.c, tT = b.t + BAR, ks = Math.round(p * (1 + PCT / 100)), kl = ks + WIDTH; if (!(ks > p)) { skip('strike not above price'); last[SYM] = D; continue; }
          const S = SYM + ymdOf(D) + 'C' + String(ks * 1000).padStart(8, '0'), L = SYM + ymdOf(D) + 'C' + String(kl * 1000).padStart(8, '0'), lastBar = B[B.length - 1], tEnd = lastBar.t + BAR;
          const ob1 = await optBars([S, L], tT - 6 * 60000, tT + 60000, '1Min'), s0 = pxAt(ob1[S], tT, 5), l0 = pxAt(ob1[L], tT, 5);
          if (s0 === null || l0 === null) { skip('no price at entry'); last[SYM] = D; continue; }
          const credit = s0 - l0; if (!(credit >= 0.03 && credit <= 1.8)) { skip('credit out of range'); last[SYM] = D; continue; }
          const ob5 = await optBars([S, L], tT, tEnd, '5Min'), iS = idx(ob5[S]), iL = idx(ob5[L]), ub = new Map(B.map(x => [x.t, x.c])), path = [];
          [...iS.keys()].sort((a, c) => a - c).forEach(t => { if (!iL.has(t) || !ub.has(t) || t < tT || t + BAR > tEnd) return; path.push([et(t + BAR).min, Math.round(clamp(iS.get(t) - iL.get(t)) * 1000) / 1000, ub.get(t)]); });
          out.rows.push([SYM, D, split(D), Math.round(credit * 1000) / 1000, ks, lastBar.c, B[0].o, p, path]);
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); continue; }
        last[SYM] = D; done++; if (done % 40 === 0) { out.progress = SYM + ' ' + (i + 1) + ' of ' + dayList.length + ' sessions'; await progressSave(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'analysing'; await progressSave();
  let b9 = null; try { b9 = kget ? await kget('bt9') : null; } catch (e) {}
  const an = analyze(out.rows, out.days, { b9 }); out.analysis = an.res; out.control = an.control; out.verdict = verdict(an);
  out.verdictNote = an.control.ok === true ? 'Control (H, hold) reproduced bt9 within tolerance: results usable. Stops fill at the triggering bar value (optimistic); judged at $0.01 per leg per fill with a $0.03 stress; candidates are forward-paper candidates only, never a live change.' : 'CONTROL NOT VERIFIED against bt9: per the spec, report this plainly and treat every result as unverified.';
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
};
Object.assign(module.exports, { simulate, analyze, verdict, VARS, NEIGH });
