'use strict';
/* Study bt30 (read-only): Sweep variants on REAL option prices. Spec: docs/sweep-variants-study-spec.md (James approved building and running it, 2026-11-19).
   NOT trading: nothing here places an order or changes the live Sweep book. Saved once to kv bt30 (progress bt30p).

   Signals: Engine.signals sweep only (same rule as live and bt8), SPY and QQQ, same-day (0DTE) at-the-money option, entry at the option's first 1-minute
   bar within 3 minutes of the next-minute open, sold at its last trade price at/after the exit time (rules copied from study_sweep.js, bt8).
   Variants (sweepvar.js): S0 live rule, F1 fade with mirrored stop/trail, F2 fade 10-minute exit, W1/W2 wick-size caps, T1/T2/T3 trend filters, plus a seeded
   coin-flip noise reference. Costs: $0.01 and $0.03 per share per fill (round trip = 2 fills x 100). Judged at $0.03.
   Splits: dev = sessions before 2026-07-14, holdout = 2026-07-14..2026-11-13 (a WEAK holdout: Sweep was examined on it before).
   Bars are processed in 20-session chunks (indicators and signals only depend on the day's own bars past the first 15 minutes, so signals are identical to a
   one-pass run) so the server's event loop is never blocked for long. */
const SV = require('./sweepvar.js');

const HOLD = '2026-07-14', FROM = '2024-03-01', TO = '2026-11-14T00:00:00Z';
const COSTS = [0.01, 0.03], JUDGE = 0.03, MIN_HOLD_N = 100, MIN_Q_TRADES = 10;
const r2 = x => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 100) / 100;
const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
const qOf = d => d.slice(0, 4) + 'Q' + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1);
const quant = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return r2(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

// last close at/before t, no older than maxAge minutes (bt8 pxAt)
function pxAt(arr, t, maxAge) { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; }
function sellAt(arr, t) { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); }
function entryFill(arr, tIn) { if (!arr) return null; for (const b of arr) { if (b.t >= tIn && b.t <= tIn + 3 * 60000) return { pin: b.o, tFill: b.t }; if (b.t > tIn + 3 * 60000) break; } return null; }
const contract = (sym, day, dirT, entryO) => sym + ymdOf(day) + (dirT > 0 ? 'C' : 'P') + String(Math.round(Math.round(entryO) * 1000)).padStart(8, '0');

/* ---------- analysis (pure; exported for tests) ----------
   tbl[sym] = [{ i, day, f: signalFacts, g: { S0, F1, F2 } }] with g = gross dollars per contract (before costs) or null when that leg could not be priced.
   sessions[sym] = sorted list of all session days. */
