/* Study 23 (read-only): can we find a profitable variant of the main book's "ema" trigger?

   James noticed (2026-11-13) the live "ema" trigger -- price closes across the 50-period EMA on
   1-minute bars, long on an upward close, inverse/put on a downward close (from the 2026-11-10
   studies bt2/bt3) -- is a steady loser: -$300 over the last 5 trading days (70 trades, PF 0.53),
   while sweep (the other live trigger) made +$60 (PF 1.5) over the same days. bt2/bt3 already
   showed every tested stop/exit combination over ~8 months of data stays below breakeven on BOTH
   symbols (best case PF 0.92) -- so unlike X9, this isn't an exit problem, it's the entry itself.

   This study varies the ENTRY instead of the exit: EMA period, bar timeframe, and whether to keep
   the existing "fresh cross" filter (EMA_FILTER in server.js -- skip crosses where the EMA slope
   AND VWAP side already agree with the trade, i.e. take only crosses that are a genuine surprise,
   not a late continuation). Combos tested (chosen to avoid redundant/noisy slices already studied
   elsewhere -- EMA9 on 1-minute bars is the X9 book's own signal, already known from bt11/bt12 to
   prefer 5-minute bars, so it's only tested here at 5-minute):
     tf=1min: EMA20, EMA50 (current live default)
     tf=5min: EMA9, EMA20, EMA50
   x filter: raw (no filter) / fresh (current live rule)
   = 10 entry variants per symbol.

   Exits tested on top of each entry variant, all with the standard -30% premium stop and flat by
   close, same methodology as bt11/bt12/bt22 (real option prices, walked minute-by-minute):
     'level' -- current live behavior: exit when price closes back through its OWN EMA (same period)
     'tp60'  -- fixed +60% take-profit
     'trail' -- arms at +25% unrealized, gives back 50% of the peak (X9's bt22 winner)

   One position at a time per entry variant (own busyUntil); a later signal is skipped while a
   variant is "in" the baseline 'level' exit window, same simplification bt22 used for TP/trail
   variants timed off the baseline exit. Real same-day option prices, $2/contract round-trip
   slippage (1 leg, 2 fills). Saved to kv opts.key (default 'bt23'). */
