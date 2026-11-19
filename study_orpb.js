'use strict';
/* Study bt29 (Stage 0, READ-ONLY, no trading effect): "ORPB" -- 30-minute opening range, 10-minute candle close beyond it, then entry on a
   2-minute pullback to the 20 EMA. Underlying price only (SPY, QQQ stock bars), NO options, NO money. Spec: docs/orpb-signal-study-spec.md
   (James approved building and running Stage 0 only, 2026-11-19). Mechanics live in orpb.js; this file loads data, runs the pre-registered
   configs, computes metrics and the pass/fail read-out. Run once server-side after boot; final result in kv 'bt29', progress in 'bt29p'.

   Data: Alpaca 1-minute stock bars, IEX feed (not consolidated tape; volume thin but prices track SPY/QQQ closely), split-adjusted.
   Splits: dev = sessions before 2026-07-14, holdout = 2026-07-14 .. 2026-11-13 (same as bt24). Sessions after 2026-11-13 are NOT fetched
   (forward paper starts 2026-11-19 and is evaluated separately).
   Costs: $0.02 per share round trip (also $0.04), subtracted in dollars and converted to R as cost / stop distance, per trade.
   One trade per symbol per day. Reports historical underlying results only: not forward, not live, not profit. */
const O = require('./orpb.js');

const LOCK_SPLIT = '2026-07-14', HOLD_END = '2026-11-13';
const COSTS = [0.02, 0.04];
const PRIMARY = 'hold_t2';
const NEIGHBORS = ['sens_ema15', 'sens_ema25', 'sens_trig5', 'sens_trig15', 'sens_range23', 'sens_range38'];
const BASEC = { entry: 'hold', target: 2, emaLen: 20, trigMin: 10, rangeMin: 30, warm: true, floor: 0.10 };
const tn = t => (t ? 't' + t : 'tnone');
const CONFIGS = {};
[1.5, 2, 3, 0].forEach(t => {
  CONFIGS['hold_' + tn(t)] = Object.assign({}, BASEC, { entry: 'hold', target: t });
  CONFIGS['touch_' + tn(t)] = Object.assign({}, BASEC, { entry: 'touch', target: t });
  CONFIGS['naive_' + tn(t)] = Object.assign({}, BASEC, { entry: 'naive', target: t });
});
CONFIGS.sens_ema15 = Object.assign({}, BASEC, { emaLen: 15 });
CONFIGS.sens_ema25 = Object.assign({}, BASEC, { emaLen: 25 });
CONFIGS.sens_trig5 = Object.assign({}, BASEC, { trigMin: 5 });
CONFIGS.sens_trig15 = Object.assign({}, BASEC, { trigMin: 15 });
CONFIGS.sens_range23 = Object.assign({}, BASEC, { rangeMin: 23 });
CONFIGS.sens_range38 = Object.assign({}, BASEC, { rangeMin: 38 });
CONFIGS.sens_seedSession = Object.assign({}, BASEC, { warm: false });
CONFIGS['info_floor0.20'] = Object.assign({}, BASEC, { floor: 0.20 });