function analyze(tbl, sessions, opts) {
  opts = opts || {}; const B = opts.boot || 2000, res = {}, extra = {};
  const inPer = (d, per) => per === 'all' ? true : per === 'dev' ? d < HOLD : d >= HOLD;
  for (const sym of Object.keys(tbl)) {
    const S = tbl[sym], sess = sessions[sym] || [];
    const nSess = { dev: sess.filter(d => inPer(d, 'dev')).length, holdout: sess.filter(d => inPer(d, 'holdout')).length, all: sess.length };
    const pick = (id, cost, per) => {
      const rows = [];
      for (const t of S) {
        if (!inPer(t.day, per)) continue;
        let g, dirU;
        if (id === 'NOISE') { if (t.g.S0 === null || t.g.F1 === null) continue; const heads = SV.coin(29, t.i); g = heads ? t.g.S0 : t.g.F1; dirU = heads ? t.f.dir : -t.f.dir; }
        else { const v = SV.VARIANTS.find(x => x.id === id); g = t.g[v.via]; if (g === null || g === undefined || !v.take(t.f)) continue; dirU = SV.dirOf(v.via, t.f); }
        rows.push({ day: t.day, pnl: g - 2 * cost * 100, dir: dirU, q: qOf(t.day) });
      }
      return rows;
    };
    res[sym] = {}; extra[sym] = {};
    for (const id of SV.VARIANTS.map(v => v.id).concat(['NOISE'])) {
      res[sym][id] = {};
      for (const cost of COSTS) {
        const ck = 'c' + String(Math.round(cost * 100)).padStart(2, '0'), cell = res[sym][id][ck] = {};
        for (const per of ['dev', 'holdout', 'all']) {
          const rows = pick(id, cost, per), pn = rows.map(x => x.pnl);
          cell[per] = SV.metrics(pn, nSess[per]);
          if (cost === JUDGE) {
            cell[per].ci95 = SV.bootCI(rows, B, 30);
            if (per === 'all') {
              cell[per].drop5 = SV.dropBest(pn, 5);
              const by = d => { const a = rows.filter(x => x.dir === d).map(x => x.pnl); return a.length ? { n: a.length, avg: r2(a.reduce((s, v) => s + v, 0) / a.length) } : { n: 0 }; };
              cell[per].callsPuts = { call: by(1), put: by(-1) };
              const qm = {}; rows.forEach(x => { (qm[x.q] = qm[x.q] || []).push(x.pnl); });
              cell[per].quarters =Object.keys(qm).sort().map(q => ({ q, n: qm[q].length, avg: r2(qm[q].reduce((s, v) => s + v, 0) / qm[q].length) }));
            }
          }
        }
      }
    }
    // stop-distance distribution of every usable signal (S0 population), by period
    extra[sym].stopDist = {};
    for (const per of ['dev', 'holdout']) { const a = S.filter(t => inPer(t.day, per) && t.g.S0 !== null); extra[sym].stopDist[per] = { n: a.length, R$: { p25: quant(a.map(t => t.f.R), 0.25), med: quant(a.map(t => t.f.R), 0.5), p75: quant(a.map(t => t.f.R), 0.75) }, Rpct: { p25: quant(a.map(t => t.f.rPct), 0.25), med: quant(a.map(t => t.f.rPct), 0.5), p75: quant(a.map(t => t.f.rPct), 0.75) } }; }
    extra[sym].signals = S.length; extra[sym].sessions = nSess;
  }
  return { res, extra };
}

// pass criteria (spec section 4), judged at $0.03 on each symbol; a variant passes only if both symbols pass. S0 is the control and T3 a diagnostic: not judged.
function evaluate(an, control) {
  const out = { judgedAt: '$0.03 per share per fill', controlOk: control ? control.ok : null, variants: {} };
  for (const id of ['F1', 'F2', 'W1', 'W2', 'T1', 'T2']) {
    const per = {}; let all = true;
    for (const sym of Object.keys(an.res)) {
      const v = an.res[sym][id].c03, s0 = an.res[sym].S0.c03, nz = an.res[sym].NOISE.c03, c = {};
      c.c1_devAndHoldoutPositive = !!(v.dev.n && v.holdout.n && v.dev.avg > 0 && v.holdout.avg > 0);
      c.c2_holdoutN100 = !!(v.holdout.n >= MIN_HOLD_N);
      c.c3_positiveDropBest5 = v.all.drop5 !== null && v.all.drop5 !== undefined && v.all.drop5 > 0;
      c.c4_beatsNoise95 = !!(v.all.n && nz.all.ci95 && v.all.avg > nz.all.ci95[1]);
      if (id === 'F1' || id === 'F2') { const q = (v.all.quarters || []).filter(x => x.n >= MIN_Q_TRADES); c.c5_quarters75pct = q.length >= 4 && q.filter(x => x.avg > 0).length / q.length >= 0.75; }
      else c.c6_beatsS0BothPeriods = !!(v.dev.n && v.holdout.n && v.dev.avg > s0.dev.avg && v.holdout.avg > s0.holdout.avg);
      c.pass = Object.keys(c).every(k => c[k] === true);
      per[sym] = c; if (!c.pass) all = false;
    }
    out.variants[id] = { perSymbol: per, passStage0: all };
  }
  return out;
}