module.exports = async function studyEmaRedesign(ap, rh, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const days = opts.days || 260, now = opts.now || Date.now();
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0 }; c.n++; c.net += pnl; if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best) }; }); };
  const save = async () => { fin(); try { await kset(opts.key || 'bt23', out); } catch (e) {} };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    for (let i = 0; i < syms.length; i += 90) {
      do {
        const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
        Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
        pt = d.next_page_token; await sleep(gap);
      } while (pt);
    }
    return m;
  };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const agg = (raw, n) => {
    if (n === 1) return raw.map(x => ({ t: Date.parse(x.begins_at), o: +x.open_price, h: +x.high_price, l: +x.low_price, c: +x.close_price, v: +x.volume || 0 }));
    const ms = n * 60000, by = {};
    raw.forEach(x => { const t = Date.parse(x.begins_at), k = Math.floor(t / ms) * ms; (by[k] = by[k] || []).push(x); });
    return Object.keys(by).map(Number).sort((a, b) => a - b).map(k => {
      const g = by[k];
      return { t: k, o: +g[0].open_price, h: Math.max.apply(null, g.map(x => +x.high_price)), l: Math.min.apply(null, g.map(x => +x.low_price)), c: +g[g.length - 1].close_price, v: g.reduce((s, x) => s + (+x.volume || 0), 0) };
    });
  };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const etOf = t => { const o = {}; fmt.formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; }); let h = +o.hour; if (h === 24) h = 0; return { day: o.year + '-' + o.month + '-' + o.day, min: h * 60 + +o.minute }; };
  const COMBOS = opts.combos || [{ tf: 1, ema: 20 }, { tf: 1, ema: 50 }, { tf: 5, ema: 9 }, { tf: 5, ema: 20 }, { tf: 5, ema: 50 }];
  const EMA_PERIODS = [...new Set(COMBOS.map(c => c.ema))], TFS = [...new Set(COMBOS.map(c => c.tf))];
  const withIndicators = bars => {
    const ks = {}; EMA_PERIODS.forEach(p => ks[p] = 2 / (p + 1));
    let pv = 0, vv = 0, day = '';
    bars.forEach((b, i) => {
      const e = etOf(b.t); b.day = e.day; b.min = e.min;
      if (b.day !== day) { day = b.day; pv = 0; vv = 0; }
      EMA_PERIODS.forEach(p => { const prev = i && bars[i - 1].day === b.day ? bars[i - 1]['e' + p] : b.c; b['e' + p] = b.c * ks[p] + prev * (1 - ks[p]); });
      const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; b.vwap = vv ? pv / vv : b.c;
    });
    return bars;
  };
  const TP_LEVELS = opts.tpLevels || [60];
  const STOP_PCT = opts.stopPct === undefined ? 30 : opts.stopPct;
  const TRAIL = opts.trail || { arm: 25, give: 0.5 };
  const FILTS = opts.filters || [false, true]; // false = raw, true = skip "stale" continuation crosses (current live EMA_FILTER rule)
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await save();
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
        const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
        (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
      }
      const raw = Object.keys(st).sort((a, b) => a - b).map(k => st[k]);
      if (raw.length < 20000) { out.n[SYM] = 'too few bars'; continue; }
      const frames = {}; TFS.forEach(tf => { frames[tf] = withIndicators(agg(raw, tf)); });
      const dayList = []; frames[1].forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
      out.n[SYM] = { sessions: dayList.length, rawBars: raw.length };
      const plans = {};
      COMBOS.forEach(({ tf, ema: emaP }) => {
        const bars = frames[tf], step = tf * 60000, ek = 'e' + emaP;
        FILTS.forEach(filt => {
          const key = tf + 'm|ema' + emaP + '|' + (filt ? 'fresh' : 'raw');
          const list = []; let busyUntil = -1;
          for (let k = 1; k < bars.length; k++) {
            const b = bars[k], pr = bars[k - 1]; if (pr.day !== b.day) continue;
            if (b.min < 585 || b.min > 930) continue;
            if (b.t < busyUntil) continue;
            let dir = 0;
            if (pr.c <= pr[ek] && b.c > b[ek]) dir = 1; else if (pr.c >= pr[ek] && b.c < b[ek]) dir = -1;
            if (!dir) continue;
            if (filt) { const pk5 = bars[k - 5] || pr; if (dir * (b[ek] - pk5[ek]) > 0 && dir * (b.c - b.vwap) > 0) continue; }
            const e = bars[k + 1]; if (!e || e.day !== b.day) continue;
            let xt = null;
            for (let q = k + 1; q < bars.length && bars[q].day === b.day; q++) {
              const x = bars[q]; if (x.min >= 930) { xt = x.t; break; }
              if (dir > 0 ? x.c < x[ek] : x.c > x[ek]) { xt = x.t + step; break; }
            }
            if (xt === null) xt = bars[bars.length - 1].t;
            busyUntil = xt;
            list.push({ day: b.day, dir, tIn: e.t, xt, s: SYM + ymdOf(b.day) + (dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') });
          }
          plans[key] = list;
        });
      });
      const byDay = {}; Object.keys(plans).forEach(key => plans[key].forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(Object.assign({ key }, p)); }));
      let done = 0;
      for (const D of Object.keys(byDay).sort()) {
        try {
          const todays = byDay[D], first = Math.min(...todays.map(p => p.tIn));
          const ob = await optBars([...new Set(todays.map(p => p.s))], first - 60000, Date.parse(D + 'T21:05:00Z'));
          todays.forEach(p => {
            const arr = ob[p.s]; if (!arr) { skip(SYM + ' no option price'); return; }
            let pin = null, tFill = null; for (const b of arr) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pin = b.o; tFill = b.t; break; } if (b.t > p.tIn + 3 * 60000) break; }
            if (pin === null || !(pin >= 0.05)) { skip(SYM + ' no usable entry price'); return; }
            const sellAt = t => { for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
            const rec = (name, pout) => { if (pout === null) { skip(SYM + ' no exit price'); return; } const pnl = (pout - pin) * 100 - 2; acc(SYM + '|' + p.key + '|' + name, pnl); };
            const run = (tpPct, trail) => {
              let peakPct = -Infinity;
              for (let t = tFill + 60000; t < p.xt; t += 60000) {
                const v = pxAt(arr, t, 2); if (v === null) continue;
                const pct = (v / pin - 1) * 100;
                if (pct <= -STOP_PCT) return v;
                if (tpPct !== null && pct >= tpPct) return v;
                if (trail) { if (pct > peakPct) peakPct = pct; if (peakPct >= trail.arm && pct <= peakPct * (1 - trail.give)) return v; }
              }
              return sellAt(p.xt);
            };
            rec('level', run(null, null));
            TP_LEVELS.forEach(tp => rec('tp' + tp, run(tp, null)));
            rec('trail', run(null, TRAIL));
          });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
        done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + Object.keys(byDay).length + ' days'; await save(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
