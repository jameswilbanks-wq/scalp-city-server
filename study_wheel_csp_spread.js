/* Study 21 (read-only): classic monthly PUT CREDIT SPREAD, on real historical option prices
   (James asked 2026-11-13, after bt20 showed naked cash-secured puts working on QQQ -- +$362/month
   implied at 5% OTM, PF 2.44, 90% win -- but a true cash-secured QQQ put needs strike*100 in cash
   (~$64-67k/contract at today's ~$680 price), which doesn't fit the $40,000 Wheel2 paper account at
   all. A put CREDIT SPREAD -- sell the same short put, buy a further-OTM put for protection -- defines
   the risk at the spread width instead of the full strike, cutting margin to roughly width*100
   (~$500-1000/contract for a $5-10 wide spread), which fits easily and leaves room for more than one
   contract. The question this study answers: does the edge bt20 found survive once you pay for the
   protective long leg, or does that premium eat the edge away?

   Rule tested: same cadence/strike as bt20's short leg (30-45 DTE closest to 37, 2% or 5% OTM short
   put), PLUS a long put bought further OTM by the spread's width (opts.widthPcts, default [0.01,0.02]
   -- 1% and 2% of the day's open price, rounded to whichever real listed strike is closest, so the
   width scales sensibly across AMZN/SPY/QQQ's very different share prices instead of using one fixed
   dollar width for all three). Net credit = short premium - long premium at entry. Exit: same 50%-of-
   credit profit target or 21-DTE close (judged on the SPREAD's value, short leg price minus long leg
   price) as every other wheel study here, else hold to expiration -- max loss (spread trades at full
   width) if the underlying closes at/below the long strike, partial loss/full credit in between,
   full credit kept if it closes at/above the short strike.

   Data/mechanics: same real-strike-grid probing as bt18-20, but now probing BOTH the short-strike
   grid and a long-strike grid (centered on short_strike - target_width) in one combined batched
   daily-bars request per cycle -- still one request per cycle, not per leg or per day. $1/leg/fill
   slippage, 2 legs x 2 fills (entry + exit) = $4 round trip per spread (double bt18-20's $2, since
   this trades two contracts instead of one). Same underlyings/OTM levels/~8-month data ceiling as
   bt19/bt20, for a clean comparison against both. Saved to kv opts.key (default 'bt21'). */
