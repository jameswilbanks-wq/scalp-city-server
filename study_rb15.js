'use strict';
/* bt28: ORB15 "options expression" study (spec: docs/rb15-expression-study-spec.md). READ-ONLY: it only reads Alpaca stock and option bars and
   writes kv 'bt28' (final or error) and 'bt28p' (progress). It never touches a journal row, a book, an order or any setting.

   Question: the ORB15 underlying signal is thin (about 0.04-0.10 R per trade). Does a different OPTIONS EXPRESSION of the same trades keep more of it?
     A (control) ATM single leg, same-day expiry.            B  0DTE debit vertical: buy ATM, sell the strike $2 further out in the trade direction.
     C           ATM single leg, next weekday's expiry (about 1DTE), still flat 15:30 ET the same day.
   Signal, entry timing, stop, target, break-even and time exit are IDENTICAL across variants and copied from study_orb15.js (bt13): 5-minute IEX stock bars,
   a 15-minute candle = 3 five-minute bars (9:45 .. 15:00), enter at the next 5-minute open, stop = other side of the range, target 1.25 R (ORB_R), stop to entry at
   +0.5 R (ORB_BE), flat 15:30 ET, stop checked before target inside a bar, one trade per symbol per day. Control A must reproduce bt13's 'e15|t1.25|be0.5' rows
   (same n, avg within $0.50) on the sessions bt13 covered (through 2026-11-11), otherwise B and C are NOT trusted.
   NOTE (bt13 key mapping): in bt13 keys 't1' and 'be1' are VALUES (1 R target, break-even at +1 R), not indices. Live ORB is 1.25 R / +0.5 R, so the control is 't1.25|be0.5'.

   Costs: historical option bars have no bid/ask. Each variant is reported at $0.01, $0.03 and $0.05 per leg per fill (A and C pay 2 fills, B pays 4). Pass is judged at $0.03.
   Cap: RISK_POLICY.md lists a planned (not active) $150 max loss per contract/spread. Max loss here = debit paid. Results are reported on all trades ('all') and on the
   set that obeys the skip-if-over-$150 rule ('cap'); pass/fail is judged on 'cap', 'all' is shown next to it.
   Splits: train < 2026-01-01, lock >= 2026-01-01 (already seen for the ORB signal in bt13, so NOT a virgin test), plus 2026-07-14 to latest. Forward paper is the real holdout.
   No parameter is tuned: width $2, 1.25 R, 0.5 R are fixed. Every variant and cost level is recorded, failures included. */

const TG = 1.25, BE = 0.5, WIDTH = 2, CAP = 150, COSTS = [0.01, 0.03, 0.05], JUDGE = 0.03, LOCK = '2026-01-01', SUB = '2026-07-14', BT13_LAST = '2026-11-11', VARS = ['A', 'B', 'C'];
const PERIODS = { train: d => d < LOCK, lock: d => d >= LOCK, since0714: d => d >= SUB };
const r2 = x => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 100) / 100;

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function et(ms) { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; }

/* ---------- signal and exits (copied from bt13's e15 path so the control reproduces it) ---------- */
function planDay(B) { // B = this day's 5-minute bars (9:30..15:55 ET) in time order
  const orH = Math.max(B[0].h, B[1].h, B[2].h), orL = Math.min(B[0].l, B[1].l, B[2].l);
  for (let k = 3; k + 2 < B.length - 1; k += 3) {
    if (B[k].min > 900) break;
    if (B[k + 2].min !== B[k].min + 10) return { skip: 'gap in 15-minute candle' };
    const c = B[k + 2].c, dir = c > orH ? 1 : c < orL ? -1 : 0;
    if (!dir) continue;
    const k1 = k + 3, p = { dir, k1, e: B[k1].o, tIn: B[k1].t, stop0: dir > 0 ? orL : orH };
    p.R = Math.abs(p.e - p.stop0);
    if (!(p.R > 0.0001 * p.e) || p.dir * (p.e - p.stop0) <= 0) return { skip: 'entry already through the stop' };
    return { plan: p };
  }
  return { skip: 'no breakout' };
}
function exitSim(B, p, tg, be) { // returns { xt, why, xr } exactly as bt13's loop
  let stop = p.stop0, moved = false, xt = null, why = 'time', xr = null;
  for (let q = p.k1; q < B.length; q++) {
    const x = B[q];
    if (x.min >= 930) { xt = x.t; xr = p.dir * (x.o - p.e) / p.R; break; }
    if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 5 * 60000; why = moved ? 'breakeven' : 'stop'; xr = p.dir * (stop - p.e) / p.R; break; }
    if (p.dir > 0 ? x.h >= p.e + tg * p.R : x.l <= p.e - tg * p.R) { xt = x.t + 5 * 60000; why = 'target'; xr = tg; break; }
    if (be && !moved && p.dir * ((p.dir > 0 ? x.h : x.l) - p.e) >= be * p.R) { stop = p.e; moved = true; }
  }
  if (xt === null) { const L = B[B.length - 1]; xt = L.t; xr = p.dir * (L.c - p.e) / p.R; }
  return { xt, why, xr };
}

