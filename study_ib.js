/* Study (Stage 0, read-only, no trading effect): "IB" / "Levels" strategy -- underlying-price signal study only, NO options,
   NO money. Source: YouTube "my trading strategy is boring, but it made me $100,000 in 2 months" (youtu.be/LfSeAMzKjwM),
   transcribed by another Claude session since this server has no video access; full spec in the project doc
   claude/ib-strategy-spec.md. Frozen v1 rules below, James-approved to build 2026-11-14. SPY/QQQ, 5-minute bars.

   Mechanics:
   - IB (Initial Balance) = 9:30-10:30 ET (bars at min 570..625, 12 bars). IBH/IBL = high/low of those bars. IBM = mid. IBW = IBH-IBL.
   - AVWAP anchored at 9:30: cumulative sum(vw*v)/sum(v) using each bar's own vw (Alpaca-reported volume-weighted price) and v (volume).
   - Day filters (no trade at all that day): IBW outside 0.20%-0.90% of the day's open price (placeholder band, per spec);
     chop/flat-VWAP day = price crosses AVWAP 4+ times within the IB window (placeholder). Economic-event/holiday filters
     (CPI/PPI/FOMC/NFP) are NOT implemented here -- no reliable calendar feed wired up for Stage 0; flagged as a known gap,
     see claude/ib-strategy-spec.md and EXPERIMENT_LOG.md. This likely makes results slightly optimistic vs. the full spec.
   - Setup A, Failed Auction (FA): after 10:30, a 5-min bar closes beyond IBH/IBL (break). Within the next 3 bars, a bar
     closes back inside the IB (failure). Entry = next bar's open, direction opposite the break. Target = IBM.
     Stop = excursion extreme (worst high/low during break-to-failure) +/- 0.02% buffer. Skip if R/R to IBM < 1.0.
   - Setup B, Trend Continuation (TC): IB trend if |IB close-IB open| >= 50% of IBW (placeholder). After 10:30, price AND
     AVWAP both within 10% of IBW of IBM (confluence zone, placeholder). Trigger: a bar's range touches the zone and its
     close exits the zone in the trend direction. Entry = next bar's open. Target = IBH/IBL (trend extreme).
     Stop = touch bar's extreme +/- 0.02% buffer. Skip if R/R < 1.5.
   - One FA and one TC per symbol per day. Entries 10:30 ET - 15:00 ET. Flat (time exit) at 15:30 ET. Stop-first tie-break
     when a bar's range touches both stop and target. Cost haircut: 0.05R per trade (stand-in for spread/slippage; this
     is underlying-only, no option costs modeled -- that is Stage 1, a separate, not-yet-built study).
   - Dev/holdout: dev = before 2026-07-14, holdout = 2026-07-14 onward (~last 4 months), matching the pre-registered plan.
   - Also runs a +/-25% parameter-sensitivity sweep on the 4 placeholder parameters (IBW band, chop-cross count, TC trend
     threshold, confluence zone width) and a "drop best 5 trades" robustness check, per the spec's pass criteria -- this
     study reports the numbers; it does NOT itself decide pass/fail. kv 'bt24'. */