// S0 must reproduce the saved bt8 'run' rows (same window, $0.01 per fill) or results are marked control not verified.
function reproCheck(tbl, bt8) {
  if (!bt8 || bt8.error || !bt8.res) return { ok: null, reason: 'bt8 unreadable or has no result' };
  const t0 = Date.parse(bt8.started), days = bt8.days || 365; if (!isFinite(t0)) return { ok: null, reason: 'bt8 has no start time' };
  const from = t0 - days * 864e5, per = {}; let ok = true;
  for (const sym of Object.keys(tbl)) {
    const ref = bt8.res[sym + '|run|ALL']; if (!ref) { per[sym] = { ok: null, reason: 'no bt8 run row' }; ok = false; continue; }
    const a = tbl[sym].filter(t => { const ms = Date.parse(t.day + 'T12:00:00Z'); return ms >= from && ms <= t0 && t.g.S0 !== null; }).map(t => t.g.S0 - 2 * 0.01 * 100);
    const n = a.length, avg = n ? a.reduce((s, v) => s + v, 0) / n : null;
    const good = n > 0 && Math.abs(n - ref.n) <= Math.max(3, 0.03 * ref.n) && Math.abs(avg - ref.avg) <= 1.5;
    per[sym] = { ok: good, mine: { n, avg: r2(avg) }, bt8: { n: ref.n, avg: ref.avg } }; if (!good) ok = false;
  }
  return { ok, per, rule: 'n within max(3, 3%) and average within $1.50 per trade' };
}