/* ---------- contracts ---------- */
const ymd = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
const occ = (sym, d, dir, K) => sym + ymd(d) + (dir > 0 ? 'C' : 'P') + String(K * 1000).padStart(8, '0');
function nextWeekday(D) { const t = new Date(D + 'T12:00:00Z'); do { t.setUTCDate(t.getUTCDate() + 1); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6); return t.toISOString().slice(0, 10); }
function legsFor(v, sym, D, p) { // q = +1 bought, -1 sold
  const K = Math.round(p.e);
  if (v === 'A') return [{ s: occ(sym, D, p.dir, K), q: 1 }];
  if (v === 'B') return [{ s: occ(sym, D, p.dir, K), q: 1 }, { s: occ(sym, D, p.dir, K + WIDTH * p.dir), q: -1 }];
  return [{ s: occ(sym, nextWeekday(D), p.dir, K), q: 1 }];
}
/* bt13's price rules: entry = open of the first 1-minute option bar within 3 minutes of the entry time; exit = last bar close within 3 minutes at/after the exit time
   (tries the next 5 minutes, then up to 30 minutes back). */
function pxIn(arr, tIn) { for (const b of arr) { if (b.t >= tIn && b.t <= tIn + 3 * 60000) return b.o; if (b.t > tIn + 3 * 60000) break; } return null; }
function pxAt(arr, t, maxAge) { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; }
function sellAt(arr, t) { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); }
function priceTrade(legs, ob, p, xt) { // -> { skip } or { debit, out, gross (dollars before costs), nf (fills), ml (max loss dollars), oob }
  for (const L of legs) if (!ob[L.s]) return { skip: 'no option price' };
  const pins = legs.map(L => pxIn(ob[L.s], p.tIn));
  if (pins.some(x => x === null) || !(pins[0] >= 0.05)) return { skip: 'no usable entry price' };
  const debit = legs.length > 1 ? pins[0] - pins[1] : pins[0];
  if (!(debit >= 0.05)) return { skip: 'no usable entry price' };
  const pouts = legs.map(L => sellAt(ob[L.s], xt));
  if (pouts.some(x => x === null)) return { skip: 'no exit price' };
  const out = legs.length > 1 ? pouts[0] - pouts[1] : pouts[0];
  return { debit, out, gross: (out - debit) * 100, nf: legs.length * 2, ml: debit * 100, oob: legs.length > 1 && (out < -0.005 || out > WIDTH + 0.05) };
}

/* ---------- statistics ---------- */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function bootCI(x, B, seed) { // 95% percentile interval of the mean, resampling trades (at most one per symbol per day)
  const n = x.length; if (n < 2) return null; const rnd = mulberry32(seed), m = new Array(B);
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += x[Math.floor(rnd() * n)]; m[b] = s / n; }
  m.sort((a, b) => a - b); return [r2(m[Math.floor(0.025 * B)]), r2(m[Math.ceil(0.975 * B) - 1])];
}
function metrics(rows, c, ndays) { // rows: { day, gross, nf, ml, xr } in time order
  const n = rows.length; if (!n) return { n: 0, sessions: ndays };
  const pn = rows.map(r => r.gross - r.nf * c * 100); let net = 0, gw = 0, gl = 0, w = 0, worst = 0, best = 0, cum = 0, peak = 0, dd = 0, st = 0, ls = 0, rs = 0;
  pn.forEach((x, i) => { net += x; if (x > 0) { gw += x; w++; } else gl -= x; if (x < worst) worst = x; if (x > best) best = x; cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; if (x < 0) { st++; if (st > ls) ls = st; } else st = 0; rs += rows[i].xr; });
  const sorted = pn.slice().sort((a, b) => b - a), rest = sorted.slice(5);
  return { n, sessions: ndays, win: r2(100 * w / n), avg: r2(net / n), pf: gl > 0.01 ? r2(gw / gl) : null, worst: r2(worst), best: r2(best), maxDD: r2(dd), losingStreak: ls, avgR: r2(rs / n),
    shareDays: r2(100 * n / ndays), avgAllDays: r2(net / ndays), avgDropBest5: rest.length ? r2(rest.reduce((a, b) => a + b, 0) / rest.length) : null };
}