module.exports = async function studyIB(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt24', SPLIT = opts.split || '2026-07-14';
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {}, sensitivity: {}, dropBest5: {}, gaps: {}, note: 'Stage 0: underlying-price signal only, no options, no trading effect. Economic-event/holiday filters not implemented (no calendar feed) -- see claude/ib-strategy-spec.md.' };
  const trades = {}; // key -> [{r: R-multiple, day}]
  const addTrade = (key, r, day) => { (trades[key] = trades[key] || []).push({ r, day }); };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const BASE = { ibwLo: 0.20, ibwHi: 0.90, chopCross: 4, trendFrac: 0.50, zoneFrac: 0.10 };
  const HAIRCUT = 0.05, BUF = 0.0002; // 0.02%

  const statsOf = (arr) => {
    if (!arr || !arr.length) return { n: 0 };
    const n = arr.length, sum = arr.reduce((s, t) => s + t.r, 0), avg = sum / n;
    const wins = arr.filter(t => t.r > 0), losses = arr.filter(t => t.r <= 0);
    const gw = wins.reduce((s, t) => s + t.r, 0), gl = -losses.reduce((s, t) => s + t.r, 0);
    return { n, avgR: Math.round(avg * 1000) / 1000, winPct: Math.round(1000 * wins.length / n) / 10, pf: gl > 0.0001 ? Math.round((gw / gl) * 100) / 100 : null };
  };
  const dropBest5 = (arr) => { if (!arr || arr.length <= 5) return null; const s = [...arr].sort((a, b) => b.r - a.r).slice(5); return statsOf(s); };

  async function fetchBars(sym, from, to) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + sym + '/bars', { timeframe: '5Min', start: from + 'T00:00:00Z', end: to, feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => {
        const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return;
        (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw: b.vw !== undefined ? b.vw : b.c });
      });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    return days;
  }

  // run the full engine for one symbol's day list with a given parameter set; returns nothing, pushes into `trades`
  function runDay(SYM, D, B, P, suffix) {
    if (B.length < 12 || B[0].min !== 570) { skip('short/misaligned day'); return; }
    const ib = B.slice(0, 12);
    if (ib[ib.length - 1].min !== 625) { skip('IB window incomplete'); return; }
    const IBH = Math.max(...ib.map(b => b.h)), IBL = Math.min(...ib.map(b => b.l)), IBM = (IBH + IBL) / 2, IBW = IBH - IBL;
    const price0 = B[0].o;
    const ibwPct = IBW / price0 * 100;
    if (ibwPct < P.ibwLo || ibwPct > P.ibwHi) { skip('day filter: IBW out of band'); return; }
    // AVWAP across IB window, for the chop filter; continues through the day for setup use
    let cumPV = 0, cumV = 0; const avwapAt = [];
    B.forEach(b => { cumPV += b.vw * b.v; cumV += b.v; avwapAt.push(cumV > 0 ? cumPV / cumV : b.c); });
    let crosses = 0, prevSide = null;
    for (let i = 0; i < 12; i++) { const side = B[i].c >= avwapAt[i] ? 1 : -1; if (prevSide !== null && side !== prevSide) crosses++; prevSide = side; }
    if (crosses >= P.chopCross) { skip('day filter: chop (AVWAP crosses)'); return; }

    const buf = (x) => x * BUF;
    const entryWindowEnd = 900; // 15:00 ET
    const flatMin = 930; // 15:30 ET

    // bar-by-bar walk to exit: stop, target, or time-out at the 15:30 open; stop checked first on a bar that touches both
    const exitWithTarget = (dir, entryIdx, entryPx, stop0, target) => {
      const R = Math.abs(entryPx - stop0); if (!(R > 0.0001 * entryPx)) return null;
      let stop = stop0;
      for (let q = entryIdx; q < B.length; q++) {
        const x = B[q];
        if (x.min >= flatMin) return { r: dir * (x.o - entryPx) / R, why: 'time' };
        const hitStop = dir > 0 ? x.l <= stop : x.h >= stop;
        const hitTarget = dir > 0 ? x.h >= target : x.l <= target;
        if (hitStop && hitTarget) return { r: dir * (stop - entryPx) / R, why: 'stop(tie)' }; // stop-first tie-break
        if (hitStop) return { r: dir * (stop - entryPx) / R, why: 'stop' };
        if (hitTarget) return { r: dir * (target - entryPx) / R, why: 'target' };
      }
      const L = B[B.length - 1]; return { r: dir * (L.c - entryPx) / R, why: 'time' };
    };

    // --- Setup A: Failed Auction ---
    let faTaken = false;
    for (let k = 12; k < B.length - 1 && !faTaken; k++) {
      if (B[k].min >= entryWindowEnd) break;
      const dir0 = B[k].c > IBH ? 1 : B[k].c < IBL ? -1 : 0;
      if (!dir0) continue;
      // within next 3 bars, find a close back inside the IB
      let failIdx = -1, worst = dir0 > 0 ? B[k].h : B[k].l;
      for (let j = k + 1; j <= Math.min(k + 3, B.length - 1); j++) {
        worst = dir0 > 0 ? Math.max(worst, B[j].h) : Math.min(worst, B[j].l);
        if (B[j].c <= IBH && B[j].c >= IBL) { failIdx = j; break; }
      }
      if (failIdx === -1 || failIdx + 1 >= B.length) continue;
      const entryIdx = failIdx + 1, entryPx = B[entryIdx].o;
      const dir = -dir0; // trade opposite the break, back toward IBM
      const stop0 = dir > 0 ? worst - buf(worst) : worst + buf(worst);
      const R0 = Math.abs(entryPx - stop0);
      if (!(R0 > 0.0001 * entryPx) || dir * (entryPx - stop0) <= 0) { skip('FA: entry already through stop'); continue; }
      const rr = Math.abs(IBM - entryPx) / R0;
      if (rr < 1.0) { skip('FA: R/R below 1.0'); continue; }
      const res = exitWithTarget(dir, entryIdx, entryPx, stop0, IBM);
      if (!res) { skip('FA: bad R'); continue; }
      const netR = res.r - HAIRCUT;
      addTrade(SYM + '|FA|' + suffix, netR, D); addTrade(SYM + '|FA|' + suffix + '|why-' + res.why, netR, D);
      faTaken = true;
    }

    // --- Setup B: Trend Continuation ---
    const ibOpen = ib[0].o, ibClose = ib[ib.length - 1].c;
    const trendUp = (ibClose - ibOpen) >= P.trendFrac * IBW, trendDown = (ibOpen - ibClose) >= P.trendFrac * IBW;
    if (trendUp || trendDown) {
      const dir = trendUp ? 1 : -1, zone = P.zoneFrac * IBW;
      let tcTaken = false;
      for (let k = 12; k < B.length - 1 && !tcTaken; k++) {
        if (B[k].min >= entryWindowEnd) break;
        const touches = B[k].l <= IBM + zone && B[k].h >= IBM - zone;
        if (!touches) continue;
        const avwapInZone = Math.abs(avwapAt[k] - IBM) <= zone;
        if (!avwapInZone) continue;
        const closesOut = dir > 0 ? B[k].c > IBM + zone : B[k].c < IBM - zone;
        if (!closesOut) continue;
        const entryIdx = k + 1, entryPx = B[entryIdx].o;
        const touchExtreme = dir > 0 ? B[k].l : B[k].h;
        const stop0 = dir > 0 ? touchExtreme - buf(touchExtreme) : touchExtreme + buf(touchExtreme);
        const R0 = Math.abs(entryPx - stop0);
        if (!(R0 > 0.0001 * entryPx) || dir * (entryPx - stop0) <= 0) { skip('TC: entry already through stop'); continue; }
        const target = dir > 0 ? IBH : IBL;
        const rr = Math.abs(target - entryPx) / R0;
        if (rr < 1.5) { skip('TC: R/R below 1.5'); continue; }
        const res = exitWithTarget(dir, entryIdx, entryPx, stop0, target);
        if (!res) { skip('TC: bad R'); continue; }
        const netR = res.r - HAIRCUT;
        addTrade(SYM + '|TC|' + suffix, netR, D); addTrade(SYM + '|TC|' + suffix + '|why-' + res.why, netR, D);
        tcTaken = true;
      }
    }
  }

  const save = async () => {
    out.res = {};
    Object.keys(trades).sort().forEach(k => { out.res[k] = statsOf(trades[k]); });
    try { await kset(KEY, out); } catch (e) { }
  };

  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = await fetchBars(SYM, opts.from || '2024-03-01', opts.to || iso(Date.now() - 20 * 60000));
    const dayList = Object.keys(days).sort().filter(d => days[d].length >= 70 && days[d][0].min === 570);
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    let done = 0;
    for (const D of dayList) {
      const B = days[D], suffix = D < SPLIT ? 'dev' : 'holdout';
      try { runDay(SYM, D, B, BASE, suffix); } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); }
      done++; if (done % 80 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
    // parameter sensitivity sweep, +/-25% on each placeholder, dev+holdout combined (all days), separate trade buckets
    const sweeps = [
      ['ibwBand', { ibwLo: BASE.ibwLo * 0.75, ibwHi: BASE.ibwHi * 1.25 }, { ibwLo: BASE.ibwLo * 1.25, ibwHi: BASE.ibwHi * 0.75 }],
      ['chopCross', { chopCross: Math.max(1, Math.round(BASE.chopCross * 0.75)) }, { chopCross: Math.round(BASE.chopCross * 1.25) }],
      ['trendFrac', { trendFrac: BASE.trendFrac * 0.75 }, { trendFrac: BASE.trendFrac * 1.25 }],
      ['zoneFrac', { zoneFrac: BASE.zoneFrac * 0.75 }, { zoneFrac: BASE.zoneFrac * 1.25 }],
    ];
    for (const [name, lo, hi] of sweeps) {
      for (const [tag, over] of [['-25', lo], ['+25', hi]]) {
        const P = Object.assign({}, BASE, over);
        // run every day into a 'sweep'-suffixed bucket (addTrade appends across days under the same key), then move
        // the two setup totals into the sensitivity report and discard everything tagged 'sweep' before the next pass
        for (const D of dayList) {
          const B = days[D];
          try { runDay(SYM, D, B, P, 'sweep'); } catch (e) { /* a bad day in a sensitivity pass doesn't fail the study */ }
        }
        out.sensitivity[SYM + '|' + name + tag + '|FA'] = statsOf(trades[SYM + '|FA|sweep']);
        out.sensitivity[SYM + '|' + name + tag + '|TC'] = statsOf(trades[SYM + '|TC|sweep']);
        Object.keys(trades).forEach(k => { if (k.startsWith(SYM + '|') && k.includes('|sweep')) delete trades[k]; });
      }
      await save();
    }
  }

  // drop-best-5 robustness, on the combined (dev+holdout) trade list per setup/symbol
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    for (const setup of ['FA', 'TC']) {
      const all = [...(trades[SYM + '|' + setup + '|dev'] || []), ...(trades[SYM + '|' + setup + '|holdout'] || [])];
      out.dropBest5[SYM + '|' + setup] = dropBest5(all);
    }
  }

  out.progress = 'done'; out.done = iso(Date.now());
  await save();
  return out;
};
