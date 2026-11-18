/* Study 16 (read-only): first real backtest of the CDR ("condor") book, which has been live-paper since 2026-11-12
   with ZERO backtest validation and, as of 2026-11-18, zero trades fired in 8 live days. This study mirrors the
   live chop-gate + iron-condor entry/exit logic in server.js (cdrRangeSig/cdrSelect/cdrManage) as closely as a
   historical backtest can, on REAL Alpaca option prices, to answer two questions: (1) does the chop-gate signal
   fire at a reasonable frequency on real history (telling us whether 8 live days of silence is "rare but normal"
   or more likely a bug), and (2) if it does fire, does the condor structure make money.

   Mechanics mirrored from server.js (cdrRangeSig/cdrSelect/cdrManage), same thresholds:
   - Opening-range chop gate: 12 completed 5-min bars, 9:30-10:30 ET. Width must be 0.15%-1% of the range midpoint.
     The 5-min closes must cross the midpoint >=3 times, AND there must be at least one rejection wick near each
     edge (high within 15% of the range from the top with a close back below 25% from the top; mirror for the low).
   - After 10:30, the day is invalidated the moment any 5-min close trades outside [low,high]. Among the still-valid
     days, the FIRST 5-min bar (within minutes 640-750 ET, i.e. 10:40 ET - 12:30 ET) whose close sits back in the
     middle half of the range [low+0.25w, high-0.25w] is the signal bar -- one attempt per symbol per day.
   - Condor selection: candidate short strikes are the 5 nearest whole-dollar strikes beyond the range by whichever
     is larger of $0.50 or 10% of the range width (the "padding"), on each side. For wing widths {1,2,3}, pick the
     short/long pair with credit >= $0.20, credit < width, credit/width >= 20%, and total risk (width-credit)*100 +
     $20 fee/slippage reserve <= $200, maximizing credit/width. BACKTEST APPROXIMATION, flagged plainly: the live
     book fills against real bid/ask quotes; this backtest only has historical option TRADE prices (1-minute bar
     closes, Alpaca options bars), so it uses each leg's bar close as both sides of the fill. This is the same kind
     of approximation already used elsewhere in this project for backtests without quote history (see EXPERIMENT_LOG.md
     bt6-bt9 for the equivalent CSK precedent) -- it is optimistic relative to what the live book will actually fill at,
     since real spreads will eat some of the modeled credit on both entry and exit.
   - Exit: 50% profit target (current debit <= 50% of entry credit), a $140-per-trade stop (current debit implies a
     loss of >= $140), two consecutive 5-min bars with the underlying closing outside the original [low,high] range,
     or a time exit at 14:50 ET (70 min before the 16:00 close). If nothing fires, settle at the day's close on
     intrinsic value (same as how the live book would be forced to behave if nothing closed it, though in practice
     the live book's cdrManage loop would have already hit one of the above first).
   - fee=$20 is used for the live book's RISK budgeting only (not subtracted from realized pnl), mirrored here.

   Not modeled (same gaps as the live book, flagged, not silently assumed away): correlation-cap skips, the
   $400 daily-risk budget and $280 daily-stop halt (this study measures the per-trade signal/edge in isolation,
   not the daily governor), and the AI shadow-overlay (irrelevant to P&L either way).

   Reports, per symbol and train(<2026-01-01)/lock(2026 onward) split: how many days the chop-gate fired vs. was
   blocked and why (this answers the "is 8-day silence normal" question), then win/loss/PF/avgR for whatever
   condors it found. kv 'bt16'. */
