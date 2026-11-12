/* Study 17 (read-only): "RVB" (James's attached SPY_QQQ_ORB_Strategy.md spec, 2026-11-12) vs the already-live ORB15
   book, SPY and QQQ, REAL 1-minute 0DTE option prices, Mar 2024 - now. Named RVB (relative-volume breakout) so it
   stays a distinct strategy from the live ORB/ORB15 book, per James's instruction to keep them separate.

   Two tracks share the same underlying/volume data pull:

   Track "rvb" -- the new spec, run as its own candidate: range = first 5 one-minute bars (9:30-9:34 ET); direction
   from that candle's open vs close; RVOL = that 5-minute volume / the trailing 14-session average of the same
   window (>=1.0 required for the "rvolOn" split; "rvolOff" keeps the identical trades with no filter, so the
   split is diagnostic, not two different simulations). Confirmation: first 1-minute close beyond the range,
   9:36-10:30 ET only; chase-limit reject if that close is already beyond range +/- 0.25x the range width. One
   attempt per symbol per day. Structure: 'out' = buy the at-the-money same-day option outright (a same-rules
   baseline to compare against); 'sp2'..'sp5' = a debit vertical, long the same ATM leg against a short leg $2/
   $3/$4/$5 away. No historical greeks are available from this feed, so the long leg is the nearest strike to
   spot rather than a delta-banded pick -- flagged, not a faithful replication of the spec's 0.45-0.60 delta rule.
   Entry gated at D0 <= 1.80 and D0 <= width/2.25 (spec's thresholds). Exit priority: underlying stop (opposite
   range extreme, checked on 1-minute touches, not live ticks), spread/option value reaching a $140 loss trigger
   (incl. a flat $4 two-round-trip cost estimate for the spread, $2 for the outright), target (debit spread: value
   >= 2x entry debit; outright: 1.25R, matching the live book so the outright split is comparable), time exit 70
   minutes before the close (14:50 ET, per spec) -- all checked off 1-minute closes, not continuous quotes.

   Track "ovl" -- the RVOL filter alone, bolted onto the EXACT config already live (15-minute range, outright
   at-the-money option, 1.25R target, breakeven at +0.5R, accept until 15:00, flat by 15:30 -- see study_orb15.js).
   Isolates whether this one idea from the spec helps what's actually running, holding everything else fixed.

   Data: IEX 1-minute stock bars (same free feed every other study here uses) for range/direction/volume; the
   Alpaca paper-trading MCP connection checked on 2026-11-12 has real SIP stock data but NOT an OPRA option
   agreement, so option prices are the same indicative/trade-derived feed as every other study -- no improvement
   there. IEX volume likely understates true consolidated volume, but RVOL is a same-feed ratio (today vs this
   feed's own 14-session trailing average), so the comparison should still be informative even if the absolute
   level is biased low. $0.01-per-fill slippage, as in bt13. kv 'bt17'. */
