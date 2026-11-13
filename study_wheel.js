/* Study 18 (read-only): the approved wheel covered-call strategy for the Wheel2 paper account (James approved 2026-11-13
   after the buy/sell logic proposal), backtested on REAL historical AMZN option prices.

   Rule being tested, exactly as approved:
   - Underlying: AMZN, assumed fully covered (100 shares held per contract) -- this study only prices the SHORT CALL
     income leg, not the stock's own P&L (the stock is the wheel's collateral, held continuously; the covered call is
     an income overlay on top of it, which is the thing James asked to see priced).
   - Entry: once per session, "shortly after open" -- approximated here as that day's (D's) regular-session open print.
     Strike = whichever REAL strike nearest the target OTM% actually has option price data that day (first pass,
     2026-11-13, assumed AMZN strikes were all $1-wide and got only 25 of 164 candidate days -- almost certainly
     because most of those guessed $1 strikes don't exist on AMZN's real chain; fixed by probing a spread of real
     candidate strikes at $1/$2.50/$5 increments spanning 0-10% OTM in one batched request per day, 99 of 165 days
     usable once real strikes were used instead of a guessed increment).
   - Real 2% OTM result (99 sessions, all the real-strike data this feed has, Mar-Nov 2026): LOSES money -- net
     -$2,258 hold / -$2,367 early20 over the period, implied -$479 to -$502/month, despite an 82-86% win rate.
     AMZN spent this window in a strong, often-gappy uptrend; a call only 2% OTM got blown through often enough
     (worst single day -$2,791) that the capped-upside cost outweighs the daily premium. James asked (2026-11-13)
     to also test wider OTM distances to see if more room fixes this -- opts.otmLevels (default [0.02,0.04,0.06,0.08])
     controls which target OTM%s are tested side by side; one broad per-day strike probe (0-10% OTM) is reused
     across all of them, so testing more levels doesn't mean more API requests per day.
   - Expiration: 1-DTE, i.e. the very next trading session (D+1). One contract sold per day; yesterday's contract is
     already gone (expired or assigned) by the time today's is sold.
   - Hold-to-expiration default: let it ride to D+1's close. OTM at D+1 close -> expires worthless, full credit kept,
     no assignment. ITM at D+1 close -> assigned; economically that's the short call being closed at intrinsic value
     (shares called away at the strike), and per James's answer the very next session we buy the shares back immediately
     and sell a fresh call -- so the cycle just continues; this study marks that day 'assigned' and prices the option
     leg at intrinsic value, same as letting assignment happen.
   - Variant 'early20' (the optional rule floated in the proposal): buy back early if the option's cost-to-close drops
     to <=20% of the credit received, locking in the other 80% rather than riding it to zero/expiration. Tested
     side-by-side against the hold-to-expiration default so James can see whether it's worth doing.

   Data: AMZN daily bars (ap /v2/stocks/AMZN/bars) just to find each day's open and the next day's close/strike anchor --
   tiny request, not the multi-year 1-minute-bar-per-symbol pull the FP/RVB studies use (today's OOM crash loop came
   from exactly that pattern piling up at boot, so this study is deliberately lean: one small underlying request, then
   one narrow 1-min OPTION-bars request per trading day for the single contract that day actually trades, discarded
   right after that day is scored -- nothing multi-day is held in memory). Options data is the same indicative/
   trade-derived Alpaca feed as every other study in this codebase (confirmed 2026-11-12: even the SIP stock-data
   entitlement has no OPRA options agreement), so entry/exit prices here are trade-derived approximations of
   bid/ask, not a true NBBO fill. $1/contract/fill slippage ($2 round trip), matching the convention used elsewhere
   in this codebase. Split: sessions before 2026-01-01 = train, 2026-01-01 onward = lock. Saved to kv opts.key
   (default 'bt18'). opts.days controls the lookback window (default 240 sessions back from now); single-name
   weekly-option history can thin out or vanish further back than index ETFs, so sparse/missing days are recorded
   in out.skipped rather than guessed at. */