module.exports = async function studyCdr(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt16', SPLIT = opts.split || '2026-01-01';
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, gate: {}, res: {}, n: {},
    note: 'Backtest approximation: option legs priced at bar close (last trade), not real bid/ask -- optimistic vs. the live book. See header comment.' };
  const M = {};
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const gateCount = (sym, k) => { out.gate[sym] = out.gate[sym] || {}; out.gate[sym][k] = (out.gate[sym][k] || 0) + 1; };
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best) }; }); };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };

  const FEE = opts.fee || 20, TRADE_MAX = opts.tradeMax || 200, TRADE_STOP = opts.tradeStop || 140, ENTRY_FROM = 640, ENTRY_TO = 750, TIME_EXIT = 890;

  async function fetchStockBars(sym, from, to) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + sym + '/bars', { timeframe: '1Min', start: from + 'T00:00:00Z', end: to, feed: 'sip', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    return days;
  }
  function fiveMin(bars, fromMin, toMin) {
    const r = [];
    for (let m = fromMin; m < toMin; m += 5) {
      const g = bars.filter(b => b.min >= m && b.min < m + 5); if (g.length < 5) continue;
      r.push({ o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, min: m });
    }
    return r;
  }
  function rangeSig(dayBars) {
    const five = fiveMin(dayBars, 570, 630); if (five.length !== 12) return { why: 'IB window incomplete' };
    const low = Math.min(...five.map(b => b.l)), high = Math.max(...five.map(b => b.h)), mid = (low + high) / 2, width = high - low;
    if (!(width / mid >= 0.0015 && width / mid <= 0.01)) return { why: 'width out of 0.15%-1% band' };
    const closes = five.map(b => b.c); let crosses = 0;
    for (let i = 1; i < closes.length; i++) if ((closes[i - 1] < mid) !== (closes[i] < mid)) crosses++;
    if (crosses < 3) return { why: 'fewer than 3 midpoint crosses' };
    const rejHigh = five.some(b => b.h >= high - width * 0.15 && b.c < high - width * 0.25);
    const rejLow = five.some(b => b.l <= low + width * 0.15 && b.c > low + width * 0.25);
    if (!rejHigh || !rejLow) return { why: 'no rejection wick near both edges' };
    return { low, high, mid, width };
  }
  function findSignal(dayBars, bounds) {
    const { low, high, width } = bounds;
    const post = fiveMin(dayBars, 630, 960);
    for (let i = 0; i < post.length; i++) {
      const b = post[i];
      if (b.c < low || b.c > high) return { why: 'range broken before any signal (bar closed outside at min ' + b.min + ')' };
      if (b.min < ENTRY_FROM) continue;
      if (b.min > ENTRY_TO) return { why: 'window closed (12:30 ET) with no bar back in the middle half' };
      if (b.c >= low + width * 0.25 && b.c <= high - width * 0.25) return { bar: b, idx: i, post };
    }
    return { why: 'no bar in window or window not reached' };
  }
  const occ = (sym, ymd, type, k) => sym + ymd + type + String(Math.round(k) * 1000).padStart(8, '0');
  async function optCloseSeries(syms, start, end) {
    const m = {}; let pt;
    for (let i = 0; i < syms.length; i += 90) {
      do {
        const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '5Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
        Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), c: b.c }))); });
        pt = d.next_page_token; await sleep(gap);
      } while (pt);
    }
    return m;
  }
  const atOrBefore = (arr, t) => { if (!arr || !arr.length) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 ? arr[a].c : null; };

  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    out.progress = SYM + ' loading stock bars'; await save();
    const days = await fetchStockBars(SYM, opts.from || '2024-03-01', opts.to || iso(Date.now() - 20 * 60000));
    const all = Object.keys(days).sort(), dayList = all.filter(d => days[d].length >= 300 && days[d][0].min === 570 && days[d][1].min === 571);
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const split = D < SPLIT ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10), B = days[D];
      try {
        const gateR = rangeSig(B);
        if (gateR.why) { gateCount(SYM, 'gate-blocked: ' + gateR.why); done++; continue; }
        gateCount(SYM, 'gate-passed (chop confirmed)');
        const sigR = findSignal(B, gateR);
        if (sigR.why) { gateCount(SYM, 'signal-blocked: ' + sigR.why); done++; continue; }
        gateCount(SYM, 'signal fired');
        const { low, high, width } = gateR, padding = Math.max(0.5, width * 0.1), sigT = Date.parse(D + 'T00:00:00Z') + 0; // placeholder, replaced below
        const sigBar = sigR.bar, sigTime = B.find(b => b.min === sigBar.min + 4) ? B.find(b => b.min === sigBar.min + 4).t : (days[D][0].t + sigBar.min * 60000);
        const pCands = [], cCands = [];
        for (let k = Math.floor(low - padding); pCands.length < 5 && k > 0; k--) pCands.push(k);
        for (let k = Math.ceil(high + padding); cCands.length < 5; k++) cCands.push(k);
        const symsNeeded = new Set();
        pCands.forEach(k => { symsNeeded.add(occ(SYM, ymd, 'P', k)); [1, 2, 3].forEach(w => symsNeeded.add(occ(SYM, ymd, 'P', k - w))); });
        cCands.forEach(k => { symsNeeded.add(occ(SYM, ymd, 'C', k)); [1, 2, 3].forEach(w => symsNeeded.add(occ(SYM, ymd, 'C', k + w))); });
        const dayStart = Date.parse(D + 'T13:30:00Z'), dayEnd = Date.parse(D + 'T21:05:00Z');
        const ob = await optCloseSeries([...symsNeeded], dayStart, dayEnd);
        const priceAt = (sym, t) => atOrBefore(ob[sym], t);
        let best = null;
        for (const sp of pCands) for (const sc of cCands) for (const w of [1, 2, 3]) {
          const spSym = occ(SYM, ymd, 'P', sp), lpSym = occ(SYM, ymd, 'P', sp - w), scSym = occ(SYM, ymd, 'C', sc), lcSym = occ(SYM, ymd, 'C', sc + w);
          const spP = priceAt(spSym, sigTime), lpP = priceAt(lpSym, sigTime), scP = priceAt(scSym, sigTime), lcP = priceAt(lcSym, sigTime);
          if (spP === null || lpP === null || scP === null || lcP === null) continue;
          const credit = Math.round((spP + scP - lpP - lcP) * 100) / 100;
          const risk = (w - credit) * 100 + FEE;
          if (!(credit >= 0.20 && credit < w && credit / w >= 0.20 && risk <= TRADE_MAX)) continue;
          const ratio = credit / w;
          if (!best || ratio > best.ratio) best = { sp, lp: sp - w, sc, lc: sc + w, w, credit, risk, ratio, spSym, lpSym, scSym, lcSym };
        }
        if (!best) { gateCount(SYM, 'signal fired but no condor met credit/risk thresholds'); done++; continue; }
        gateCount(SYM, 'condor opened');
        // simulate exit on 5-min marks from the signal bar forward
        const post5 = fiveMin(B, sigBar.min, 960);
        let exitDebit = null, exitWhy = 'settle-at-close', breaches = 0;
        for (let i = 0; i < post5.length; i++) {
          const b = post5[i], t = (B.find(x => x.min === b.min + 4) || B[B.length - 1]).t;
          if (b.min >= TIME_EXIT) { const d2 = debitAt(best, priceAt, t); if (d2 !== null) { exitDebit = d2; exitWhy = 'time'; break; } }
          if (b.c < low || b.c > high) breaches++; else breaches = 0;
          if (breaches >= 2) { const d2 = debitAt(best, priceAt, t); if (d2 !== null) { exitDebit = d2; exitWhy = 'range-break'; break; } }
          const d2 = debitAt(best, priceAt, t);
          if (d2 !== null) {
            if (d2 <= best.credit * 0.5) { exitDebit = d2; exitWhy = 'target'; break; }
            if ((d2 - best.credit) * 100 >= TRADE_STOP) { exitDebit = d2; exitWhy = 'stop'; break; }
          }
        }
        if (exitDebit === null) {
          const S = B[B.length - 1].c;
          exitDebit = Math.max(0, S - best.sc) + Math.max(0, best.sp - S) - Math.max(0, S - best.lc) - Math.max(0, best.lp - S);
          exitDebit = Math.max(0, exitDebit); exitWhy = 'settle-at-close';
        }
        const pnl = Math.round((best.credit - exitDebit) * 10000) / 100;
        acc(SYM + '|' + split, pnl); acc(SYM + '|' + split + '|w' + best.w, pnl); acc(SYM + '|' + split + '|why-' + exitWhy, pnl); acc(SYM + '|both|' + split, pnl);
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); }
      done++; if (done % 60 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
  }
  function debitAt(best, priceAt, t) {
    const spP = priceAt(best.spSym, t), lpP = priceAt(best.lpSym, t), scP = priceAt(best.scSym, t), lcP = priceAt(best.lcSym, t);
    if (spP === null || lpP === null || scP === null || lcP === null) return null;
    return Math.round((spP + scP - lpP - lcP) * 100) / 100;
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  await save();
  return out;
};