module.exports = async function studyRvb(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const KEY = opts.key || 'bt17', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, res: {}, n: {} }, M = {};
  const acc = (key, pnl, r) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, worst: 0, best: 0, r: 0 }; c.n++; c.net += pnl; c.r += (r || 0); if (pnl > 0) { c.w++; c.gw += pnl; } else c.gl += -pnl; if (pnl < c.worst) c.worst = pnl; if (pnl > c.best) c.best = pnl; };
  const skip = k => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const fin = () => { const r2 = x => Math.round(x * 100) / 100; out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), pf: c.gl > 0.01 ? r2(c.gw / c.gl) : null, worst: Math.round(c.worst), best: Math.round(c.best), avgR: r2(c.r / c.n) }; }); };
  const save = async () => { fin(); try { await kset(KEY, out); } catch (e) {} };
  const pxAt = (arr, t, maxAge) => { if (!arr) return null; let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } return a >= 0 && t - arr[a].t <= maxAge * 60000 ? arr[a].c : null; };
  const optBars = async (syms, start, end) => {
    const m = {}; let pt;
    do {
      const d = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt });
      Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); });
      pt = d.next_page_token; await sleep(gap);
    } while (pt);
    return m;
  };
  const sellAt = (arr, t) => { if (!arr) return null; for (let j = 0; j <= 5; j++) { const v = pxAt(arr, t + j * 60000, 3); if (v !== null) return v; } return pxAt(arr, t, 30); };
  const SPREAD_W = [2, 3, 4, 5];

  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    const days = {}; let tok;
    do {
      const d = await ap('/v2/stocks/' + SYM + '/bars', { timeframe: '1Min', start: (opts.from || '2024-03-01') + 'T00:00:00Z', end: opts.to || iso(Date.now() - 20 * 60000), feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      (d.bars || []).forEach(b => { const t = Date.parse(b.t), e = et(t); if (e.min < 570 || e.min >= 960) return; (days[e.day] = days[e.day] || []).push({ t, min: e.min, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); });
      tok = d.next_page_token; await sleep(gap);
    } while (tok);
    const dayList = Object.keys(days).sort().filter(d => { const B = days[d]; return B.length >= 70 && B[0] && B[0].min === 570 && B[14] && B[14].min === 584; });
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    const vol5 = {}; dayList.forEach(d => { vol5[d] = days[d].slice(0, 5).reduce((s, b) => s + b.v, 0); });

    let done = 0;
    for (let di = 0; di < dayList.length; di++) {
      const D = dayList[di], B = days[D], split = D < '2026-01-01' ? 'train' : 'lock', ymd = D.slice(2, 4) + D.slice(5, 7) + D.slice(8, 10);
      let rvolOk = null;
      if (di >= 14) { const prior = dayList.slice(di - 14, di).map(x => vol5[x]), avg = prior.reduce((s, x) => s + x, 0) / prior.length; rvolOk = avg > 0 ? vol5[D] / avg >= 1.0 : null; }
      try {
        const o5 = B[0].o, c5 = B[4].c, h5 = Math.max(B[0].h, B[1].h, B[2].h, B[3].h, B[4].h), l5 = Math.min(B[0].l, B[1].l, B[2].l, B[3].l, B[4].l), w5 = h5 - l5;
        const h15 = Math.max(...B.slice(0, 15).map(x => x.h)), l15 = Math.min(...B.slice(0, 15).map(x => x.l)), w15 = h15 - l15;
        const dir5 = c5 > o5 ? 1 : c5 < o5 ? -1 : 0;
        const plans = [];
        // rvb entry: 5-min range + 5-min direction, confirmation 9:36-10:30, chase-limit reject, one attempt
        if (dir5 && w5 > 0.0001 * o5) {
          for (let k = 5; k < B.length - 1; k++) {
            if (B[k].min > 629) break;
            const c = B[k].c, through = dir5 > 0 ? c > h5 : c < l5;
            if (!through) continue;
            const chaseLimit = dir5 > 0 ? h5 + 0.25 * w5 : l5 - 0.25 * w5, chased = dir5 > 0 ? c > chaseLimit : c < chaseLimit;
            plans.push({ track: 'rvb', dir: dir5, orH: h5, orL: l5, R: w5, k1: k + 1, chased, rvolOk });
            break;
          }
        }
        // ovl entry: the live ORB15 config (15-minute range, 15-minute candle confirmation, accept until 15:00)
        for (let idx = 29; idx < B.length; idx += 15) {
          if (!B[idx] || B[idx].min !== 570 + idx) { skip('gap in 15-minute candle'); break; }
          if (B[idx].min > 900) break;
          const c = B[idx].c, dir = c > h15 ? 1 : c < l15 ? -1 : 0;
          if (dir) { plans.push({ track: 'ovl', dir, orH: h15, orL: l15, R: w15, k1: idx + 1, rvolOk }); break; }
        }
        if (!plans.length) { skip('no breakout'); continue; }
        plans.forEach(p => { p.e = B[p.k1].o; p.tIn = B[p.k1].t; p.stop0 = p.dir > 0 ? p.orL : p.orH; p.sATM = SYM + ymd + (p.dir > 0 ? 'C' : 'P') + String(Math.round(p.e) * 1000).padStart(8, '0'); });
        plans.forEach(p => { if (p.track !== 'rvb') return; p.legs = {}; SPREAD_W.forEach(w => { const k = p.dir > 0 ? p.e + w : p.e - w; p.legs[w] = SYM + ymd + (p.dir > 0 ? 'C' : 'P') + String(Math.round(k) * 1000).padStart(8, '0'); }); });
        const need = new Set(); plans.forEach(p => { need.add(p.sATM); if (p.legs) Object.values(p.legs).forEach(s => need.add(s)); });
        const ob = await optBars([...need], Math.min(...plans.map(p => p.tIn)) - 60000, B[B.length - 1].t + 5 * 60000);

        plans.forEach(p => {
          if (!(p.R > 0.0001 * p.e) || p.dir * (p.e - p.stop0) <= 0) { skip('entry already through the stop'); return; }
          const arrA = ob[p.sATM]; if (!arrA) { skip('no option price'); return; }
          let pinA = null; for (const b of arrA) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pinA = b.o; break; } if (b.t > p.tIn + 3 * 60000) break; }
          if (pinA === null || !(pinA >= 0.05)) { skip('no usable entry price'); return; }
          const rvolTag = p.rvolOk === null ? 'unk' : p.rvolOk ? 'rvolOn' : 'rvolOff';

          if (p.track === 'ovl') {
            let stop = p.stop0, moved = false, xt = null, xr = null;
            for (let q = p.k1; q < B.length; q++) {
              const x = B[q];
              if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 60000; xr = p.dir * (stop - p.e) / p.R; break; }
              if (p.dir > 0 ? x.h >= p.e + 1.25 * p.R : x.l <= p.e - 1.25 * p.R) { xt = x.t + 60000; xr = 1.25; break; }
              if (!moved && p.dir * ((p.dir > 0 ? x.h : x.l) - p.e) >= 0.5 * p.R) { stop = p.e; moved = true; }
              if (x.min >= 930) { xt = x.t; xr = p.dir * (x.o - p.e) / p.R; break; }
            }
            if (xt === null) { const L = B[B.length - 1]; xt = L.t; xr = p.dir * (L.c - p.e) / p.R; }
            const pout = sellAt(arrA, xt); if (pout === null) { skip('no exit price'); return; }
            const pnl = (pout - pinA) * 100 - 2;
            acc('ovl|' + SYM + '|' + rvolTag + '|' + split, pnl, xr); acc('ovl|' + SYM + '|' + rvolTag + '|all', pnl, xr);
            return;
          }

          // track rvb
          if (p.chased) { skip('chase-limit reject'); return; }
          { // outright structure, same 5-min/chase-limit/10:30-cutoff rules, for comparison against the spread
            let stop = p.stop0, xt = null, xr = null;
            for (let q = p.k1; q < B.length; q++) {
              const x = B[q];
              if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 60000; xr = p.dir * (stop - p.e) / p.R; break; }
              if (p.dir > 0 ? x.h >= p.e + 1.25 * p.R : x.l <= p.e - 1.25 * p.R) { xt = x.t + 60000; xr = 1.25; break; }
              if (x.min >= 890) { xt = x.t; xr = p.dir * (x.o - p.e) / p.R; break; } // 70 min before the close
            }
            if (xt === null) { const L = B[B.length - 1]; xt = L.t; xr = p.dir * (L.c - p.e) / p.R; }
            const pout = sellAt(arrA, xt);
            if (pout !== null) { const pnl = (pout - pinA) * 100 - 2; acc('rvb|out|' + SYM + '|' + rvolTag + '|' + split, pnl, xr); acc('rvb|out|' + SYM + '|' + rvolTag + '|all', pnl, xr); }
          }
          SPREAD_W.forEach(w => { // debit-spread structure, each width
            const shortSym = p.legs[w], arrS = ob[shortSym]; if (!arrS) { skip('no short-leg price'); return; }
            let pinS = null; for (const b of arrS) { if (b.t >= p.tIn && b.t <= p.tIn + 3 * 60000) { pinS = b.o; break; } if (b.t > p.tIn + 3 * 60000) break; }
            if (pinS === null) { skip('no usable short-leg entry price'); return; }
            const D0 = pinA - pinS; if (!(D0 > 0 && D0 <= 1.80 && D0 <= w / 2.25)) { skip('debit spread outside entry thresholds'); return; }
            let stop = p.stop0, xt = null, reason = 'time', spreadVal = null;
            for (let q = p.k1; q < B.length; q++) {
              const x = B[q];
              if (p.dir > 0 ? x.l <= stop : x.h >= stop) { xt = x.t + 60000; reason = 'ustop'; break; }
              const vA = pxAt(arrA, x.t, 3), vS = pxAt(arrS, x.t, 3);
              if (vA !== null && vS !== null) {
                const v = Math.max(0, vA - vS);
                if ((v - D0) * 100 + 4 <= -140) { xt = x.t; reason = 'loss'; spreadVal = v; break; }
                if (v >= 2 * D0) { xt = x.t; reason = 'target'; spreadVal = v; break; }
              }
              if (x.min >= 890) { xt = x.t; reason = 'time'; break; }
            }
            if (xt === null) xt = B[B.length - 1].t;
            if (spreadVal === null) { const lo = sellAt(arrA, xt), so = sellAt(arrS, xt); if (lo === null || so === null) { skip('no exit price for spread'); return; } spreadVal = Math.max(0, lo - so); }
            const pnl = (spreadVal - D0) * 100 - 4;
            acc('rvb|sp' + w + '|' + SYM + '|' + rvolTag + '|' + split, pnl, null); acc('rvb|sp' + w + '|' + SYM + '|' + rvolTag + '|all', pnl, null); acc('rvb|sp' + w + '|why-' + reason, pnl, null);
          });
        });
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); }
      done++; if (done % 60 === 0) { out.progress = SYM + ' ' + done + ' of ' + dayList.length; await save(); }
    }
  }
  out.progress = 'done'; out.done = iso(Date.now()); fin();
  return out;
};