const r3 = x => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r2 = x => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function quant(sorted, q) { if (!sorted.length) return null; const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
// one trade per symbol per day, so resampling trades is resampling days
function bootCI(rs, iters, seed) {
  const n = rs.length; if (n < 2) return null;
  const rnd = mulberry32(seed || 29), means = [];
  for (let k = 0; k < (iters || 2000); k++) { let s = 0; for (let i = 0; i < n; i++) s += rs[Math.floor(rnd() * n)]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return [r3(quant(means, 0.025)), r3(quant(means, 0.975))];
}

// tr = [{day, entry, risk, gross, why}] (money per share); sessions = number of trading days in the period (incl. no-trade days)
function metrics(tr, sessions, cost, full) {
  const n = tr.length;
  if (!n) return { n: 0, sessions, avgAllDays: 0, totalR: 0 };
  const s = tr.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const rs = s.map(t => (t.gross - cost) / t.risk);
  const sum = rs.reduce((a, b) => a + b, 0), wins = rs.filter(x => x > 0), losses = rs.filter(x => x <= 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
  rs.forEach(x => { cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; if (x <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0; });
  const risks = s.map(t => t.risk).sort((a, b) => a - b), pcts = s.map(t => t.risk / t.entry * 100).sort((a, b) => a - b);
  const grossSh = s.reduce((a, t) => a + t.gross, 0) / n;
  const why = {}; s.forEach(t => { why[t.why] = (why[t.why] || 0) + 1; });
  const top5 = n > 5 ? rs.slice().sort((a, b) => b - a).slice(5) : null;
  const m = {
    n, sessions, winPct: r2(100 * wins.length / n), avgR: r3(sum / n), pf: gl > 0.0001 ? r2(gw / gl) : null, totalR: r2(sum),
    worstR: r2(Math.min(...rs)), bestR: r2(Math.max(...rs)), maxDDR: r2(dd), longestLosingStreak: maxStreak,
    tradesPerDay: r3(n / sessions), avgAllDays: r3(sum / sessions), // net R per trading day, no-trade days included
    stopUsdMed: r2(quant(risks, 0.5)), stopUsdP25: r2(quant(risks, 0.25)), stopUsdP75: r2(quant(risks, 0.75)), stopUsdMean: r2(risks.reduce((a, b) => a + b, 0) / n),
    stopPctMed: r3(quant(pcts, 0.5)), grossUsdPerShare: r3(grossSh), netUsdPerShare: r3(grossSh - cost), why,
    dropBest5: top5 ? { n: top5.length, avgR: r3(top5.reduce((a, b) => a + b, 0) / top5.length) } : null,
  };
  if (full) m.ci95 = bootCI(rs, 2000, 29);
  return m;
}

function evaluate(res) {
  const out = { perSymbol: {}, notes: [] };
  let all15 = true, flag6 = false;
  for (const sym of Object.keys(res)) {
    const P = res[sym][PRIMARY], B = res[sym]['naive_t2'];
    const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const c1 = P.dev.c02.n > 0 && P.dev.c02.avgR > 0;
    const c2 = P.holdout.c02.n >= 40 && P.holdout.c02.avgR > 0;
    const c3 = !!(P.all.c02.dropBest5 && P.all.c02.dropBest5.avgR > 0);
    const flips = [];
    NEIGHBORS.forEach(k => {
      const N = res[sym][k];
      if (!N || N.dev.c02.n === 0 || N.holdout.c02.n === 0 || sign(N.dev.c02.avgR) !== sign(P.dev.c02.avgR) || sign(N.holdout.c02.avgR) !== sign(P.holdout.c02.avgR)) flips.push(k);
    });
    const c4 = flips.length === 0;
    const c5 = P.dev.c02.n > 0 && B.dev.c02.n > 0 && P.dev.c02.avgR > B.dev.c02.avgR && P.holdout.c02.n > 0 && B.holdout.c02.n > 0 && P.holdout.c02.avgR > B.holdout.c02.avgR;
    const med = P.all.c02.stopUsdMed, c6flag = !(med >= 0.20);
    const ok15 = c1 && c2 && c3 && c4 && c5;
    out.perSymbol[sym] = { c1_devAvgRpositive: c1, c2_holdoutPositiveAndN40: c2, c3_positiveDropBest5: c3, c4_noSignFlipNeighbors: c4, c4_flipped: flips, c5_beatsNaiveBothPeriods: c5, c6_medianStopUsd: med, c6_costDominatedFlag: c6flag, criteria1to5: ok15 };
    if (!ok15) all15 = false;
    if (c6flag) flag6 = true;
  }
  out.passCriteria1to5BothSymbols = all15;
  out.costDominatedFlag = flag6;
  out.verdict = !all15 ? 'FAILS Stage 0 (at least one of criteria 1-5 fails on at least one symbol). Record as failed; no Stage 1, no book.'
    : (flag6 ? 'Passes criteria 1-5 on both symbols, but median stop distance is under $0.20 on at least one symbol: likely cost-dominated; do not advance without a Stage 1 plan that handles it.'
      : 'Passes all six pre-registered criteria at Stage 0 on both symbols (historical underlying only; Stage 1 is a separate James decision).');
  return out;
}

module.exports = async function studyOrpb(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), tick = () => new Promise(r => setImmediate(r));
  const gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const KEY = opts.key || 'bt29', PKEY = opts.progKey || 'bt29p', SPLIT = opts.split || LOCK_SPLIT;
  const FROM = opts.from || '2024-03-01', TO = opts.to || '2026-11-14T00:00:00Z';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const out = {
    started: iso(Date.now()), progress: 'starting', errs: 0, sessionSkips: {}, n: {}, res: {}, primaryTrades: {},
    settings: { source: 'Alpaca 1-minute stock bars, IEX feed, split-adjusted (not consolidated tape)', symbols: opts.syms || ['SPY', 'QQQ'], from: FROM, holdoutEnd: HOLD_END, split: SPLIT, costsUsdPerShareRoundTrip: COSTS, stopFloorUsd: 0.10, primary: PRIMARY, configs: Object.keys(CONFIGS), configsPerSymbol: Object.keys(CONFIGS).length, bootstrap: '2000 resamples of trades (= days; one trade per symbol per day), seed 29, 95% percentile interval' },
    notes: [
      'Stage 0: underlying price only, no options. HISTORICAL study: not forward, not live, not profit. Holdout window was already seen by earlier studies (weak holdout); the untouched test is forward paper from 2026-11-19.',
      'Inferred rules (spec section 3): touch-and-hold entry at the pullback candle close; stop at that candle extreme; shorts mirror longs; EMA includes the candle own close; stop distance under $0.10 skips the day (that day is not retried).',
      'Added by the harness, not in the spec: the first 5 sessions of data are skipped (no 5-session EMA warm-up); sessions with fewer than 150 one-minute bars or ending before 15:00 ET (half days, outages) are skipped and counted; a bar that opens beyond the stop fills at the open, not the stop.',
      'Multiple-comparisons tally: ' + Object.keys(CONFIGS).length + ' configs per symbol tried (8 pre-registered entry x target, 4 naive baselines, 7 sensitivity, 1 floor row); count them together with bt13, bt24 (and bt25 if built) as one levels / opening-range family.',
    ],
  };
  const skipDay = (sym, why) => { const k = sym + '|' + why; out.sessionSkips[k] = (out.sessionSkips[k] || 0) + 1; };
  const apr = async (p, q) => { try { return await ap(p, q); } catch (e) { await sleep(1500); return await ap(p, q); } };
  const saveProg = async (msg) => { out.progress = msg; try { await kset(PKEY, { progress: msg, at: iso(Date.now()), errs: out.errs }); } catch (e) { } };

  async function fetchBars(sym) {
    const days = {}; let tok, pages = 0;
    do {
      const d = await apr('/v2/stocks/' + sym + '/bars', { timeframe: '1Min', start: FROM + 'T00:00:00Z', end: TO, feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      for (const b of (d.bars || [])) { const e = et(Date.parse(b.t)); if (e.min < 570 || e.min >= 960) continue; (days[e.day] = days[e.day] || []).push(e.min, b.o, b.h, b.l, b.c); }
      tok = d.next_page_token; pages++;
      if (pages % 5 === 0) await saveProg(sym + ' loading bars, page ' + pages);
      if (tok) await sleep(gap);
    } while (tok);
    return days;
  }
  const expand = flat => { const a = []; for (let i = 0; i < flat.length; i += 5) a.push({ min: flat[i], o: flat[i + 1], h: flat[i + 2], l: flat[i + 3], c: flat[i + 4] }); return a.sort((x, y) => x.min - y.min); };

  for (const SYM of out.settings.symbols) {
    const days = await fetchBars(SYM), dayList = Object.keys(days).sort();
    const trades = {}, signals = {}, skips = {}, sess = { dev: 0, holdout: 0 };
    Object.keys(CONFIGS).forEach(k => { trades[k] = []; signals[k] = 0; skips[k] = {}; });
    const warmQ = []; let done = 0;
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    for (const D of dayList) {
      const period = D < SPLIT ? 'dev' : 'holdout'; sess[period]++;
      const bars = expand(days[D]); delete days[D];
      try {
        const warm = warmQ.length >= 5 ? [].concat(...warmQ.slice(-5)) : null, d = O.makeDay(bars, warm);
        const c2 = d.closes2(); if (c2.length) { warmQ.push(c2); if (warmQ.length > 5) warmQ.shift(); }
        if (bars.length < 150) skipDay(SYM, 'thin day (<150 one-minute bars)');
        else if (bars[bars.length - 1].min < 900) skipDay(SYM, 'short or incomplete session (ends before 15:00 ET)');
        else {
          for (const name of Object.keys(CONFIGS)) {
            const r = O.runConfig(d, CONFIGS[name]);
            if (r.signal) signals[name]++;
            if (r.trade) trades[name].push(Object.assign({ day: D }, r.trade)); else skips[name][r.skip] = (skips[name][r.skip] || 0) + 1;
          }
        }
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); }
      done++; if (done % 100 === 0) await saveProg(SYM + ' ' + done + ' of ' + dayList.length); else if (done % 10 === 0) await tick();
    }
    out.n[SYM].devSessions = sess.dev; out.n[SYM].holdoutSessions = sess.holdout;
    out.res[SYM] = {};
    for (const name of Object.keys(CONFIGS)) {
      const dev = trades[name].filter(t => t.day < SPLIT), hold = trades[name].filter(t => t.day >= SPLIT), all = dev.concat(hold);
      const R = { signals: signals[name], skips: skips[name] };
      [['dev', dev, sess.dev], ['holdout', hold, sess.holdout], ['all', all, sess.dev + sess.holdout]].forEach(([p, arr, ns]) => {
        R[p] = { c02: metrics(arr, ns, COSTS[0], true), c04: metrics(arr, ns, COSTS[1], false) };
      });
      out.res[SYM][name] = R; await tick();
    }
    out.primaryTrades[SYM] = trades[PRIMARY].map(t => [t.day, t.dir, t.entryMin, r2(t.entry), r2(t.stop), r2(t.risk), r2(t.exitPx), t.why]);
    await saveProg(SYM + ' done');
  }
  out.criteria = evaluate(out.res);
  out.progress = 'done'; out.done = iso(Date.now());
  await kset(KEY, out);
  return out;
};
module.exports.helpers = { metrics, bootCI, evaluate, CONFIGS, PRIMARY, NEIGHBORS, COSTS };
