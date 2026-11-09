/* Scalp City strategy engine. Pure functions, no network, no DOM.
   Entry (from the video): 1-minute candle closes across VWAP, across the 50 EMA, or breaks the first-15-minute range.
   Close above -> long; close below -> inverse ETF (stocks-only stand-in for a put).
   Exit (proposed, not from the video): ATR stop, level stop, half off at 1R then breakeven + 9-EMA trail,
   time stop, flat before the close. Daily shut-downs on target, loss, losing trades, trade count. */
var Engine = (function () {
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  function et(t) {
    var o = {};
    fmt.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    var h = +o.hour; if (h === 24) h = 0;
    return { day: o.year + '-' + o.month + '-' + o.day, min: h * 60 + (+o.minute) };
  }

  var DEFAULT = {
    capital: 5000, target: 100, lossLimit: 50, risk: 100 / 6,
    maxLosers: 3, maxTrades: 8, startMin: 585, lastEntry: 930, flatMin: 950,
    slip: 0.01, lev: 3, shorts: true, atrMult: 1, partialR: 1, timeStop: 15, cooldown: 5,
    vwap: true, ema: true, orb: true
  };
  function ladderCfg(T, capital, extra) {
    var c = { target: T, lossLimit: T / 2, risk: T / 6, capital: capital };
    for (var k in extra) c[k] = extra[k];
    return c;
  }

  /* raw API bars -> clean regular-session bars; days with too few real bars are dropped */
  function prepare(raw, opts) {
    var out = [], seen = {};
    raw.forEach(function (b) {
      if (b.interpolated) return;
      var t = Date.parse(b.begins_at);
      if (seen[t]) return; seen[t] = 1;
      var e = et(t);
      if (e.min < 570 || e.min >= 960) return;
      out.push({ t: t, o: +b.open_price, h: +b.high_price, l: +b.low_price, c: +b.close_price, v: +b.volume || 0, day: e.day, min: e.min });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    var cnt = {};
    out.forEach(function (b) { cnt[b.day] = (cnt[b.day] || 0) + 1; });
    if (opts && opts.partial) return out;
    return out.filter(function (b) { return cnt[b.day] >= 300; });
  }

  function indicators(bars) {
    var e50 = 0, e9 = 0, k50 = 2 / 51, k9 = 2 / 10, tr = [], pv = 0, vv = 0, day = '';
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (b.day !== day) { day = b.day; pv = 0; vv = 0; }
      e50 = i ? b.c * k50 + e50 * (1 - k50) : b.c;
      e9 = i ? b.c * k9 + e9 * (1 - k9) : b.c;
      b.e50 = e50; b.e9 = e9;
      var tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v;
      b.vwap = vv ? pv / vv : b.c;
      var pc = i ? bars[i - 1].c : b.o;
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
      var n = Math.min(14, tr.length), s = 0;
      for (var j = tr.length - n; j < tr.length; j++) s += tr[j];
      b.atr = s / n;
    }
  }

  function crossSignal(b, pr, orH, orL, c) {
    var hit = null;
    function cross(trig, lvl, plvl) {
      if (hit) return;
      if (pr.c <= plvl && b.c > lvl) hit = { dir: 1, trig: trig };
      else if (pr.c >= plvl && b.c < lvl) hit = { dir: -1, trig: trig };
    }
    if (c.vwap) cross('vwap', b.vwap, pr.vwap);
    if (c.ema) cross('ema', b.e50, pr.e50);
    if (c.orb) {
      if (pr.c <= orH && b.c > orH) hit = hit || { dir: 1, trig: 'orb' };
      else if (pr.c >= orL && b.c < orL) hit = hit || { dir: -1, trig: 'orb' };
    }
    return hit;
  }

  function runDay(bars, s, e, c) {
    var orH = -Infinity, orL = Infinity, k;
    for (k = s; k < e; k++) if (bars[k].min < 585) { orH = Math.max(orH, bars[k].h); orL = Math.min(orL, bars[k].l); }
    var dayPnl = 0, losers = 0, nt = 0, shut = '', pos = null, pending = null, blockUntil = -1, trades = [], skipped = 0, maxCash = 0, wins = 0;

    function level(p, b) { return p.trig === 'vwap' ? b.vwap : p.trig === 'ema' ? b.e50 : (p.dir > 0 ? orH : orL); }
    function realize(qty, price) {
      var x = price - pos.dir * c.slip;
      var pr = qty * pos.dir * (x - pos.e);
      pos.realized += pr; pos.q -= qty; dayPnl += pr;
    }
    function exitAll(price, reason, k) {
      if (pos.q > 0) realize(pos.q, price);
      var p = pos;
      trades.push({ day: bars[s].day, t0: bars[p.k0].t, t1: bars[k].t, dir: p.dir, trig: p.trig, e: p.e, q: p.q0, cash: p.cash, pnl: p.realized, reason: reason, R: p.d });
      if (p.realized > 0) wins++;
      if (p.realized < 0) losers++;
      pos = null;
      if (dayPnl >= c.target) shut = 'target';
      else if (dayPnl <= -c.lossLimit) shut = 'loss';
      else if (losers >= c.maxLosers) shut = 'losers';
      else if (nt >= c.maxTrades) shut = 'trades';
      if (reason === 'stop' || reason === 'level') blockUntil = k + c.cooldown;
    }
    function enter(b, k, sig) {
      var dir = sig.dir;
      if (dir < 0 && !c.shorts) return;
      var e0 = b.o + dir * c.slip;
      var d = Math.max(c.atrMult * sig.atr, 0.05);
      var expo = Math.min(c.risk / d * e0, dir > 0 ? c.capital : c.capital * c.lev);
      var q = dir > 0 ? Math.floor(expo / e0) : expo / e0;
      if (!(q >= 1)) { skipped++; return; }
      var cash = dir > 0 ? q * e0 : q * e0 / c.lev;
      if (cash > maxCash) maxCash = cash;
      pos = { dir: dir, e: e0, d: d, stop: e0 - dir * d, q: q, q0: q, k0: k, trig: sig.trig, partial: false, mfe: 0, realized: 0, cash: cash };
      nt++;
    }
    function manage(b, k) {
      var p = pos, dir = p.dir, adv = dir > 0 ? b.l : b.h, fav = dir > 0 ? b.h : b.l;
      if (dir * (adv - p.stop) <= 0) {
        var fill = dir > 0 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop);
        exitAll(fill, p.partial ? 'breakeven' : 'stop', k); return;
      }
      if (!p.partial && c.partialR > 0) {
        var tgt = p.e + dir * c.partialR * p.d;
        if (dir * (fav - tgt) >= 0) {
          var qh = dir > 0 ? Math.floor(p.q / 2) : p.q / 2;
          if (qh > 0) realize(qh, tgt);
          p.partial = true; p.stop = p.e;
          if (dayPnl >= c.target) { exitAll(b.c, 'target', k); return; }
        }
      }
      if (p.partial) {
        if (dir * (b.c - b.e9) < 0) { exitAll(b.c, 'trail', k); return; }
      } else if (dir * (b.c - level(p, b)) < 0) { exitAll(b.c, 'level', k); return; }
      p.mfe = Math.max(p.mfe, dir * (fav - p.e) / p.d);
      if (!p.partial && (k - p.k0) >= c.timeStop && p.mfe < 0.3) exitAll(b.c, 'time', k);
    }
    function signal(k) {
      var hit = crossSignal(bars[k], bars[k - 1], orH, orL, c);
      if (hit) hit.atr = bars[k].atr;
      return hit;
    }

    for (k = s; k < e; k++) {
      var b = bars[k];
      if (pos && b.min >= c.flatMin) exitAll(b.o, 'eod', k);
      if (!pos && pending && !shut && k > blockUntil && nt < c.maxTrades) enter(b, k, pending);
      pending = null;
      if (pos) manage(b, k);
      if (!pos && !shut && k > s && b.min >= c.startMin && b.min <= c.lastEntry && k > blockUntil) pending = signal(k);
    }
    if (pos) exitAll(bars[e - 1].c, 'eod', e - 1);
    return { day: { day: bars[s].day, pnl: dayPnl, n: trades.length, wins: wins, shut: shut || '', maxCash: maxCash }, trades: trades, skipped: skipped };
  }

  function summarize(days, trades, skipped) {
    var tot = 0, cum = 0, peak = 0, dd = 0, gw = 0, gl = 0, nw = 0, nl = 0, tgt = 0, lossd = 0, win = 0, maxCash = 0, by = {}, worst = 0, best = 0;
    days.forEach(function (d) {
      tot += d.pnl; cum += d.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
      if (d.pnl > 0) win++;
      if (d.shut === 'target') tgt++;
      if (d.shut === 'loss') lossd++;
      worst = Math.min(worst, d.pnl); best = Math.max(best, d.pnl);
      if (d.maxCash > maxCash) maxCash = d.maxCash;
    });
    trades.forEach(function (t) {
      if (t.pnl > 0) { nw++; gw += t.pnl; } else if (t.pnl < 0) { nl++; gl += -t.pnl; }
      var k = t.trig + (t.dir > 0 ? ' long' : ' inverse');
      by[k] = by[k] || { n: 0, pnl: 0 }; by[k].n++; by[k].pnl += t.pnl;
    });
    return {
      days: days.length, total: tot, avgDay: days.length ? tot / days.length : 0, winDays: win, targetDays: tgt, lossDays: lossd,
      worstDay: worst, bestDay: best, maxDD: dd, trades: trades.length, winRate: trades.length ? nw / trades.length : 0,
      avgWin: nw ? gw / nw : 0, avgLoss: nl ? gl / nl : 0, profitFactor: gl ? gw / gl : (gw ? Infinity : 0), skipped: skipped, maxCash: maxCash, by: by
    };
  }

  function simulate(rawOrPrepared, cfg, alreadyPrepared) {
    var bars = alreadyPrepared ? rawOrPrepared : prepare(rawOrPrepared);
    if (!bars.length) return { days: [], trades: [], skipped: 0, summary: summarize([], [], 0), bars: 0 };
    bars.forEach(function (b) { delete b.e50; });
    indicators(bars);
    var c = {}; for (var k in DEFAULT) c[k] = DEFAULT[k]; for (k in cfg) c[k] = cfg[k];
    var days = [], trades = [], skipped = 0, i = 0;
    while (i < bars.length) {
      var j = i; while (j < bars.length && bars[j].day === bars[i].day) j++;
      var r = runDay(bars, i, j, c);
      days.push(r.day); r.trades.forEach(function (t) { trades.push(t); }); skipped += r.skipped;
      i = j;
    }
    return { days: days, trades: trades, skipped: skipped, summary: summarize(days, trades, skipped), bars: bars.length, cfg: c };
  }

  /* Live use: evaluate the most recent completed bar. bars = prepare(raw, {partial:true}). */
  function latest(bars, cfg) {
    if (bars.length < 3) return null;
    indicators(bars);
    var c = {}; for (var k in DEFAULT) c[k] = DEFAULT[k]; for (k in cfg) c[k] = cfg[k];
    var i = bars.length - 1, b = bars[i], pr = bars[i - 1], s = i;
    while (s > 0 && bars[s - 1].day === b.day) s--;
    var orH = -Infinity, orL = Infinity;
    for (var j = s; j <= i; j++) if (bars[j].min < 585) { orH = Math.max(orH, bars[j].h); orL = Math.min(orL, bars[j].l); }
    var sig = null;
    if (pr.day === b.day && b.min >= c.startMin && b.min <= c.lastEntry) {
      sig = crossSignal(b, pr, orH, orL, c);
      if (sig) sig.atr = b.atr;
    }
    return { bar: b, i: i, dayStart: s, day: b.day, orH: orH, orL: orL, signal: sig, atr: b.atr, vwap: b.vwap, e50: b.e50, e9: b.e9, inWindow: b.min >= c.startMin && b.min <= c.lastEntry };
  }

  return { simulate: simulate, latest: latest, prepare: prepare, ladderCfg: ladderCfg, DEFAULT: DEFAULT, et: et };
})();
if (typeof module !== 'undefined') module.exports = Engine;