module.exports = async function studyWheel(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const SYM = opts.sym || 'AMZN', KEY = opts.key || 'bt18', days = opts.days || 240, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {}, days: [] }, M = {};
  const acc = (key, pnl, assigned) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, assigned: 0 }; c.n++; c.net += pnl; if (assigned) c.assigned++; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => {
    const r2 = x => Math.round(x * 100) / 100; out.res = {};
    Object.keys(M).sort().forEach(k => {
      const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgPerDay: r2(c.net / c.n), net: r2(c.net), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), assignedPct: Math.round(100 * c.assigned / c.n), impliedMonthly: r2(c.net / c.n * 21) };
    });
  };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const OTM_LEVELS = opts.otmLevels || [0.02, 0.04, 0.06, 0.08];
  // one broad batch of real strike candidates per day, spanning 0% to maxOtm+2% OTM at $1/$2.50/$5 increments --
  // AMZN's chain uses different increments at different price levels (and it can change over time), so rather than
  // assume one, probe a real-strike grid and let whichever ones actually have traded data win. Reused across every
  // OTM_LEVELS target for that day so testing more OTM distances costs no extra requests.
  const maxOtm = Math.max(...OTM_LEVELS);
  const strikeGrid = open => {
    const lo = open, hi = open * (1 + maxOtm + 0.02), set = new Set();
    [1, 2.5, 5].forEach(inc => { for (let s = Math.floor(lo / inc) * inc; s <= hi; s += inc) { if (s > 0) set.add(Math.round(s * 100) / 100); } });
    return [...set].sort((a, b) => a - b);
  };
  const nearestWithData = (grid, byS, symOf, target, dayStartEt) => {
    const sorted = [...grid].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    for (const s of sorted) {
      const a = byS[symOf(s)]; if (!a || !a.length) continue;
      let p = null; for (const b of a) { if (b.t >= dayStartEt && b.t <= dayStartEt + 6 * 60000) { p = b.o; break; } }
      if (p !== null && p >= 0.02) return { strike: s, arr: a, pin: p };
    }
    return null;
  };
  const optBarsMulti = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  try {
    out.progress = 'loading ' + SYM + ' daily bars'; await save();
    const bars = [];
    { // one request for the whole daily-bar window -- tiny payload, no multi-year minute-bar accumulation
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Day', start: iso(now - days * 864e5), end: iso(now - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'raw' });
      (d.bars || []).forEach(b => bars.push({ day: b.t.slice(0, 10), t: Date.parse(b.t), o: b.o, c: b.c, h: b.h, l: b.l }));
    }
    out.n.sessions = bars.length;
    if (bars.length < 5) { out.progress = 'done'; out.done = iso(Date.now()); fin(); return out; }
    let done = 0;
    for (let i = 0; i < bars.length - 1; i++) {
      const D = bars[i], D1 = bars[i + 1];
      const split = D.day < '2026-01-01' ? 'train' : 'lock';
      try {
        const dayStartEt = Date.parse(D.day + 'T13:30:00Z'); // 9:30 ET in UTC (EST; off by an hour during EDT, acceptable for a 1-min-bar lookup window)
        const nextCloseEt = Date.parse(D1.day + 'T21:05:00Z'); // just past 16:00 ET close, generous pad
        const grid = strikeGrid(D.o);
        const symOf = s => SYM + ymdOf(D1.day) + 'C' + String(Math.round(s * 1000)).padStart(8, '0');
        const byS = await optBarsMulti(grid.map(symOf), dayStartEt, nextCloseEt); // one request/day covers every OTM_LEVELS target below
        const dayRow = { d: D.day, levels: {} };
        let anyLevel = false;
        for (const otm of OTM_LEVELS) {
          const hit = nearestWithData(grid, byS, symOf, D.o * (1 + otm), dayStartEt);
          if (!hit) { skip('no real strike with usable entry credit (otm' + Math.round(otm * 100) + ')'); continue; }
          anyLevel = true;
          const { strike, arr, pin } = hit;
          const intrinsicAtClose = Math.max(D1.c - strike, 0);
          const assigned = D1.c > strike;
          let lastBeforeClose = null; for (const b of arr) { if (b.t <= nextCloseEt) lastBeforeClose = b.c; }
          const holdExit = lastBeforeClose !== null ? lastBeforeClose : intrinsicAtClose;
          const holdPnl = (pin - holdExit) * 100 - 2;
          const lvl = 'otm' + Math.round(otm * 100);
          acc(SYM + '|' + lvl + '|hold|' + split, holdPnl, assigned); acc(SYM + '|' + lvl + '|hold|ALL', holdPnl, assigned);
          let earlyExit = null, earlyWhy = 'held';
          for (const b of arr) { if (b.t <= dayStartEt + 6 * 60000) continue; if (b.c <= pin * 0.20) { earlyExit = b.c; earlyWhy = 'early20'; break; } }
          if (earlyExit === null) { earlyExit = holdExit; earlyWhy = assigned ? 'assigned' : 'expired-otm'; }
          const earlyPnl = (pin - earlyExit) * 100 - 2;
          acc(SYM + '|' + lvl + '|early20|' + split, earlyPnl, assigned && earlyWhy !== 'early20'); acc(SYM + '|' + lvl + '|early20|ALL', earlyPnl, assigned && earlyWhy !== 'early20');
          dayRow.levels[lvl] = { strike, credit: Math.round(pin * 100) / 100, holdPnl: Math.round(holdPnl * 100) / 100, earlyPnl: Math.round(earlyPnl * 100) / 100, assigned, why: earlyWhy };
        }
        if (anyLevel) out.days.push(dayRow);
      } catch (e) { out.errs++; out.lastErr = D.day + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++; if (done % 20 === 0) { out.progress = done + ' of ' + (bars.length - 1) + ' sessions'; await save(); }
    }
  } catch (e) { out.errs++; out.lastErr = String(e && e.message || e).slice(0, 160); }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