/* analyze(rows, sessions, opts): rows = [{ sym, day, v, gross, nf, ml, xr }], sessions = { SPY: [days], QQQ: [days] }. Pure. */
function analyze(rows, sessions, opts) {
  opts = opts || {}; const BOOT = opts.boot || 2000, res = {}, diffs = {}; let seed = 28;
  for (const sym of Object.keys(sessions)) for (const f of ['all', 'cap']) {
    const keep = r => f === 'all' || r.ml <= CAP;
    for (const per of Object.keys(PERIODS)) {
      const nd = sessions[sym].filter(PERIODS[per]).length;
      const set = {}; VARS.forEach(v => { set[v] = rows.filter(r => r.sym === sym && r.v === v && PERIODS[per](r.day) && keep(r)); });
      for (const v of VARS) for (const c of COSTS) {
        const m = metrics(set[v], c, nd); if (m.n) m.ci = bootCI(set[v].map(r => r.gross - r.nf * c * 100), BOOT, seed++);
        res[[sym, v, per, 'c' + c, f].join('|')] = m;
      }
      for (const v of ['B', 'C']) for (const c of COSTS) { // paired difference vs A on days both traded
        const a = new Map(set.A.map(r => [r.day, r.gross - r.nf * c * 100])), d = [];
        set[v].forEach(r => { if (a.has(r.day)) d.push(r.gross - r.nf * c * 100 - a.get(r.day)); });
        diffs[[sym, v, per, 'c' + c, f].join('|')] = { pairedDays: d.length, avgDiff: d.length ? r2(d.reduce((x, y) => x + y, 0) / d.length) : null, ci: bootCI(d, BOOT, seed++) };
      }
    }
  }
  return { res, diffs };
}

/* repro: compare control A at $0.01 (all trades, sessions <= bt13's last day) with bt13's stored rows. */
function reproCheck(rows, sessions, bt13) {
  const out = { ok: null, rows: {} }; if (!bt13 || !bt13.res) { out.note = 'bt13 not readable: control NOT verified'; return out; }
  let all = true;
  for (const sym of Object.keys(sessions)) for (const per of ['train', 'lock']) {
    const ref = bt13.res[sym + '|e15|t1.25|be0.5|' + per], mine = metrics(rows.filter(r => r.sym === sym && r.v === 'A' && PERIODS[per](r.day) && r.day <= BT13_LAST), 0.01, 1);
    const ok = !!(ref && mine.n === ref.n && Math.abs(mine.avg - ref.avg) <= 0.5);
    out.rows[sym + '|' + per] = { bt13: ref ? { n: ref.n, avg: ref.avg, pf: ref.pf } : null, bt28: { n: mine.n, avg: mine.avg, pf: mine.pf }, ok }; if (!ok) all = false;
  }
  out.ok = all; return out;
}

/* evaluate(analysis, repro, filter): the pre-registered criteria at $0.03 per leg per fill. */
function evaluate(an, repro, f) {
  const syms = [...new Set(Object.keys(an.res).map(k => k.split('|')[0]))], g = (s, v, p) => an.res[[s, v, p, 'c' + JUDGE, f].join('|')] || { n: 0 };
  const out = { control_reproduces: !!(repro && repro.ok === true) };
  for (const v of ['B', 'C']) {
    const c = { c1_control: out.control_reproduces, c2_positive_pf110: true, c3_beats_A: true, c4_lock_n100: true, c5_drop_best5_positive: true };
    for (const s of syms) {
      for (const p of ['train', 'lock']) { const m = g(s, v, p), a = g(s, 'A', p);
        if (!(m.n && m.avg > 0 && m.pf !== null && m.pf >= 1.10)) c.c2_positive_pf110 = false;
        if (!(m.n && a.n && m.avg > a.avg)) c.c3_beats_A = false;
        if (!(m.n && m.avgDropBest5 !== null && m.avgDropBest5 > 0)) c.c5_drop_best5_positive = false; }
      if (!(g(s, v, 'lock').n >= 100)) c.c4_lock_n100 = false;
    }
    c.c6_cap = f === 'cap' ? 'applied by construction (trades over $' + CAP + ' max loss removed; the loss of n feeds c4)' : 'not applied (all trades)';
    const advance = c.c1_control && c.c2_positive_pf110 && c.c3_beats_A && c.c4_lock_n100 && c.c5_drop_best5_positive;
    const ciZero = syms.some(s => { const m = g(s, v, 'lock'); return !m.ci || (m.ci[0] <= 0 && m.ci[1] >= 0); });
    out[v] = Object.assign(c, { advance, verdict: !advance ? 'fails' : ciZero ? 'unproven (bootstrap interval includes zero): at most forward paper shadow, never live' : 'passes the pre-registered criteria (historical only)' });
  }
  return out;
}