module.exports = async function studyWheelCspSpread(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const SYMS = opts.syms || ['AMZN', 'SPY', 'QQQ'], OTM_LEVELS = opts.otmLevels || [0.02, 0.05], WIDTH_PCTS = opts.widthPcts || [0.01, 0.02], KEY = opts.key || 'bt21';
  const days = opts.days || 260, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {}, cycles: [] }, M = {};
  const acc = (key, pnl, maxLoss, heldDays) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, maxLoss: 0, heldSum: 0 }; c.n++; c.net += pnl; c.heldSum += heldDays; if (maxLoss) c.maxLoss++; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => {
    const r2 = x => Math.round(x * 100) / 100; out.res = {};
    Object.keys(M).sort().forEach(k => {
      const c = M[k], avgHeld = c.heldSum / c.n;
      out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgPerCycle: r2(c.net / c.n), net: r2(c.net), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), maxLossPct: Math.round(100 * c.maxLoss / c.n), avgDaysHeld: Math.round(avgHeld), impliedMonthly: r2(c.net / c.n / avgHeld * 30) };
    });
  };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const thirdFriday = (y, m) => { const first = new Date(Date.UTC(y, m - 1, 1)), dow = first.getUTCDay(), fri = 1 + ((5 - dow + 7) % 7); return new Date(Date.UTC(y, m - 1, fri + 14)); };
  const pickExpiry = entryDate => {
    const e = new Date(entryDate + 'T00:00:00Z'), cands = [];
    for (let dm = 0; dm <= 2; dm++) { const d0 = new Date(e); d0.setUTCMonth(d0.getUTCMonth() + dm); const tf = thirdFriday(d0.getUTCFullYear(), d0.getUTCMonth() + 1); const diff = Math.round((tf - e) / 864e5); if (diff >= 28 && diff <= 49) cands.push({ tf, diff }); }
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs(a.diff - 37) - Math.abs(b.diff - 37));
    return cands[0].tf.toISOString().slice(0, 10);
  };
  const optBarsDailyMulti = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Day', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ day: b.t.slice(0, 10), t: Date.parse(b.t), c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    Object.values(m).forEach(a => a.sort((x, y) => x.t - y.t));
    return m;
  };
  const strikeGridNear = (center, span) => {
    const lo = center - span, hi = center + span, set = new Set();
    [1, 2.5, 5].forEach(inc => { for (let s = Math.ceil(lo / inc) * inc; s <= hi; s += inc) { if (s > 0) set.add(Math.round(s * 100) / 100); } });
    return [...set];
  };
  for (const SYM of SYMS) {
    try {
      out.progress = SYM + ': loading daily bars'; await save();
      const bars = [];
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Day', start: iso(now - days * 864e5), end: iso(now - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'raw' });
      (d.bars || []).forEach(b => bars.push({ day: b.t.slice(0, 10), t: Date.parse(b.t), o: b.o, c: b.c }));
      out.n[SYM] = { sessions: bars.length };
      if (bars.length < 10) continue;
      for (const otm of OTM_LEVELS) {
        for (const wPct of WIDTH_PCTS) {
          let i = 0, loopGuard = 0;
          while (i < bars.length - 1 && loopGuard++ < 500) {
            const D = bars[i];
            const expiry = pickExpiry(D.day);
            if (!expiry) { i++; continue; }
            try {
              const shortTarget = D.o * (1 - otm), width = D.o * wPct, longTarget = shortTarget - width;
              const shortGrid = strikeGridNear(shortTarget, D.o * 0.03);
              const longGrid = strikeGridNear(longTarget, D.o * 0.03);
              const allStrikes = [...new Set([...shortGrid, ...longGrid])];
              const symOf = s => SYM + ymdOf(expiry) + 'P' + String(Math.round(s * 1000)).padStart(8, '0');
              const windowEnd = Date.parse(expiry + 'T21:05:00Z');
              const byS = await optBarsDailyMulti(allStrikes.map(symOf), D.t, windowEnd);
              const sortedShort = [...shortGrid].sort((a, b) => Math.abs(a - shortTarget) - Math.abs(b - shortTarget));
              let shortStrike = null, shortArr = null;
              for (const s of sortedShort) { const a = byS[symOf(s)]; if (a && a.length >= 3 && a[0].c >= 0.02) { shortStrike = s; shortArr = a; break; } }
              if (!shortStrike) { skip(SYM + ' otm' + Math.round(otm * 100) + ' w' + Math.round(wPct * 100) + ' no short strike'); i++; continue; }
              const sortedLong = [...longGrid].filter(s => s < shortStrike).sort((a, b) => Math.abs(a - longTarget) - Math.abs(b - longTarget));
              let longStrike = null, longArr = null;
              for (const s of sortedLong) { const a = byS[symOf(s)]; if (a && a.length >= 3) { longStrike = s; longArr = a; break; } }
              if (!longStrike) { skip(SYM + ' otm' + Math.round(otm * 100) + ' w' + Math.round(wPct * 100) + ' no long strike'); i++; continue; }
              const alignByDay = (arr, day) => { for (const row of arr) if (row.day === day) return row.c; return null; };
              const shortEntry = shortArr[0].c, longEntry0 = alignByDay(longArr, shortArr[0].day);
              if (longEntry0 === null || longEntry0 >= shortEntry) { skip(SYM + ' bad long-leg entry price'); i++; continue; } // long leg must be cheaper than short, else no net credit
              const netCredit = shortEntry - longEntry0;
              const dte21Cutoff = windowEnd - 21 * 864e5;
              let exitDay = null, why = null;
              for (const row of shortArr) {
                if (row.t <= shortArr[0].t) continue;
                const lp = alignByDay(longArr, row.day); if (lp === null) continue;
                const spreadVal = row.c - lp;
                if (spreadVal <= netCredit * 0.5) { exitDay = row.day; why = 'profit50'; break; }
                if (row.t >= dte21Cutoff) { exitDay = row.day; why = 'dte21'; break; }
              }
              let exitValue, atMaxLoss = false;
              if (exitDay) {
                const sp = alignByDay(shortArr, exitDay), lp = alignByDay(longArr, exitDay);
                exitValue = (sp !== null && lp !== null) ? sp - lp : netCredit * 0.5;
              } else {
                const uClose = bars.find(b => b.day >= expiry) || bars[bars.length - 1];
                if (uClose.c >= shortStrike) { exitValue = 0; exitDay = uClose.day; }
                else if (uClose.c <= longStrike) { exitValue = shortStrike - longStrike; atMaxLoss = true; exitDay = uClose.day; }
                else { exitValue = shortStrike - uClose.c; exitDay = uClose.day; }
                why = atMaxLoss ? 'max-loss' : (exitValue === 0 ? 'expired-otm' : 'partial-itm');
              }
              const pnl = (netCredit - exitValue) * 100 - 4;
              const heldDays = Math.max(1, Math.round((Date.parse(exitDay) - D.t) / 864e5));
              const lvl = 'otm' + Math.round(otm * 100) + 'w' + Math.round(wPct * 100);
              acc(SYM + '|' + lvl, pnl, atMaxLoss, heldDays);
              out.cycles.push({ sym: SYM, lvl, entry: D.day, exit: exitDay, shortStrike, longStrike, credit: Math.round(netCredit * 100) / 100, pnl: Math.round(pnl * 100) / 100, why, heldDays });
              const ni = bars.findIndex(b => b.day > exitDay);
              i = ni === -1 ? bars.length : ni;
            } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D.day + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); i++; }
            await save();
          }
        }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