/* ---------- the run ---------- */
async function studySweepVariants(ap, Engine, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), tick = () => new Promise(r => setImmediate(r)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString(), KEY = opts.key || 'bt30';
  const now = opts.now || Date.now(), endIso = iso(Math.min(Date.parse(opts.to || TO), now - 20 * 60000)), from = opts.from || FROM, chunkDays = opts.chunkDays || 20;
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, notes: [],
    settings: { HOLD, FROM: from, TO: endIso, COSTS, JUDGE, MIN_HOLD_N, MIN_Q_TRADES, priceRule: 'bt8: entry = open of first 1-min option bar within 3 min of the next-minute open; exit = last close within 3 min of exit time (tries +5 min, then 30 min back); skip if entry price < $0.05', criterion5: 'fade positive in >= 75% of calendar quarters that have >= 10 trades (and >= 4 such quarters)', overlap: 'every signal is priced independently, as in bt8 (the live book holds one position at a time)' },
    tally: '8 variants (S0 control + 7) x 2 symbols x 2 cost levels; 6 judged variants x 2 symbols, on top of about 70 Sweep exit variants (bt2/bt3/bt4/bt8/bt9)' };
  const skip = (k) => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const apr = async (path, qs) => { try { return await ap(path, qs); } catch (e) { await sleep(gap ? 5000 : 0); return await ap(path, qs); } }; // one retry; a lost day is counted in errs
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, signals: Object.keys(tbl).map(s => s + ':' + tbl[s].length).join(' '), skipped: out.skipped, at: iso(Date.now()) }); } catch (e) {} };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    for (let i = 0; i < syms.length; i += 90) {
      pt = undefined;
      do {
        const d = await apr('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
        Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
        pt = d.next_page_token; if (gap) await sleep(gap);
      } while (pt);
    }
    return m;
  };
  const tbl = {}, sessions = {};
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    tbl[SYM] = []; let nextI = 0;
    try {
      out.progress = SYM + ' loading 1-minute stock bars'; await progressSave();
      let raw = [], tok;
      do {
        const d = await apr('/v2/stocks/' + SYM + '/bars', { timeframe: '1Min', start: from + 'T00:00:00Z', end: endIso, feed: 'iex', limit: 10000, adjustment: 'raw', page_token: tok });
        (d.bars || []).forEach(b => raw.push({ begins_at: b.t, open_price: b.o, high_price: b.h, low_price: b.l, close_price: b.c, volume: b.v }));
        tok = d.next_page_token; if (gap) await sleep(gap);
      } while (tok);
      const bars = Engine.prepare(raw); raw = null;
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      sessions[SYM] = dayList; out.n[SYM] = { bars: bars.length, sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
      if (bars.length < (opts.minBars || 1000)) { out.n[SYM].note = 'too few bars'; continue; }
      let done = 0;
      for (let c0 = 0; c0 < dayList.length; c0 += chunkDays) {
        const dset = new Set(dayList.slice(c0, c0 + chunkDays)), i0 = bars.findIndex(b => dset.has(b.day));
        let i1 = i0; while (i1 < bars.length && dset.has(bars[i1].day)) i1++;
        const cb = bars.slice(i0, i1);
        Engine.simulate(cb, {}, true); // fills indicators (atr, vwap) on this chunk
        const sg = Engine.signals(cb, { vwap: false, orb: false, ema: false }).filter(g => g.sig.trig === 'sweep' && g.sig.stopPx !== undefined && g.sig.stopPx !== null);
        const byDay = {}; sg.forEach(g => { (byDay[cb[g.k].day] = byDay[cb[g.k].day] || []).push(g); });
        for (const D of Object.keys(byDay).sort()) {
          try {
            const dayOpen = cb[cb.findIndex(b => b.day === D)].o;
            const facts = byDay[D].map(g => SV.signalFacts(cb, g, dayOpen)).filter(f => { if (!f) skip(SYM + ' unusable signal (no next bar or tiny stop)'); return !!f; });
            if (!facts.length) continue;
            const legs = facts.map(f => ({ f, i: nextI++, legs: SV.OUTCOMES.map(nm => { const dT = SV.dirOf(nm, f); return { nm, dT, s: contract(SYM, D, dT, f.entryO) }; }) }));
            const need = [...new Set(legs.flatMap(L => L.legs.map(x => x.s)))];
            const dayEnd = Date.parse(D + 'T21:05:00Z'), first = Math.min(...facts.map(f => f.entryT));
            const ob = await optBars(need, first - 60000, dayEnd);
            for (const L of legs) {
              const g = {};
              for (const x of L.legs) {
                g[x.nm] = null;
                const arr = ob[x.s], fill = entryFill(arr, L.f.entryT);
                if (!fill) { skip(SYM + '|' + x.nm + '|no option price at entry'); continue; }
                if (!(fill.pin >= 0.05)) { skip(SYM + '|' + x.nm + '|option under 5 cents'); continue; }
                const xt = SV.walk(cb, L.f.k, x.dT, L.f.R, SV.modeOf(x.nm)); if (xt === null) { skip(SYM + '|' + x.nm + '|no exit bar'); continue; }
                const pout = sellAt(arr, xt); if (pout === null) { skip(SYM + '|' + x.nm + '|no option price at exit'); continue; }
                g[x.nm] = (pout - fill.pin) * 100;
              }
              tbl[SYM].push({ i: L.i, day: D, f: { dir: L.f.dir, R: L.f.R, rPct: L.f.rPct, trendAgree: L.f.trendAgree, vwapAgree: L.f.vwapAgree }, g });
            }
          } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String((e && e.message) || e).slice(0, 160); await sleep(gap ? 3000 : 0); }
          done++; if (done % 40 === 0) { out.progress = SYM + ' ' + done + ' signal days done (' + D + ')'; await progressSave(); }
          await tick();
        }
        await tick();
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String((e && e.message) || e).slice(0, 160); }
  }
  out.progress = 'analysing'; await progressSave();
  const bt8 = opts.kget ? await Promise.resolve(opts.kget('bt8')).catch(() => null) : null;
  out.control = reproCheck(tbl, bt8);
  const an = analyze(tbl, sessions, { boot: opts.boot }); await tick();
  out.res = an.res; out.extra = an.extra;
  out.criteria = evaluate(an, out.control);
  out.verdictNote = out.control.ok === true ? 'Control reproduced bt8 run rows: results usable. Judged at $0.03 per fill; $0.01 shown beside it.' : 'CONTROL NOT VERIFIED against bt8 (or bt8 unreadable): per the spec, report this plainly and treat every variant result as unverified.';
  out.notes.push('Historical simulation on real Alpaca option bars (last trade prices, no bid/ask), so costs are assumed. Holdout is weak (Sweep was examined on it). Forward paper (the live Sweep book since 2026-11-11) is reported separately, never merged. A pass leads only to a shadow paper book, never a swap.');
  out.rows = []; Object.keys(tbl).forEach(s => tbl[s].forEach(t => out.rows.push([s, t.day, t.f.dir, r2(t.f.R), r2(t.f.rPct), t.f.trendAgree === null ? null : t.f.trendAgree ? 1 : 0, t.f.vwapAgree ? 1 : 0, r2(t.g.S0), r2(t.g.F1), r2(t.g.F2)]))); // [sym, day, dir, R$, R%, trendAgree, vwapAgree, grossS0, grossF1, grossF2] gross $ per contract before costs
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
}
module.exports = studySweepVariants;
module.exports.helpers = { analyze, evaluate, reproCheck, pxAt, sellAt, entryFill, contract, qOf, HOLD, COSTS, JUDGE };