/* ---------- the run ---------- */
async function studyRb15(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString(), KEY = opts.key || 'bt28';
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, settings: { TG, BE, WIDTH, CAP, COSTS, JUDGE, LOCK, SUB, BT13_LAST, control: 'e15|t1.25|be0.5', priceRule: 'bt13: entry = open of first 1-min option bar within 3 min; exit = last close within 3 min (tries +5 min, then 30 min back)' },
    tally: '2 candidates (B, C) x 2 symbols x 3 cost levels = 12 comparisons vs control, on top of the bt13 ORB-family grid', notes: [] };
  const rows = [], sessions = {}, oob = {};
  const skip = (v, k) => { const key = v + '|' + k; out.skipped[key] = (out.skipped[key] || 0) + 1; };
  const apr = async (path, qs) => { try { return await ap(path, qs); } catch (e) { await sleep(gap ? 5000 : 0); return await ap(path, qs); } }; // one retry; a lost day is counted in errs
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await apr('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; if (gap) await sleep(gap);
    } while (pt);
    return m;
  };
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, rows: rows.length, skipped: out.skipped, at: iso(Date.now()) }); } catch (e) {} };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    do {
      const d = await apr('/v2/stocks/' + SYM + '/bars', { timeframe: '5Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
      tok = d.next_page_token; if (gap) await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570 && days[d][1].min === 575 && days[d][2].min === 580);
    sessions[SYM] = dayList; out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const B = days[D];
      try {
        const pl = planDay(B);
        if (pl.skip) { VARS.forEach(v => skip(v, pl.skip)); continue; }
        const p = pl.plan, ex = exitSim(B, p, TG, BE), legs = {}; VARS.forEach(v => { legs[v] = legsFor(v, SYM, D, p); });
        const need = [...new Set(VARS.flatMap(v => legs[v].map(L => L.s)))];
        const ob = await optBars(need, p.tIn - 60000, B[B.length - 1].t + 5 * 60000);
        for (const v of VARS) {
          const t = priceTrade(legs[v], ob, p, ex.xt);
          if (t.skip) { skip(v, t.skip); continue; }
          if (t.oob) oob[v] = (oob[v] || 0) + 1;
          rows.push({ sym: SYM, day: D, v, dir: p.dir, xr: ex.xr, why: ex.why, debit: t.debit, out: t.out, gross: t.gross, nf: t.nf, ml: t.ml });
        }
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String((e && e.message) || e).slice(0, 160); await sleep(gap ? 3000 : 0); }
      done++; if (done % 60 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await progressSave(); }
    }
  }
  out.spreadValueOutOfBounds = oob;
  const bt13 = opts.kget ? await Promise.resolve(opts.kget('bt13')).catch(() => null) : null;
  out.control = reproCheck(rows, sessions, bt13);
  const an = analyze(rows, sessions, { boot: opts.boot });
  out.res = an.res; out.diffsVsA = an.diffs;
  out.criteria = { cap: evaluate(an, out.control, 'cap'), all: evaluate(an, out.control, 'all') };
  out.verdictNote = out.control.ok === true ? 'Control reproduced bt13: B/C results usable. Judged on the cap-filtered set at $0.03; the unfiltered set is shown beside it.' : 'CONTROL DID NOT REPRODUCE bt13 (or bt13 unreadable): per the spec, STOP and report; do not trust B or C.';
  out.notes.push('Historical simulation on real Alpaca option bars; bars have no bid/ask, so costs are assumed. No live or forward result exists for this idea. Live ORB also applies a -50% premium stop that this study (like bt13) does not.');
  out.rows = rows.map(r => [r.sym, r.day, r.v, r.dir, r2(r.xr), r2(r.debit), r2(r.out), r2(r.gross), r2(r.ml), r.why]); // [sym, day, variant, dir, R, debit, out, gross$, maxLoss$, exit reason]
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
}
module.exports = studyRb15;
module.exports.helpers = { planDay, exitSim, occ, nextWeekday, legsFor, pxIn, pxAt, sellAt, priceTrade, metrics, bootCI, analyze, reproCheck, evaluate, et, CAP, WIDTH, COSTS, JUDGE };
