'use strict';
/* Scalp City server: always-on PAPER trading. It never places, cancels or changes a real order:
   the only Robinhood tools it is allowed to call are read-only (see READ_ONLY below). */
const http = require('http');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const Engine = require('./engine.js');

const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const RH_URL = process.env.RH_MCP_URL || 'https://agent.robinhood.com/mcp/trading';
const TICK_MS = +process.env.TICK_MS || 20000;
const READ_ONLY = new Set(['get_accounts', 'get_equity_quotes', 'get_equity_historicals', 'get_option_chains',
  'get_option_instruments', 'get_option_quotes', 'get_option_positions', 'get_option_orders', 'get_portfolio']);

/* ---------- storage: Postgres key/value (tokens + journal survive restarts) ---------- */
let pool = null; const mem = new Map();
async function initStore() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL: using memory only (login and journal are lost on restart)'); return; }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }, max: 3 });
  try { await pool.query('create table if not exists scalp.kv (key text primary key, value jsonb not null, updated timestamptz not null default now())'); } catch (e) { /* table is created ahead of time by the owner */ }
  await pool.query('select 1 from scalp.kv limit 1');
}
async function kget(k) {
  if (!pool) return mem.has(k) ? JSON.parse(mem.get(k)) : null;
  const r = await pool.query('select value from scalp.kv where key=$1', [k]); return r.rows.length ? r.rows[0].value : null;
}
async function kset(k, v) {
  if (!pool) { mem.set(k, JSON.stringify(v)); return; }
  await pool.query('insert into scalp.kv(key,value,updated) values($1,$2,now()) on conflict(key) do update set value=excluded.value, updated=now()', [k, JSON.stringify(v)]);
}
async function kscan(prefix, limit) {
  if (!pool) return [...mem.keys()].filter(k => k.startsWith(prefix)).sort().reverse().slice(0, limit).map(k => ({ key: k, value: JSON.parse(mem.get(k)) }));
  const r = await pool.query('select key, value from scalp.kv where key like $1 order by key desc limit $2', [prefix + '%', limit]); return r.rows;
}
async function kdel(k) { if (!pool) mem.delete(k); else await pool.query('delete from scalp.kv where key=$1', [k]); }

/* ---------- Robinhood MCP connection with OAuth (one-time login, then refresh tokens) ---------- */
const S = { client: null, transport: null, connected: false, needsLogin: false, authUrl: '', err: '', lastOk: 0, connecting: false };
const provider = {
  get redirectUrl() { return PUBLIC_URL + '/oauth/callback'; },
  get clientMetadata() {
    return { client_name: 'Scalp City paper bot', redirect_uris: [PUBLIC_URL + '/oauth/callback'], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' };
  },
  async clientInformation() { return (await kget('oauth_client')) || undefined; },
  async saveClientInformation(i) { await kset('oauth_client', i); },
  async tokens() { return (await kget('oauth_tokens')) || undefined; },
  async saveTokens(t) {
    const old = (await kget('oauth_tokens')) || {};
    await kset('oauth_tokens', Object.assign({}, old, t, { saved_at: Date.now() }));
  },
  async redirectToAuthorization(url) { S.authUrl = url.toString(); S.needsLogin = true; console.log('AUTHURL', S.authUrl); },
  async saveCodeVerifier(v) { await kset('oauth_verifier', { v }); },
  async codeVerifier() { const r = await kget('oauth_verifier'); if (!r) throw new Error('no code verifier'); return r.v; },
  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') await kdel('oauth_tokens');
    if (scope === 'all' || scope === 'client') await kdel('oauth_client');
    if (scope === 'all' || scope === 'verifier') await kdel('oauth_verifier');
  },
};
async function connect() {
  if (USE_ALPACA) { S.connected = true; S.needsLogin = false; S.err = ''; S.lastOk = Date.now(); return; }
  if (S.connecting) return; S.connecting = true;
  try {
    try { if (S.client) await S.client.close(); } catch (e) { }
    S.transport = new StreamableHTTPClientTransport(new URL(RH_URL), { authProvider: provider });
    S.client = new Client({ name: 'scalp-city-server', version: '1.0.0' }, { capabilities: {} });
    await S.client.connect(S.transport);
    S.connected = true; S.needsLogin = false; S.err = ''; S.lastOk = Date.now(); S.authUrl = '';
    console.log('Connected to Robinhood MCP');
  } catch (e) {
    S.connected = false;
    if (e instanceof UnauthorizedError || /unauthor/i.test(String(e && e.message))) { S.needsLogin = true; S.err = 'Needs login'; console.log('Robinhood login needed'); }
    else { S.err = 'connect: ' + String(e && e.message || e).slice(0, 200); console.log(S.err); }
  } finally { S.connecting = false; }
}

/* ---------- market-data feed: Alpaca (free keys) in place of the Robinhood read tools ---------- */
const AK = process.env.ALPACA_KEY_ID, AS = process.env.ALPACA_SECRET, USE_ALPACA = !!(AK && AS);
async function ap(path, qs) {
  const u = new URL('https://data.alpaca.markets' + path); Object.keys(qs || {}).forEach(k => { if (qs[k] !== undefined && qs[k] !== '') u.searchParams.set(k, qs[k]); });
  const r = await fetch(u, { headers: { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS, accept: 'application/json' } });
  if (!r.ok) throw Object.assign(new Error('alpaca ' + r.status + ' ' + (await r.text()).slice(0, 160)), { code: 'tool_error' });
  return r.json();
}
function occ(sym) { const m = /^(.*?)(\d{6})([CP])(\d{8})$/.exec(sym); return m ? { root: m[1], exp: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6), type: m[3] === 'C' ? 'call' : 'put', strike: +m[4] / 1000 } : null; }
async function optSnaps(under, qs) {
  const out = {}; let tok = '';
  for (let i = 0; i < 8; i++) {
    const d = await ap('/v1beta1/options/snapshots/' + under, Object.assign({ feed: 'indicative', limit: 1000, page_token: tok }, qs));
    Object.assign(out, d.snapshots || {}); tok = d.next_page_token || ''; if (!tok) break;
  }
  return out;
}
function qOf(sym, z) { const q = z.latestQuote || {}, g = z.greeks || {}; return { instrument_id: sym, ask_price: q.ap, bid_price: q.bp, updated_at: q.t, implied_volatility: z.impliedVolatility, delta: g.delta }; }
async function alpacaTool(tool, a) {
  if (tool === 'get_equity_historicals') {
    const d = await ap('/v2/stocks/bars', { symbols: a.symbols[0], timeframe: '1Min', start: a.start_time, end: a.end_time, feed: 'iex', limit: 10000, adjustment: 'raw' });
    const bars = ((d.bars || {})[a.symbols[0]] || []).map(b => ({ begins_at: b.t, open_price: b.o, high_price: b.h, low_price: b.l, close_price: b.c, volume: b.v }));
    return { results: [{ bars }] };
  }
  if (tool === 'get_option_chains') {
    const t = Date.now(), snaps = await optSnaps(a.underlying_symbol, { expiration_date_gte: new Date(t).toISOString().slice(0, 10), expiration_date_lte: new Date(t + 9 * 864e5).toISOString().slice(0, 10), type: 'call' });
    const dates = {}; Object.keys(snaps).forEach(k => { const o = occ(k); if (o) dates[o.exp] = 1; });
    return { chains: [{ id: a.underlying_symbol, can_open_position: true, settle_on_open: false, expiration_dates: Object.keys(dates).sort() }] };
  }
  if (tool === 'get_option_instruments') {
    const snaps = await optSnaps(a.chain_id, { expiration_date: a.expiration_dates, type: a.type });
    return { instruments: Object.keys(snaps).map(k => { const o = occ(k); return o && { id: k, strike_price: o.strike, state: 'active', tradability: 'tradable' }; }).filter(Boolean), next: '' };
  }
  if (tool === 'get_option_quotes') {
    const ids = a.instrument_ids, o = occ(ids[0]); if (!o) return { results: [] };
    const d = await ap('/v1beta1/options/snapshots', { symbols: ids.join(','), feed: 'indicative' });
    return { results: ids.map(id => (d.snapshots || {})[id] ? { quote: qOf(id, d.snapshots[id]) } : {}) };
  }
  if (tool === 'get_accounts' || tool === 'get_equity_quotes') return {};
  throw new Error('unsupported: ' + tool);
}
async function rh(tool, args) {
  if (!READ_ONLY.has(tool)) throw new Error('blocked: ' + tool + ' is not allowed in paper mode');
  if (USE_ALPACA) { const r = await alpacaTool(tool, args || {}); S.lastOk = Date.now(); return r; }
  if (!S.connected) throw Object.assign(new Error('not connected'), { code: 'not_connected' });
  let res;
  try { res = await S.client.callTool({ name: tool, arguments: args || {} }); }
  catch (e) {
    if (e instanceof UnauthorizedError || /unauthor|401/i.test(String(e && e.message))) { S.connected = false; S.needsLogin = true; }
    throw e;
  }
  if (res.isError) { const t = (res.content || []).map(c => c.text || '').join(' ').slice(0, 300); throw Object.assign(new Error(t || 'tool error'), { code: 'tool_error' }); }
  const txt = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('unreadable reply from ' + tool); }
  S.lastOk = Date.now();
  return j.data !== undefined ? j.data : j;
}

/* ---------- strategy (same rules as the web page, paper only) ---------- */
const ACCOUNT = process.env.ACCOUNT_NUMBER || '463657817';
/* Triggers (2026-11-10 study: only the liquidity sweep leaned our way; EMA/VWAP/ORB were coin flips or worse).
   Default (James, 2026-11-10 11:00 CT): sweep + ema, IWM excluded everywhere (EXCLUDE_SYMS). TRIGGERS=all or a list like sweep,ema,vwap changes it. CHOP_MAX skips a signal when price crossed VWAP that many times in the last 30 bars (0 = off). */
const TRIGS = (process.env.TRIGGERS || 'sweep,ema').split(',').map(x => x.trim());
const TRIG_CFG = TRIGS.includes('all') ? {} : { vwap: TRIGS.includes('vwap'), ema: TRIGS.includes('ema'), orb: TRIGS.includes('orb') }; // sweep is always on
const EMA_FILTER = process.env.EMA_FILTER !== '0'; // skip EMA crosses that agree with both EMA slope and VWAP side (EMA_FILTER=0 turns off)
const SWEEP_RUN = process.env.SWEEP_RUN !== '0'; // sweep trades use the wick stop + 1R underlying trail instead of the dollar exits
const CHOP_MAX = +process.env.CHOP_MAX || 0; // off by default: the study found sweep signals in chop did no worse (n=36)
const CFG = { maxPrem: +process.env.MAX_PREM || 250, dte: process.env.DTE === '0' ? 0 : 1, target: +process.env.DAILY_TARGET || 100, loss: +process.env.DAILY_LOSS || 50,
  syms: (process.env.SYMBOLS || 'QQQ,SPY,IWM').split(',').filter(x => !(process.env.EXCLUDE_SYMS === undefined ? 'IWM' : process.env.EXCLUDE_SYMS).split(',').includes(x)), maxTrades: 6, maxLosers: 3, premStop: .35, tpUp: .40, trailArm: .20, trailGap: .15, timeBars: 15, maxSpread: .12, cooldownMs: 5 * 60000 };
/* Extended hours (paper): NVDA and AAPL may also be scanned and traded before the open and after the close.
   Windows are ET minutes since midnight (env EXT_PRE / EXT_POST as "start-end"); defaults 7:30-9:25 and 16:00-16:15.
   Entries stop a few minutes before each window ends and every extended-hours trade is flattened before it closes. */
const EXT_SYMS = (process.env.EXT_SYMBOLS === undefined ? 'NVDA,AAPL' : process.env.EXT_SYMBOLS).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const win2 = (v, d) => { const m = /^(\d+)-(\d+)$/.exec(v || ''); return m ? [+m[1], +m[2]] : d; };
const EXT_WIN = { pre: win2(process.env.EXT_PRE, [450, 565]), post: win2(process.env.EXT_POST, [960, 975]) };
const EXT_MAXPREM = +process.env.EXT_MAXPREM || 600; // NVDA/AAPL contracts cost more than the ETF cap; paper only
function extSession(ms) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ms)); if (['Sat', 'Sun'].includes(wd)) return null;
  const m = Engine.et(ms).min;
  for (const n of ['pre', 'post']) { const w = EXT_WIN[n]; if (m >= w[0] && m < w[1]) return { name: n, flat: w[1] - 2, cfg: { startMin: w[0] + (n === 'pre' ? 5 : 1), lastEntry: w[1] - 5, orb: false, maxGap: 240000 } }; }
  return null;
}
const symActive = (sym, ms) => CFG.syms.includes(sym) ? marketOpen(ms) : (EXT_SYMS.includes(sym) && !!extSession(ms));
/* Dollar exits (James, 2026-11-10): the main exits use dollars per 1-contract trade instead of % of the premium.
   Take profit +$25, hard stop -$20, trail arms at +$12 and exits if it gives back $8 from the peak. Entries are skipped when the
   bid/ask spread alone is wider than $10 (it would eat the $20 stop). DOLLAR_EXITS=0 goes back to the percent rules. */
const USD = process.env.DOLLAR_EXITS === '0' ? null : { stop: 20, tp: 25, trailArm: 12, trailGap: 5, trailFrac: 0.4, runGap: 12, maxSpread: 10 };
const QTY = USD ? (+process.env.QTY || 2) : 1; // paper: 2 contracts, sell 1 at +$25 and let the other ride (needs dollar exits)
CFG.usd = USD;
const PROFB = { premStop: .12, tpUp: .40, trailArm: .05, trailGap: .06, timeBars: 15 };
const iso = ms => new Date(ms).toISOString();
const nowET = () => Engine.et(Date.now());
function marketOpen(ms) {
  const e = Engine.et(ms); const d = new Date(ms); const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
  return !['Sat', 'Sun'].includes(wd) && e.min >= 570 && e.min < 960;
}
let WATCH = null; // tower list shared by every device (null = never set)
const P = { raw: {}, bars: {}, info: {}, chain: {}, inst: {}, seenSig: {}, rec: null, ctl: { running: false }, lastTick: 0, msg: 'Starting', busy: false, tickErr: '', saveErr: '' };

async function pBars(sym, ext) {
  const now = Date.now(); let st = P.raw[sym];
  async function win(a, b) {
    const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(b), interval: 'minute', bounds: ext ? 'extended' : 'regular' });
    return ((d.results || [])[0] || {}).bars || [];
  }
  if (!st) {
    st = P.raw[sym] = {};
    const a = await win(now - 3 * 864e5, now - 1.5 * 864e5), b = await win(now - 1.5 * 864e5, now);
    a.concat(b).forEach(x => { st[Date.parse(x.begins_at)] = x; });
  } else {
    const ts = Object.keys(st).map(Number), last = ts.length ? Math.max.apply(null, ts) : now - 3600000;
    (await win(Math.min(last - 5 * 60000, now - 40 * 60000), now)).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    const cut = now - 4 * 864e5; Object.keys(st).forEach(k => { if (+k < cut) delete st[k]; });
  }
  const list = Object.keys(st).map(k => st[k]).filter(x => Date.parse(x.begins_at) + 60000 <= Date.now());
  return Engine.prepare(list, { partial: true, ext: !!ext });
}
async function getChain(sym) {
  if (P.chain[sym] && Date.now() - P.chain[sym].at < 6 * 3600e3) return P.chain[sym];
  const d = await rh('get_option_chains', { underlying_symbol: sym });
  const ch = (d.chains || []).filter(c => c.can_open_position && !c.settle_on_open)[0];
  if (!ch) throw { code: 'no_chain' };
  return (P.chain[sym] = { id: ch.id, at: Date.now(), dates: (ch.expiration_dates || []).slice().sort() });
}
function pickExpiry(ch, dte) {
  const today = nowET().day, fut = ch.dates.filter(d => d >= today);
  if (!fut.length) return null; if (dte === 0) return fut[0]; return fut[0] === today ? fut[1] : fut[0];
}
async function getInst(chain, exp, type) {
  const key = chain.id + '|' + exp + '|' + type; if (P.inst[key]) return P.inst[key];
  const out = []; let cur = '';
  for (let i = 0; i < 6; i++) {
    const inp = { chain_id: chain.id, expiration_dates: exp, type }; if (cur) inp.cursor = cur;
    const d = await rh('get_option_instruments', inp);
    (d.instruments || []).forEach(x => { if (x.state === 'active' && x.tradability === 'tradable') out.push({ id: x.id, strike: +x.strike_price }); });
    cur = d.next || ''; if (!cur) break;
  }
  return (P.inst[key] = out);
}
async function pickContract(sym, dir, px, maxPrem) {
  maxPrem = maxPrem || CFG.maxPrem;
  const ch = await getChain(sym), exp = pickExpiry(ch, CFG.dte);
  if (!exp) return { why: 'no expiry available' };
  const type = dir > 0 ? 'call' : 'put', list = await getInst(ch, exp, type);
  const lo = dir > 0 ? px - 2 : px - 8, hi = dir > 0 ? px + 8 : px + 2;
  const c = list.filter(x => x.strike >= lo && x.strike <= hi).sort((a, b) => Math.abs(a.strike - px) - Math.abs(b.strike - px)).slice(0, 20);
  if (!c.length) return { why: 'no strikes near the price' };
  const qd = await rh('get_option_quotes', { instrument_ids: c.map(x => x.id) }), byId = {};
  (qd.results || []).forEach(r => { if (r.quote) byId[r.quote.instrument_id] = r.quote; });
  let cheapest = null, stale = false;
  for (const k of c) {
    const q = byId[k.id]; if (!q) continue;
    if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 120000) { stale = true; continue; }
    const ask = +q.ask_price, bid = +q.bid_price; if (!(ask > 0 && bid > 0)) continue;
    if (cheapest === null || ask < cheapest) cheapest = ask;
    if (ask * 100 > maxPrem) continue;
    if ((ask - bid) / ask > CFG.maxSpread) continue;
    if (CFG.usd && (ask - bid) * 100 > CFG.usd.maxSpread) continue;
    return { qAge: q.updated_at ? Date.now() - Date.parse(q.updated_at) : null, inst: k.id, strike: k.strike, exp, type, ask, bid, iv: +q.implied_volatility || null, delta: +q.delta || null };
  }
  return { why: cheapest === null ? (stale ? 'option quotes are stale' : 'no live quotes') : 'nothing near the money under $' + maxPrem + ' with a tight spread (cheapest ask $' + (cheapest * 100).toFixed(0) + ')' };
}

function newRec(day) { return { day, trades: [], signals: [], pnl: 0, losers: 0, shut: '', pos: null, blockUntil: 0, sh: { open: [], trades: [], pnl: 0 }, orbk: { open: [], trades: [], pnl: 0, done: {} } }; }
async function loadDay(day) { P.rec = (await kget('rec:' + day)) || newRec(day); P.rec.sh = P.rec.sh || { open: [], trades: [], pnl: 0 }; P.rec.orbk = P.rec.orbk || { open: [], trades: [], pnl: 0, done: {} }; }
let saveQ = Promise.resolve();
function saveRec() {
  if (!P.rec) return saveQ; const rec = JSON.parse(JSON.stringify(P.rec)); rec.updated = iso(Date.now());
  saveQ = saveQ.then(() => kset('rec:' + rec.day, rec)).then(() => { P.saveErr = ''; }).catch(e => { P.saveErr = 'journal not saving: ' + String(e.message || e).slice(0, 120); });
  return saveQ;
}
function logSignal(sym, sig, px, action, why) {
  P.rec.signals.push({ t: iso(Date.now()), sym, dir: sig.dir, trig: sig.trig, px, action, why: why || '' });
  if (P.rec.signals.length > 80) P.rec.signals.shift();
}
function shutCheck() {
  const r = P.rec;
  // PAPER ONLY: the daily trade cap, loser cap and loss limit are OFF while paper trading (James, 2026-11-09).
  // Set ENFORCE_LIMITS=1 to turn them back on. REVISIT BEFORE GOING LIVE.
  if (process.env.ENFORCE_LIMITS !== '1') return;
  if (process.env.STOP_AT_TARGET === '1' && r.pnl >= CFG.target) r.shut = 'target'; else if (r.pnl <= -CFG.loss) r.shut = 'loss';
  else if (r.losers >= CFG.maxLosers) r.shut = 'losers'; else if (r.trades.length >= CFG.maxTrades) r.shut = 'trades';
}
function closePaper(reason, bid, info) {
  const p = P.rec.pos, q = p.qty || 1, hf = p.half || null, pnl = (hf ? hf.pnl : 0) + (bid - p.entryAsk) * 100 * (hf ? q - 1 : q);
  P.rec.trades.push({ run: p.trailR ? true : undefined, trailR: p.trailR ? Math.round(p.trailR * 100) / 100 : undefined, entryQAge: p.qAge, exitQAge: p.live ? p.live.age : undefined, qty: q, half: hf || undefined, sym: p.sym, type: p.type, strike: p.strike, exp: p.exp, inst: p.inst, entryT: iso(p.t0), entryAsk: p.entryAsk, entryBid: p.entryBid, entryU: p.entryU, exitT: iso(Date.now()), exitBid: bid, exitU: info && info.bar ? info.bar.c : null, pnl: Math.round(pnl * 100) / 100, peakBid: p.peak, reason, trig: p.trig, ext: p.ext, iv: p.iv, delta: p.delta });
  P.rec.pnl = Math.round((P.rec.pnl + pnl) * 100) / 100; if (pnl < 0) P.rec.losers++;
  if (reason === 'stop' || reason === 'level' || reason === 'premium stop') P.rec.blockUntil = Date.now() + CFG.cooldownMs;
  P.rec.pos = null; shutCheck(); saveRec();
}
function exitReason(p, prof, bid, info, bars) {
  const m = nowET().min, dir = p.dir; let reason = '';
  if (m >= p.flatMin) reason = 'eod';
  /* SWEEP RUN exit (James approved 2026-11-10 after the year study: quick targets lost, a 1R chandelier trail was the best sweep exit, PF about 1.04): wick stop on the underlying, then the stop trails one stop-distance (R) behind the best price since entry. No +$25 target, no dollar trail, no -$20 premium stop, no level exit, no time stop; only a catastrophic -50% premium stop and the flat-before-close rule. Shadows keep profile B. SWEEP_RUN=0 reverts. */
  if (p.trailR) {
    if (!reason && bars) {
      let stop = p.stopU, best = p.entryU, moved = false;
      for (let i = 0; i < bars.length; i++) {
        const x = bars[i]; if (x.t <= p.sigT) continue;
        if (dir > 0 ? x.l <= stop : x.h >= stop) { reason = moved ? 'trail' : 'stop'; break; }
        best = dir > 0 ? Math.max(best, x.h) : Math.min(best, x.l);
        const ns = best - dir * p.trailR; if (dir * (ns - stop) > 0) { stop = ns; moved = true; }
      }
      p.stopNow = Math.round(stop * 100) / 100;
    }
    if (!reason && bid <= p.entryAsk * 0.5) reason = 'premium stop';
    return reason;
  }
  if (!reason && bars) {
    let adv = null;
    for (let i = bars.length - 1; i >= 0 && bars[i].t > p.sigT; i--) { const x = dir > 0 ? bars[i].l : bars[i].h; adv = adv === null ? x : (dir > 0 ? Math.min(adv, x) : Math.max(adv, x)); }
    if (adv !== null && dir * (adv - p.stopU) <= 0) reason = 'stop';
    const last = info && info.bar;
    if (!reason && p.trig === 'orb5' && p.tgtU !== undefined) { let fav = null; for (let i = bars.length - 1; i >= 0 && bars[i].t > p.sigT; i--) { const x = dir > 0 ? bars[i].h : bars[i].l; fav = fav === null ? x : (dir > 0 ? Math.max(fav, x) : Math.min(fav, x)); } if (fav !== null && dir * (fav - p.tgtU) >= 0) reason = 'orb target'; }
    if (!reason && p.trig !== 'orb5' && last && last.t > p.sigT) { const lvl = p.lvl !== undefined ? p.lvl : p.trig === 'vwap' ? last.vwap : p.trig === 'ema' ? last.e50 : (dir > 0 ? info.orH : info.orL); if (dir * (last.c - lvl) < 0) reason = 'level'; }
  }
  if (p.trig === 'orb5') { if (!reason && bid <= p.entryAsk * 0.5) reason = 'premium stop'; return reason; } // ORB5 is managed on the underlying only (stop = opposite side of the range, target = 2R), plus a catastrophic -50% premium stop and the flat-before-close rule
  if (prof.usd) {
    const d = x => Math.round(x * 100 * 100) / 100, pk = p.peak || bid, gain = d(bid - p.entryAsk), peakGain = d(pk - p.entryAsk), back = d(pk - bid);
    if (!reason && gain <= -prof.usd.stop) reason = 'premium stop';
    if (!reason && !p.half && gain >= prof.usd.tp) reason = 'target';
    if (!reason && peakGain >= prof.usd.trailArm && back >= Math.max(p.half ? prof.usd.runGap : prof.usd.trailGap, prof.usd.trailFrac * peakGain)) reason = 'trail'; // gives back 40% of the peak gain (min $5, runner min $12)
  } else {
    if (!reason && bid <= p.entryAsk * (1 - prof.premStop)) reason = 'premium stop';
    if (!reason && bid >= p.entryAsk * (1 + prof.tpUp)) reason = 'target';
    if (!reason && p.peak >= p.entryAsk * (1 + prof.trailArm) && bid <= p.peak * (1 - prof.trailGap)) reason = 'trail';
  }
  if (!reason && Date.now() - p.t0 >= prof.timeBars * 60000 && bid < p.entryAsk * 1.05) reason = 'time';
  return reason;
}
async function managePos() {
  const p = P.rec.pos, info = P.info[p.sym], bars = P.bars[p.sym];
  const qd = await rh('get_option_quotes', { instrument_ids: [p.inst] }), q = ((qd.results || [])[0] || {}).quote; if (!q) return;
  const bid = +q.bid_price; if (!(bid >= 0)) return;
  if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 180000) return;
  p.live = { bid, ask: +q.ask_price, t: Date.now(), age: q.updated_at ? Date.now() - Date.parse(q.updated_at) : null }; p.peak = Math.max(p.peak || 0, bid);
  const reason = exitReason(p, CFG, bid, info, bars);
  if (reason === 'target' && (p.qty || 1) > 1 && !p.half) { p.half = { t: iso(Date.now()), bid, pnl: Math.round((bid - p.entryAsk) * 10000) / 100, qty: 1 }; return; } // sold 1 of 2 at the target, the other rides
  if (reason) closePaper(reason, bid, info);
}
/* fast loop: while a paper position is open, re-price it every 2 s (stops and the screen both see fresh prices) */
const FAST_MS = +process.env.FAST_MS || 2000;
async function fastPos() {
  if (P.busy || !P.ctl.running || !S.connected || !P.rec || !P.rec.pos || !symActive(P.rec.pos.sym, Date.now())) return;
  P.busy = true;
  try { if (P.rec && P.rec.pos) { await managePos(); if (P.rec.pos) saveRecSoon(); } } catch (e) { /* the 20 s tick will retry */ } finally { P.busy = false; }
}
let _sv = 0; function saveRecSoon() { if (Date.now() - _sv > 10000) { _sv = Date.now(); saveRec(); } }
function openShadow(p) { P.rec.sh.open.push({ sym: p.sym, dir: p.dir, type: p.type, strike: p.strike, exp: p.exp, inst: p.inst, t0: p.t0, sigT: p.sigT, entryAsk: p.entryAsk, entryBid: p.entryBid, entryU: p.entryU, stopU: p.stopU, trig: p.trig, lvl: p.lvl, peak: p.entryBid, flatMin: p.flatMin }); }
async function manageShadows() {
  const sh = P.rec.sh; if (!sh.open.length) return;
  try {
    const qd = await rh('get_option_quotes', { instrument_ids: sh.open.map(x => x.inst) }), by = {};
    (qd.results || []).forEach(z => { if (z.quote) by[z.quote.instrument_id] = z.quote; });
    for (const s of sh.open.slice()) {
      const q = by[s.inst]; if (!q) continue; const bid = +q.bid_price; if (!(bid >= 0)) continue;
      if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 180000) continue;
      s.peak = Math.max(s.peak || 0, bid);
      const reason = exitReason(s, PROFB, bid, P.info[s.sym], P.bars[s.sym]);
      if (reason) {
        const pnl = Math.round((bid - s.entryAsk) * 10000) / 100;
        sh.trades.push({ sym: s.sym, type: s.type, strike: s.strike, exp: s.exp, entryT: iso(s.t0), entryAsk: s.entryAsk, exitT: iso(Date.now()), exitBid: bid, pnl, peakBid: s.peak, reason, trig: s.trig, prof: 'B' });
        sh.pnl = Math.round((sh.pnl + pnl) * 100) / 100; sh.open = sh.open.filter(x => x !== s);
      }
    }
    saveRec();
  } catch (e) { /* never disturb the main paper trade */ }
}
/* ---------- ORB5 paper book (James approved 2026-11-10 after a year of data: profit factor about 1.08 with a 2R target, positive in both halves of the year, QQQ better than SPY; edge is small). Runs as its OWN 1-contract paper book next to the main sweep/EMA position, so neither blocks the other. Entry: first close beyond the 9:30-9:34 ET range after 9:35. Stop: opposite side of the range. Target: 2R on the underlying. Flat before the close. One trade per symbol per day. ORB_ON=0 turns it off. ---------- */
const ORB_ON = process.env.ORB_ON !== '0', ORB_R = +process.env.ORB_R || 2;
async function orbLook() {
  const r = P.rec; if (!ORB_ON || !r || r.shut || !marketOpen(Date.now())) return;
  r.orbk = r.orbk || { open: [], trades: [], pnl: 0, done: {} };
  for (const s of CFG.syms) {
    const inf = P.info[s], sig = inf && inf.orb5; if (!sig || r.orbk.done[s]) continue;
    r.orbk.done[s] = true; // one per symbol per day, taken or skipped
    if (Date.now() - (inf.bar.t + 60000) > 150000) { logSignal(s, sig, inf.bar.c, 'skipped', 'orb5 signal was more than 2 minutes old when seen'); continue; }
    let pk; try { pk = await pickContract(s, sig.dir, inf.bar.c, 0); } catch (e) { pk = { why: 'could not load option data (' + ((e && e.code) || 'error') + ')' }; }
    if (pk.why) { logSignal(s, sig, inf.bar.c, 'skipped', 'orb5: ' + pk.why); continue; }
    const risk = Math.abs(inf.bar.c - sig.stopPx);
    r.orbk.open.push({ sym: s, dir: sig.dir, type: pk.type, strike: pk.strike, exp: pk.exp, inst: pk.inst, t0: Date.now(), sigT: inf.bar.t, entryAsk: pk.ask, entryBid: pk.bid, entryU: inf.bar.c, qAge: pk.qAge, stopU: sig.stopPx, tgtU: inf.bar.c + sig.dir * ORB_R * risk, riskU: Math.round(risk * 100) / 100, trig: 'orb5', peak: pk.bid, iv: pk.iv, delta: pk.delta, flatMin: CFG.dte === 0 ? 935 : 950 });
    logSignal(s, sig, inf.bar.c, 'entered', 'orb5 ' + pk.type + ' ' + pk.strike + ' exp ' + pk.exp + ' @ ask $' + pk.ask.toFixed(2) + ', stop ' + sig.stopPx.toFixed(2) + ', target ' + (inf.bar.c + sig.dir * ORB_R * risk).toFixed(2));
  }
  saveRec();
}
async function manageOrb() {
  const ob = P.rec && P.rec.orbk; if (!ob || !ob.open.length) return;
  try {
    const qd = await rh('get_option_quotes', { instrument_ids: ob.open.map(x => x.inst) }), by = {};
    (qd.results || []).forEach(z => { if (z.quote) by[z.quote.instrument_id] = z.quote; });
    for (const p of ob.open.slice()) {
      const q = by[p.inst]; if (!q) continue; const bid = +q.bid_price; if (!(bid >= 0)) continue;
      if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 180000) continue;
      p.peak = Math.max(p.peak || 0, bid); p.live = { bid, ask: +q.ask_price, t: Date.now(), age: q.updated_at ? Date.now() - Date.parse(q.updated_at) : null };
      const reason = exitReason(p, {}, bid, P.info[p.sym], P.bars[p.sym]);
      if (reason) {
        const pnl = Math.round((bid - p.entryAsk) * 10000) / 100;
        ob.trades.push({ sym: p.sym, type: p.type, strike: p.strike, exp: p.exp, entryT: iso(p.t0), entryAsk: p.entryAsk, exitT: iso(Date.now()), exitBid: bid, pnl, peakBid: p.peak, reason, trig: 'orb5', qty: 1, entryU: p.entryU, stopU: p.stopU, tgtU: p.tgtU, riskU: p.riskU, entryQAge: p.qAge, exitQAge: p.live.age });
        ob.pnl = Math.round((ob.pnl + pnl) * 100) / 100; ob.open = ob.open.filter(x => x !== p);
      }
    }
    saveRec();
  } catch (e) { /* never disturb the main paper trade */ }
}
/* ---------- Call credit spread paper book (CSK). James approved 2026-11-11 after studies bt6/bt7 on real option prices: selling same-day call spreads from 11:00 ET on SPY and QQQ and HOLDING TO THE CLOSE was positive in both the tuning and the locked period on both symbols ($2 wide about +$4 to +$5 per spread per day at $0.01 per leg slippage, about 87-90% winners, worst day about -$200); closing at 15:30 lost and an underlying stop gave up most of the profit. The open question is the real bid/ask cost, so this book records live quotes. One spread per symbol per day: at 11:00 ET sell the call nearest 0.45% above the price and buy the call $2 higher (same-day expiry). Paper fill at the NATURAL price (sell at the bid, buy at the ask); the mid is recorded too. Held to the close and settled on the last price (capped at the width). It also records, without acting on them, the cost to close at 15:30 ET and when the price first closes above the short strike. Assignment and early-close risks at a real broker are NOT modeled. CSK_ON=0 turns it off. ---------- */
const CSK_ON = process.env.CSK_ON !== '0', CSK = { syms: (process.env.CSK_SYMS || 'SPY,QQQ').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), pct: +process.env.CSK_PCT || 0.0045, width: +process.env.CSK_WIDTH || 2, min: +process.env.CSK_MIN || 660, stop: process.env.CSK_STOP === '0' ? 0 : (+process.env.CSK_STOP || 3) };
async function cskQuotes(ids) { const qd = await rh('get_option_quotes', { instrument_ids: ids }), by = {}; (qd.results || []).forEach(z => { if (z.quote) by[z.quote.instrument_id] = z.quote; }); return by; }
async function cskLook() {
  const r = P.rec; if (!CSK_ON || !r || r.shut || !marketOpen(Date.now())) return;
  r.csk = r.csk || { open: [], trades: [], pnl: 0, done: {} };
  const e = nowET(); if (e.min < CSK.min || e.min >= CSK.min + 20) return;
  for (const s of CSK.syms) {
    if (r.csk.done[s]) continue; const inf = P.info[s]; if (!inf || !inf.bar) continue;
    r.csk.done[s] = true; const px = inf.bar.c, fake = { dir: -1, trig: 'cspread' };
    try {
      const ch = await getChain(s), today = e.day; if (!ch.dates.includes(today)) { logSignal(s, fake, px, 'skipped', 'call spread: no same-day expiry'); continue; }
      const list = (await getInst(ch, today, 'call')).slice().sort((a, b) => a.strike - b.strike), want = px * (1 + CSK.pct);
      const sh = list.filter(x => x.strike >= px + 0.5).sort((a, b) => Math.abs(a.strike - want) - Math.abs(b.strike - want))[0], lg = sh && list.find(x => Math.abs(x.strike - (sh.strike + CSK.width)) < 0.01);
      if (!sh || !lg) { logSignal(s, fake, px, 'skipped', 'call spread: strikes not listed'); continue; }
      const q = await cskQuotes([sh.id, lg.id]), a = q[sh.id], b = q[lg.id];
      if (!a || !b) { logSignal(s, fake, px, 'skipped', 'call spread: no quotes'); continue; }
      const age = Math.max(Date.now() - Date.parse(a.updated_at || 0), Date.now() - Date.parse(b.updated_at || 0));
      if (age > 180000) { logSignal(s, fake, px, 'skipped', 'call spread: quotes are stale'); continue; }
      const sB = +a.bid_price, sA = +a.ask_price, lB = +b.bid_price, lA = +b.ask_price, nat = Math.round((sB - lA) * 100) / 100, mid = Math.round(((sB + sA) / 2 - (lB + lA) / 2) * 1000) / 1000;
      if (!(nat >= 0.03)) { logSignal(s, fake, px, 'skipped', 'call spread: credit under 3 cents at the bid/ask (' + nat.toFixed(2) + ', mid ' + mid.toFixed(2) + ')'); continue; }
      r.csk.open.push({ sym: s, exp: today, ks: sh.strike, kl: lg.strike, instS: sh.id, instL: lg.id, t0: Date.now(), entryU: px, sBid: sB, sAsk: sA, lBid: lB, lAsk: lA, creditNat: nat, creditMid: mid, qAge: age, width: lg.strike - sh.strike });
      logSignal(s, fake, px, 'entered', 'sold call spread ' + sh.strike + '/' + lg.strike + ' exp ' + today + ' for $' + nat.toFixed(2) + ' at the bid/ask (mid $' + mid.toFixed(2) + ')');
    } catch (err) { logSignal(s, fake, px, 'skipped', 'call spread: could not load option data (' + ((err && err.code) || (err && err.message) || 'error') + ')'); }
  }
  saveRec();
}
function cskClose(p, costNat, costMid, u, reason) {
  const k = P.rec.csk, pnl = Math.round((p.creditNat - costNat) * 10000) / 100, pnlMid = Math.round((p.creditMid - costMid) * 10000) / 100;
  k.trades.push({ sym: p.sym, type: 'call spread', strike: p.ks, kl: p.kl, exp: p.exp, entryT: iso(p.t0), exitT: iso(Date.now()), entryU: p.entryU, closeU: u, creditNat: p.creditNat, creditMid: p.creditMid, sBid: p.sBid, sAsk: p.sAsk, lBid: p.lBid, lAsk: p.lAsk, closeNat: costNat, closeMid: costMid, pnl, pnlMid, reason, trig: 'cspread', qty: 1, at330: p.at330 || null, ustop: p.ustop || null, pnl330: p.at330 ? Math.round((p.creditNat - p.at330.closeNat) * 10000) / 100 : null, pnlUstop: p.ustop ? Math.round((p.creditNat - p.ustop.closeNat) * 10000) / 100 : null });
  k.pnl = Math.round((k.pnl + pnl) * 100) / 100; k.open = k.open.filter(x => x !== p);
}
async function cskManage() {
  const k = P.rec && P.rec.csk; if (!k || !k.open.length) return;
  const e = nowET();
  try {
    if (e.min < 960 && marketOpen(Date.now())) {
      const q = await cskQuotes(k.open.flatMap(p => [p.instS, p.instL]));
      for (const p of k.open) {
        const a = q[p.instS], b = q[p.instL], u = P.info[p.sym] && P.info[p.sym].bar ? P.info[p.sym].bar.c : null; if (u !== null) p.lastU = u;
        if (a && b) { const nat = Math.round((+a.ask_price - +b.bid_price) * 100) / 100, mid = Math.round(((+a.bid_price + +a.ask_price) / 2 - (+b.bid_price + +b.ask_price) / 2) * 1000) / 1000, fresh = Math.max(Date.now() - Date.parse(a.updated_at || 0), Date.now() - Date.parse(b.updated_at || 0)) <= 180000; p.live = { closeNat: nat, closeMid: mid, t: Date.now(), u };
          if (e.min >= 930 && !p.at330) p.at330 = { closeNat: nat, closeMid: mid, u, t: iso(Date.now()) };
          if (u !== null && u > p.ks && !p.ustop) p.ustop = { closeNat: nat, closeMid: mid, u, t: iso(Date.now()) };
          /* 3x STOP (James approved 2026-11-11 after study bt9: a 3x stop kept most of the hold-to-close average and cut the worst day from about -$200 to -$120/-$150; 2x and take-profit rules cost more than they saved). Fires only on two consecutive fresh reads with the MID (not the natural) at or above 3x the mid credit, so one wide quote cannot trigger it; the buy-back is filled at the natural price. CSK_STOP=0 turns it off; CSK_STOP=2.5 changes the multiple. */
          if (CSK.stop && fresh && mid >= CSK.stop * Math.max(p.creditMid, 0.01)) { p.stopHits = (p.stopHits || 0) + 1; } else p.stopHits = 0;
          if (CSK.stop && p.stopHits >= 2) { cskClose(p, nat, mid, u, 'stop ' + CSK.stop + 'x credit'); continue; } }
      }
    } else if (e.min >= 961) {
      try { await ensureBars(CSK.syms); } catch (err) {}
      for (const p of k.open.slice()) {
        const bars = P.bars[p.sym], last = bars && bars.length ? bars[bars.length - 1].c : p.lastU; if (last === null || last === undefined) continue;
        const settle = Math.min(p.width, Math.max(0, last - p.ks));
        cskClose(p, settle, settle, last, settle > 0 ? 'expired in the money' : 'expired worthless');
      }
    }
    saveRec();
  } catch (err) { P.cskErr = String(err && err.message || err).slice(0, 120); }
}
/* ---------- X9 paper book: EMA9 x VWAP crossover (reel shared by James 2026-11-11, "@austin.daytrades" via "@algo.jan"; the reviewer's backtest claimed 174 trades, 55.8% winners, profit factor 2.17, +200% in about 8 months; the original trader claimed +$215k in October 2026). Rules as shown: EMA9 crosses above VWAP -> buy a call; EMA9 crosses below VWAP -> buy a put; exit when a 1-minute candle closes back through EMA9 against the trade, or at -30% on the premium; no take-profit shown. Added: an opposite cross also exits, flat before the close, same-day at-the-money contract, 1 contract, one position per symbol in this book, entries 9:45 to 15:30 ET. Runs as its own book (journal field x9k) so it never blocks the other books. X9_ON=0 disables. ---------- */
const X9_ON = process.env.X9_ON !== '0', X9 = { syms: (process.env.X9_SYMS || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), stopPct: +process.env.X9_STOP || 30 };
async function x9Look() {
  const r = P.rec; if (!X9_ON || !r || r.shut || !marketOpen(Date.now())) return;
  r.x9k = r.x9k || { open: [], trades: [], pnl: 0 };
  const e = nowET(); if (e.min < 585 || e.min > 930) return;
  for (const s of (X9.syms.length ? X9.syms : CFG.syms)) {
    const bars = P.bars[s]; if (!bars || bars.length < 20) continue;
    const q = bars.length - 1, b = bars[q]; if (b.day !== e.day || r.x9k.open.some(p => p.sym === s)) continue;
    const sig = Engine.x9At(bars, q); if (!sig) continue;
    const id = s + ':' + b.t; if (r.x9k.last === id) continue; r.x9k.last = id;
    if (Date.now() - (b.t + 60000) > 150000) { logSignal(s, sig, b.c, 'skipped', 'x9 signal was more than 2 minutes old when seen'); continue; }
    let pk; try { pk = await pickContract(s, sig.dir, b.c, 0); } catch (err) { pk = { why: 'could not load option data (' + ((err && err.code) || 'error') + ')' }; }
    if (pk.why) { logSignal(s, sig, b.c, 'skipped', 'x9: ' + pk.why); continue; }
    r.x9k.open.push({ sym: s, dir: sig.dir, type: pk.type, strike: pk.strike, exp: pk.exp, inst: pk.inst, t0: Date.now(), sigT: b.t, entryAsk: pk.ask, entryBid: pk.bid, entryU: b.c, qAge: pk.qAge, e9: Math.round(b.e9 * 100) / 100, trig: 'x9', peak: pk.bid, iv: pk.iv, delta: pk.delta, flatMin: CFG.dte === 0 ? 935 : 950 });
    logSignal(s, sig, b.c, 'entered', 'x9 ' + pk.type + ' ' + pk.strike + ' exp ' + pk.exp + ' @ ask $' + pk.ask.toFixed(2) + ' (EMA9 ' + b.e9.toFixed(2) + ' crossed ' + (sig.dir > 0 ? 'above' : 'below') + ' VWAP(OHLC/4) ' + b.vwap4.toFixed(2) + ')');
  }
  saveRec();
}
async function x9Manage() {
  const k = P.rec && P.rec.x9k; if (!k || !k.open.length) return;
  try {
    const qd = await rh('get_option_quotes', { instrument_ids: k.open.map(x => x.inst) }), by = {};
    (qd.results || []).forEach(z => { if (z.quote) by[z.quote.instrument_id] = z.quote; });
    const e = nowET();
    for (const p of k.open.slice()) {
      const q = by[p.inst]; if (!q) continue; const bid = +q.bid_price; if (!(bid >= 0)) continue;
      if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 180000) continue;
      p.peak = Math.max(p.peak || 0, bid); p.live = { bid, ask: +q.ask_price, t: Date.now(), age: q.updated_at ? Date.now() - Date.parse(q.updated_at) : null };
      const bars = P.bars[p.sym], last = bars && bars.length ? bars[bars.length - 1] : null; let reason = '';
      if (last && last.t > p.sigT) { if (Engine.x9Exit(last, p.dir)) reason = 'level'; else { const x = Engine.x9At(bars, bars.length - 1); if (x && x.dir === -p.dir) reason = 'reverse'; } }
      if (!reason && bid <= p.entryAsk * (1 - X9.stopPct / 100)) reason = 'premium stop';
      if (!reason && e.min >= p.flatMin) reason = 'eod';
      if (!reason && !marketOpen(Date.now())) reason = 'eod';
      if (reason) {
        const pnl = Math.round((bid - p.entryAsk) * 10000) / 100;
        k.trades.push({ sym: p.sym, type: p.type, strike: p.strike, exp: p.exp, entryT: iso(p.t0), entryAsk: p.entryAsk, exitT: iso(Date.now()), exitBid: bid, pnl, peakBid: p.peak, reason, trig: 'x9', qty: 1, entryU: p.entryU, exitU: last ? last.c : null, entryQAge: p.qAge, exitQAge: p.live.age });
        k.pnl = Math.round((k.pnl + pnl) * 100) / 100; k.open = k.open.filter(x => x !== p);
      }
    }
    saveRec();
  } catch (err) { P.x9Err = String(err && err.message || err).slice(0, 120); }
}
/* ---------- FP paper book: "fair pricing theory" (JJ Simon interview, youtu.be/KHEQ5g55dQ4, shared by James 2026-11-12). He trades NQ futures on 1-minute candles, first 90 minutes of the session; fair price = the 9:30 ET open price.
   Trade 1, continuation (once a day): in the direction of the first 1-minute candle, if it agrees with the higher-timeframe bias (the opposite of the overnight move: prior close -> today's open).
     His NQ numbers: stop 25 points, target 38 (about 0.10% and 0.15% of price); if the first candle is bigger than 25 points, both double (50/76).
   Trades 2+, reversion to the open (9:31-11:00 ET): a 1-minute DISPLACEMENT candle toward the open = body bigger than the previous candle's body AND closes beyond the previous candle's wick.
     Stop 0.10% of price, target the open price; taken only when the open is at least 1.5x the stop away (his 1:1.5 minimum). Stop for the day after 3 losses in a row.
   Here: same-day at-the-money call/put on SPY and QQQ, 1 contract, exits on the UNDERLYING stop/target, a -50% premium safety stop, out by 11:30 ET (his window ends 11:00), one position per symbol.
   Not used from the video: 8:30 ET news trades (before options open), the Asia and afternoon sessions, prop-firm sizing. Own book (journal field fpk). FP_ON=0 disables. ---------- */
const FP_ON = process.env.FP_ON !== '0', FP = { syms: (process.env.FP_SYMS || 'SPY,QQQ').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), stopPct: +process.env.FP_STOP || 0.10, tgtPct: +process.env.FP_TGT || 0.15, bias: process.env.FP_BIAS !== '0' };
async function fpLook() {
  const r = P.rec; if (!FP_ON || !r || r.shut || !marketOpen(Date.now())) return;
  r.fpk = r.fpk || { open: [], trades: [], pnl: 0, st: {} };
  const e = nowET(); if (e.min < 571 || e.min > 660) return;
  for (const s of FP.syms) {
    const bars = P.bars[s]; if (!bars || !bars.length) continue;
    const today = bars.filter(b => b.day === e.day), first = today.find(b => b.min === 570); if (!first || today.length < 2) continue;
    const st = r.fpk.st[s] = r.fpk.st[s] || { fair: first.o, cont: false, losses: 0, last: null };
    st.fair = first.o;
    if (r.fpk.open.some(p => p.sym === s)) continue;
    const prev = bars.filter(b => b.day < e.day), prevClose = prev.length ? prev[prev.length - 1].c : null;
    const q = bars.length - 1, b = bars[q], p = bars[q - 1]; if (b.day !== e.day || st.last === b.t) continue;
    if (Date.now() - (b.t + 60000) > 150000) continue;
    let plan = null;
    if (!st.cont) {
      st.cont = true; // decided once, on the first chance
      const dir = first.c > first.o ? 1 : first.c < first.o ? -1 : 0, bias = prevClose ? (first.o > prevClose ? -1 : first.o < prevClose ? 1 : 0) : 0;
      const big = (first.h - first.l) > first.o * FP.stopPct / 100, mult = big ? 2 : 1;
      if (!dir) logSignal(s, { dir: 1, trig: 'fp' }, first.c, 'skipped', 'fp continuation: first candle had no color');
      else if (FP.bias && bias && bias !== dir) logSignal(s, { dir, trig: 'fp' }, first.c, 'skipped', 'fp continuation: first candle disagrees with the overnight-reversion bias');
      else if (b.min <= 572) plan = { kind: 'cont', dir, stopU: b.c - dir * b.c * FP.stopPct * mult / 100, tgtU: b.c + dir * b.c * FP.tgtPct * mult / 100 };
    }
    if (!plan && st.cont && st.losses < 3 && p && p.day === e.day && b.min >= 571 && b.min < 660) {
      const bodyB = Math.abs(b.c - b.o), bodyP = Math.abs(p.c - p.o), stopD = b.c * FP.stopPct / 100;
      if (b.c > st.fair && b.c < b.o && bodyB > bodyP && b.c < p.l && b.c - st.fair >= 1.5 * stopD) plan = { kind: 'rev', dir: -1, stopU: b.c + stopD, tgtU: st.fair };
      if (b.c < st.fair && b.c > b.o && bodyB > bodyP && b.c > p.h && st.fair - b.c >= 1.5 * stopD) plan = { kind: 'rev', dir: 1, stopU: b.c - stopD, tgtU: st.fair };
    }
    if (!plan) continue;
    st.last = b.t;
    const sig = { dir: plan.dir, trig: 'fp' };
    let pk; try { pk = await pickContract(s, plan.dir, b.c, 0); } catch (err) { pk = { why: 'could not load option data (' + ((err && err.code) || 'error') + ')' }; }
    if (pk.why) { logSignal(s, sig, b.c, 'skipped', 'fp ' + plan.kind + ': ' + pk.why); continue; }
    r.fpk.open.push({ sym: s, kind: plan.kind, dir: plan.dir, type: pk.type, strike: pk.strike, exp: pk.exp, inst: pk.inst, t0: Date.now(), sigT: b.t, entryAsk: pk.ask, entryBid: pk.bid, entryU: b.c, stopU: plan.stopU, tgtU: plan.tgtU, fair: st.fair, qAge: pk.qAge, trig: 'fp', peak: pk.bid });
    logSignal(s, sig, b.c, 'entered', 'fp ' + (plan.kind === 'cont' ? 'continuation' : 'reversion to the open ' + st.fair.toFixed(2)) + ': ' + pk.type + ' ' + pk.strike + ' @ ask $' + pk.ask.toFixed(2) + ', stop ' + plan.stopU.toFixed(2) + ', target ' + plan.tgtU.toFixed(2));
  }
  saveRec();
}
async function fpManage() {
  const k = P.rec && P.rec.fpk; if (!k || !k.open.length) return;
  try {
    const qd = await rh('get_option_quotes', { instrument_ids: k.open.map(x => x.inst) }), by = {};
    (qd.results || []).forEach(z => { if (z.quote) by[z.quote.instrument_id] = z.quote; });
    const e = nowET();
    for (const p of k.open.slice()) {
      const q = by[p.inst]; if (!q) continue; const bid = +q.bid_price; if (!(bid >= 0)) continue;
      if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 180000) continue;
      p.peak = Math.max(p.peak || 0, bid); p.live = { bid, ask: +q.ask_price, t: Date.now(), age: q.updated_at ? Date.now() - Date.parse(q.updated_at) : null };
      const bars = (P.bars[p.sym] || []).filter(b => b.t > p.sigT); let reason = '';
      for (const x of bars) { if (p.dir > 0 ? x.l <= p.stopU : x.h >= p.stopU) { reason = 'stop'; break; } if (p.dir > 0 ? x.h >= p.tgtU : x.l <= p.tgtU) { reason = 'target'; break; } }
      if (!reason && bid <= p.entryAsk * 0.5) reason = 'premium stop';
      if (!reason && (e.min >= 690 || !marketOpen(Date.now()))) reason = 'time';
      if (reason) {
        const pnl = Math.round((bid - p.entryAsk) * 10000) / 100, st = k.st[p.sym] || {};
        k.trades.push({ sym: p.sym, type: p.type, strike: p.strike, exp: p.exp, kind: p.kind, entryT: iso(p.t0), entryAsk: p.entryAsk, exitT: iso(Date.now()), exitBid: bid, pnl, peakBid: p.peak, reason, trig: 'fp', qty: 1, entryU: p.entryU, stopU: p.stopU, tgtU: p.tgtU, fair: p.fair, entryQAge: p.qAge, exitQAge: p.live.age });
        k.pnl = Math.round((k.pnl + pnl) * 100) / 100; k.open = k.open.filter(x => x !== p);
        if (p.kind === 'rev') st.losses = pnl > 0 ? 0 : (st.losses || 0) + 1;
      }
    }
    saveRec();
  } catch (err) { P.fpErr = String(err && err.message || err).slice(0, 120); }
}
/* ---------- Variant tracker (VT): logs EVERY raw sweep/EMA signal (taken or not, EMA-filtered or not, extra symbols too) and scores hypothetical exits on the underlying. Never trades; saved to kv key 'vt'. P&L model: 0.45 delta x underlying move x 100, minus $3 cost. ---------- */
const VT_EXTRA = (process.env.VT_EXTRA === undefined ? 'IWM' : process.env.VT_EXTRA).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const VT_VARS = [['none', 5], ['none', 10], ['none', 15], ['wick', 10], ['wick', 15], ['atr1', 10]];
const VT = { doc: null, dirty: false };
function vtScore(bars, it) {
  const ie = bars.findIndex(b => b.t > it.t); if (ie < 0) return;
  const e = bars[ie];
  VT_VARS.forEach(([sn, N]) => {
    const key = sn + '/' + N; if (it.r[key] !== undefined) return;
    if (sn === 'wick' && (it.stopPx === undefined || it.stopPx === null)) return;
    if (bars.length <= ie + N - 1) return;
    const st = sn === 'wick' ? it.stopPx : sn === 'atr1' ? e.o - it.dir * (it.atr || 0) : null;
    let ex = null, hit = 0;
    for (let j = ie; j < ie + N && bars[j] && bars[j].day === e.day; j++) {
      const x = bars[j];
      if (st !== null && (it.dir > 0 ? x.l <= st : x.h >= st)) { ex = st; hit = 1; break; }
      ex = x.c;
    }
    if (ex === null) return;
    it.r[key] = [Math.round(it.dir * (ex - e.o) * 1000) / 1000, hit]; VT.dirty = true;
  });
}
function vtSum(items) {
  const g = {}, r2 = x => Math.round(x * 100) / 100;
  items.forEach(it => Object.keys(it.r).forEach(k => {
    const net = it.r[k][0] * 45 - 3;
    [it.trig + '|' + (it.filt ? 'filtered' : 'pass') + '|' + k, it.trig + '|ALL|' + k, it.sym + '|' + it.trig + '|' + k].forEach(key => {
      const c = g[key] = g[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0 };
      c.n++; c.net += net; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net;
    });
  }));
  const out = {};
  Object.keys(g).sort().forEach(k => { const c = g[k]; out[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avg: r2(c.net / c.n), total: r2(c.net), pf: c.gl ? r2(c.gw / c.gl) : null }; });
  return out;
}
async function vtTick() {
  if (!VT.doc) { VT.doc = (await kget('vt')) || { items: [] }; VT.doc.items = VT.doc.items || []; }
  const vb = {};
  for (const s of CFG.syms.concat(VT_EXTRA.filter(x => !CFG.syms.includes(x)))) {
    let bars = CFG.syms.includes(s) ? P.bars[s] : await pBars(s, false);
    if (!bars || bars.length < 60) continue; vb[s] = bars;
    const raw = Engine.latest(bars, Object.assign({ emaFilter: false }, TRIG_CFG)), inf = Engine.latest(bars, Object.assign({ emaFilter: true }, TRIG_CFG));
    if (raw && raw.signal) {
      const sg = raw.signal, id = s + ':' + raw.bar.t + ':' + sg.trig;
      if (!VT.doc.items.some(x => x.id === id)) { VT.doc.items.push({ id, sym: s, trig: sg.trig, dir: sg.dir, t: raw.bar.t, stopPx: sg.stopPx, atr: sg.atr, filt: !!(inf && inf.emaSkip), r: {} }); VT.dirty = true; }
    }
  }
  VT.doc.items.forEach(it => { if (vb[it.sym]) vtScore(vb[it.sym], it); });
  if (VT.dirty) {
    VT.doc.items = VT.doc.items.slice(-1500); VT.doc.sum = vtSum(VT.doc.items); VT.doc.updated = new Date().toISOString(); VT.dirty = false;
    await kset('vt', VT.doc);
  }
}
async function lookForEntry() {
  const r = P.rec, fresh = [];
  (P.scan || CFG.syms).forEach(s => {
    const inf = P.info[s]; if (!inf || !inf.signal) return;
    if (P.seenSig[s] === inf.bar.t) return; P.seenSig[s] = inf.bar.t;
    if (CHOP_MAX > 0 && inf.chop >= CHOP_MAX) { logSignal(s, inf.signal, inf.bar.c, 'skipped', 'choppy: price crossed VWAP ' + inf.chop + ' times in 30 min'); return; }
    if (Date.now() - (inf.bar.t + 60000) > 150000) { logSignal(s, inf.signal, inf.bar.c, 'skipped', 'signal was more than 2 minutes old when seen'); return; }
    fresh.push(s);
  });
  for (let i = 0; i < fresh.length; i++) {
    const s = fresh[i], inf = P.info[s], sig = inf.signal;
    if (r.pos || i > 0) { logSignal(s, sig, inf.bar.c, 'skipped', r.pos ? 'a position is already open' : 'another symbol signaled first'); continue; }
    if (Date.now() < r.blockUntil) { logSignal(s, sig, inf.bar.c, 'skipped', 'cooling down after a stop'); continue; }
    let pk; try { pk = await pickContract(s, sig.dir, inf.bar.c, P.extNow && EXT_SYMS.includes(s) && !CFG.syms.includes(s) ? EXT_MAXPREM : 0); } catch (e) { pk = { why: 'could not load option data (' + ((e && e.code) || 'error') + ')' }; }
    if (pk.why) { logSignal(s, sig, inf.bar.c, 'skipped', pk.why); continue; }
    r.pos = { sym: s, dir: sig.dir, type: pk.type, strike: pk.strike, exp: pk.exp, inst: pk.inst, t0: Date.now(), sigT: inf.bar.t, entryAsk: pk.ask, entryBid: pk.bid, entryU: inf.bar.c, qAge: pk.qAge, qty: QTY,
      trailR: SWEEP_RUN && sig.trig === 'sweep' && sig.stopPx !== undefined && Math.abs(inf.bar.c - sig.stopPx) > 0.0001 * inf.bar.c ? Math.abs(inf.bar.c - sig.stopPx) : undefined, stopU: sig.stopPx !== undefined ? sig.stopPx : inf.bar.c - sig.dir * Math.max(sig.atr, 0.05), trig: sig.trig, lvl: sig.lvl, peak: pk.bid, iv: pk.iv, delta: pk.delta, flatMin: P.extNow && !CFG.syms.includes(s) ? P.extNow.flat : CFG.dte === 0 ? 935 : 950, ext: P.extNow && !CFG.syms.includes(s) ? P.extNow.name : undefined };
    openShadow(r.pos);
    logSignal(s, sig, inf.bar.c, 'entered', pk.type + ' ' + pk.strike + ' exp ' + pk.exp + ' @ ask $' + pk.ask.toFixed(2));
  }
  saveRec();
}
async function tick() {
  if (P.busy) return; P.busy = true;
  try {
    P.lastTick = Date.now();
    const day = nowET().day;
    if (!P.rec || P.rec.day !== day) {
      if (P.rec && P.rec.pos) { P.rec.trades.push({ sym: P.rec.pos.sym, type: P.rec.pos.type, strike: P.rec.pos.strike, exp: P.rec.pos.exp, entryT: iso(P.rec.pos.t0), entryAsk: P.rec.pos.entryAsk, exitBid: null, pnl: 0, reason: 'unmanaged: left open overnight (paper)', unmanaged: true }); P.rec.pos = null; await saveRec(); }
      P.seenSig = {}; await loadDay(day);
    }
    // limits are off for paper: lift any automatic stop-for-the-day left in today's journal (keeps the manual one)
    if (process.env.ENFORCE_LIMITS !== '1' && P.rec && ['trades', 'losers', 'loss', 'target'].includes(P.rec.shut)) { P.rec.shut = ''; saveRec(); }
    if (!P.ctl.running) { P.msg = 'Stopped. Press START on the dashboard to begin.'; return; }
    if (!S.connected) { P.msg = S.needsLogin ? 'Waiting for Robinhood login.' : 'Reconnecting to Robinhood…'; if (!S.connecting && !S.needsLogin) await connect(); return; }
    const open = marketOpen(Date.now()), ext = open ? null : extSession(Date.now());
    P.extNow = ext;
    // an extended-hours trade must never be left open past its window: close it at the last price we saw
    const sp = P.rec.pos;
    if (sp && !CFG.syms.includes(sp.sym) && !symActive(sp.sym, Date.now())) { const lb = sp.live && sp.live.bid >= 0 ? sp.live.bid : sp.entryBid; closePaper('eod', lb, P.info[sp.sym] || null); }
    if (!open && !ext) { P.msg = 'Market closed. Running and waiting for the open.'; return; }
    P.scan = open ? CFG.syms : EXT_SYMS;
    for (const s of P.scan) {
      const bars = await pBars(s, !open);
      if (bars.length >= 60) { P.bars[s] = bars; P.info[s] = Engine.latest(bars, Object.assign({ emaFilter: EMA_FILTER }, TRIG_CFG, open ? {} : ext.cfg)); }
    }
    if (P.rec.pos) await managePos();
    await manageShadows();
    try { if (open) await fpLook(); await fpManage(); } catch (e) { P.fpErr = String(e && e.message || e).slice(0, 120); }
    try { if (open) await x9Look(); await x9Manage(); } catch (e) { P.x9Err = String(e && e.message || e).slice(0, 120); }
    try { if (open) await cskLook(); await cskManage(); } catch (e) { P.cskErr = String(e && e.message || e).slice(0, 120); }
    if (open) { try { await orbLook(); await manageOrb(); } catch (e) { P.orbErr = String(e && e.message || e).slice(0, 120); } } else { try { await manageOrb(); } catch (e) {} }
    if (open) { try { await vtTick(); } catch (e) { P.vtErr = String(e && e.message || e).slice(0, 120); } }
    if (!P.rec.pos && !P.rec.shut) await lookForEntry();
    P.msg = P.rec.shut ? 'Done for the day (' + P.rec.shut + ').' : (ext ? 'Extended hours (' + ext.name + '-market): scanning ' + EXT_SYMS.join(', ') + '. Last check ' : 'Running. Last check ') + new Date().toISOString().slice(11, 19) + ' UTC.';
    P.tickErr = '';
  } catch (e) {
    P.tickErr = String((e && (e.code || e.message)) || e).slice(0, 160);
    P.msg = 'Could not check the market this round (' + P.tickErr + '). Retrying.';
  } finally { P.busy = false; }
}
async function manualClose() {
  const p = P.rec && P.rec.pos; if (!p) return { ok: false, error: 'no open position' };
  if (P.busy) await new Promise(r => setTimeout(r, 1500));
  const qd = await rh('get_option_quotes', { instrument_ids: [p.inst] }), q = ((qd.results || [])[0] || {}).quote;
  const bid = q ? +q.bid_price : (p.live && p.live.bid); if (!(bid >= 0)) return { ok: false, error: 'no price' };
  closePaper('manual', bid, P.info[p.sym] || null); return { ok: true, bid };
}


/* ---------- city page (3D view) served from here so it works from anywhere ---------- */
const fs = require('fs'), zlib = require('zlib'), path = require('path');
let CITY = null, CITY_GZ = null;
try { CITY = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>' + fs.readFileSync(path.join(__dirname, 'public', 'city.html'), 'utf8').replace('<!--WEB-->', '<script>window.__WEB__=1</script>') + '</body></html>'; CITY_GZ = zlib.gzipSync(CITY); } catch (e) { console.log('city.html missing: ' + e.message); }
function bars5(sym) {
  const st = P.raw[sym]; if (!st) return [];
  const out = {}; Object.keys(st).map(Number).sort((a, b) => a - b).forEach(t => {
    const b = st[t], k = Math.floor(t / 300000) * 300000, o = +b.open_price, c = +b.close_price, h = +b.high_price, l = +b.low_price, v = +b.volume || 0, x = out[k];
    if (!x) out[k] = { begins_at: new Date(k).toISOString(), open_price: o, close_price: c, high_price: h, low_price: l, volume: v };
    else { x.close_price = c; x.high_price = Math.max(x.high_price, h); x.low_price = Math.min(x.low_price, l); x.volume += v; }
  });
  return Object.keys(out).sort().map(k => out[k]);
}
const EXTRA = {}; // display-only symbols the page asked for (never traded)
async function extraBars(list) {
  const out = [];
  for (const s of list) {
    if (CFG.syms.includes(s) || !/^[A-Z.]{1,6}$/.test(s) || out.length >= 8) continue;
    out.push(s); const e = EXTRA[s] = EXTRA[s] || { at: 0 };
    if (Date.now() - e.at > 20000 && S.connected) { e.at = Date.now(); try { await pBars(s); e.err = ''; } catch (x) { e.err = String((x && (x.code || x.message)) || x).slice(0, 80); } }
  }
  return out;
}
function recOut() {
  const r = P.rec;
  return r ? { shut: r.shut || '', day: r.day, pnl: r.pnl, ntr: r.trades.length, tr: r.trades.slice(-30).map(t => ({ sym: t.sym, k: t.strike, ty: t.type, in: t.entryT, pnl: t.pnl, why: t.reason })), sh: r.sh ? r.sh.pnl : null, orb: r.orbk ? { pnl: r.orbk.pnl, open: r.orbk.open.map(o => ({ sym: o.sym, strike: o.strike, type: o.type, exp: o.exp, entryAsk: o.entryAsk, t0: o.t0, stopU: o.stopU, tgtU: o.tgtU, live: o.live })), trades: r.orbk.trades.map(t => ({ sym: t.sym, strike: t.strike, type: t.type, entryT: t.entryT, pnl: t.pnl, reason: t.reason })) } : null, upd: new Date(P.lastTick || Date.now()).toISOString(), run: { running: !!P.ctl.running }, pos: r.pos ? { sym: r.pos.sym, strike: r.pos.strike, type: r.pos.type, exp: r.pos.exp, entryAsk: r.pos.entryAsk, entryBid: r.pos.entryBid, qty: r.pos.qty || 1, half: r.pos.half || null, peak: r.pos.peak, t0: r.pos.t0, trig: r.pos.trig, live: r.pos.live } : null } : null;
}
function liveData() { return { now: Date.now(), run: !!P.ctl.running, market: marketOpen(Date.now()), msg: P.msg, rec: recOut() }; }
/* scorecard: every closed paper trade, grouped by ticker x strategy (entry trigger: vwap / ema / orb / sweep) */
function scoreOf(scan) {
  const cells = {}, add = (k, pnl, day) => { const c = cells[k] = cells[k] || { n: 0, w: 0, pnl: 0, gw: 0, gl: 0, since: day }; c.n++; if (pnl > 0) { c.w++; c.gw += pnl; } else if (pnl < 0) c.gl -= pnl; c.pnl += pnl; if (day < c.since) c.since = day; };
  (scan || []).forEach(x => {
    const day = (x.value && x.value.day) || String(x.key).slice(4);
    ((x.value && x.value.trades) || []).concat((x.value && x.value.orbk && x.value.orbk.trades) || []).forEach(t => { // includes the ORB5 book (trig orb5)
      if (!(t.exitT || t.exitBid != null) || t.unmanaged) return;
      const trig = t.trig || 'ema', pnl = +t.pnl || 0, sym = t.sym || '?';
      add(sym + '|' + trig, pnl, day); add(sym + '|*', pnl, day); add('*|' + trig, pnl, day); add('*|*', pnl, day);
      add('*|@' + (t.ext || 'reg'), pnl, day); if (t.ext) add(sym + '|@ext', pnl, day); // session: pre / post / regular
    });
  });
  const out = {}; Object.keys(cells).forEach(k => { const c = cells[k]; out[k] = { n: c.n, w: c.w, pnl: Math.round(c.pnl * 100) / 100, pf: c.gl ? Math.round(c.gw / c.gl * 100) / 100 : null, since: c.since }; });
  return out;
}
/* outside market hours the 20 s tick doesn't fetch candles, so the towers would say "loading" after every restart: load them on demand */
const ENS = {};
async function ensureBars(list) {
  if (!S.connected || marketOpen(Date.now())) return;
  await Promise.all(list.map(async s => { const e = ENS[s] = ENS[s] || { at: 0 }; if (P.raw[s] && Date.now() - e.at < 60000) return; e.at = Date.now(); try { await pBars(s); } catch (x) { e.err = String((x && (x.code || x.message)) || x).slice(0, 80); } }));
}
async function cityData(want) {
  await ensureBars(CFG.syms);
  const bars = {}; CFG.syms.forEach(s => { bars[s] = bars5(s); });
  (await extraBars(WATCH || want || [])).forEach(s => { bars[s] = bars5(s); });
  const scan = await kscan('rec:', 200), score = scoreOf(scan);
  const days = scan.slice(0, 60).map(x => ({ day: x.value.day || x.key.slice(4), trades: (x.value.trades || []).concat((x.value.orbk && x.value.orbk.trades) || []).filter(t => t.exitT || t.exitBid != null).map(t => ({ t: Date.parse(t.exitT || t.entryT), sym: t.sym, pnl: +t.pnl || 0 })) }));
  return Object.assign(liveData(), { bars, days, watch: WATCH, score });
}

/* ---------- web: dashboard + API ---------- */
function status() {
  const r = P.rec, p = r && r.pos;
  return { now: Date.now(), running: !!P.ctl.running, mode: 'PAPER', msg: P.msg, tickErr: P.tickErr, saveErr: P.saveErr, lastTick: P.lastTick, market: marketOpen(Date.now()),
    robinhood: { connected: S.connected, needsLogin: S.needsLogin, err: S.err, lastOk: S.lastOk }, store: pool ? 'database' : 'MEMORY ONLY',
    day: r && r.day, pnl: r && r.pnl, shut: r && r.shut, trades: (r && r.trades || []).slice(-20), signals: (r && r.signals || []).slice(-12),
    orb: r && r.orbk ? { pnl: r.orbk.pnl, closed: r.orbk.trades.length, open: r.orbk.open.length, on: ORB_ON } : null,
    fairPrice: r && r.fpk ? { pnl: r.fpk.pnl, closed: r.fpk.trades.length, open: r.fpk.open.length, on: FP_ON, err: P.fpErr } : null,
    x9: r && r.x9k ? { pnl: r.x9k.pnl, closed: r.x9k.trades.length, open: r.x9k.open.length, on: X9_ON, err: P.x9Err } : null,
    callSpreads: r && r.csk ? { pnl: r.csk.pnl, closed: r.csk.trades.length, open: r.csk.open.length, on: CSK_ON, err: P.cskErr } : null,
    shadow: r && r.sh ? { pnl: r.sh.pnl, closed: r.sh.trades.length, open: r.sh.open.length } : null,
    pos: p ? { sym: p.sym, type: p.type, strike: p.strike, exp: p.exp, entryAsk: p.entryAsk, qty: p.qty || 1, half: p.half || null, t0: p.t0, bid: p.live && p.live.bid, peak: p.peak, asOf: p.live && p.live.t, stopPx: CFG.usd ? p.entryAsk - CFG.usd.stop / 100 : p.entryAsk * (1 - CFG.premStop), targetPx: CFG.usd ? p.entryAsk + CFG.usd.tp / 100 : p.entryAsk * (1 + CFG.tpUp) } : null,
    limits: { target: CFG.target, loss: CFG.loss, syms: CFG.syms } };
}
const authed = (u, req) => ADMIN_KEY && (u.searchParams.get('key') === ADMIN_KEY || req.headers['x-key'] === ADMIN_KEY);
function send(res, code, body, type) { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-key,content-type' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
const BT = { run: false, res: null };
/* Read-only study: does price keep going our way after each entry signal? (underlying only, no options). */
async function backtest(days) {
  const simAll = {}, out = { days, syms: {}, all: {}, hold: {} }, now = Date.now(), H = [1, 3, 5, 10];
  const add = (m, key, v) => { const c = m[key] = m[key] || { n: 0, w: {}, sum: {}, atr: {} }; c.n++; H.forEach(h => { if (v[h] === undefined) return; c.w[h] = (c.w[h] || 0) + (v[h] > 0 ? 1 : 0); c.sum[h] = (c.sum[h] || 0) + v[h]; c.atr[h] = (c.atr[h] || 0) + v.a[h]; }); };
  for (const sym of CFG.syms) {
    const st = {};
    for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
      const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
      (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    }
    const bars = Engine.prepare(Object.keys(st).map(k => st[k])); Engine.simulate(bars, {}, true); // fills indicators
    const sigs = Engine.signals(bars, {});
    const sw = Engine.simulate(bars, { vwap: false, orb: false }, true), al = Engine.simulate(bars, {}, true), pick = r => ({ days: r.summary.days, trades: r.summary.trades, winRate: Math.round(1000 * r.summary.winRate) / 10, avgWin: Math.round(r.summary.avgWin * 100) / 100, avgLoss: Math.round(r.summary.avgLoss * 100) / 100, pf: Math.round(r.summary.profitFactor * 100) / 100, total: Math.round(r.summary.total * 100) / 100 });
    simAll[sym] = { sweepOnly: pick(sw), all: pick(al) };
    const m = out.syms[sym] = {};
    sigs.forEach(g => {
      const k = g.k, b = bars[k], dir = g.sig.dir, v = { a: {} }, tags = [g.sig.trig];
      H.forEach(h => { if (bars[k + h] && bars[k + h].day === b.day) { v[h] = dir * (bars[k + h].c - b.c); v.a[h] = v[h] / (b.atr || 1); } });
      // chop: VWAP crossed 3+ times in the last 30 bars
      let x = 0; for (let j = Math.max(1, k - 30); j <= k; j++) if (bars[j].day === b.day && (bars[j].c - bars[j].vwap) * (bars[j - 1].c - bars[j - 1].vwap) < 0) x++;
      tags.push(x >= 3 ? 'chop' : 'trend');
      tags.push('ALL'); if (g.sig.trig === 'sweep') tags.push(x >= 3 ? 'sweep+chop' : 'sweep+trend');
      if (g.sig.trig === 'ema') {
        const pk = bars[k - 5] || bars[k - 1], slope = dir * (b.e50 - pk.e50) > 0, vw = dir * (b.c - b.vwap) > 0, body = Math.abs(b.c - b.o) >= 0.5 * b.atr;
        tags.push('ema:' + (b.min < 630 ? 'open' : b.min < 840 ? 'mid' : 'late'), 'ema:' + (x >= 3 ? 'chop' : 'trend'), 'ema:slope' + (slope ? '+' : '-'), 'ema:vwap' + (vw ? '+' : '-'), 'ema:body' + (body ? 'big' : 'small'), 'ema:' + (slope && vw ? 'slope+vwap' : 'other'), 'ema:' + (slope && vw && x < 3 ? 'all3' : 'not-all3'));
        const n1 = bars[k + 1];
        if (n1 && n1.day === b.day && dir * (n1.c - b.c) > 0) tags.push('ema:confirmed');
      }
      tags.forEach(t => { add(m, t, v); add(out.all, t, v); });
      // confirmation variant: next bar must also close beyond the signal bar's close; measure from that bar
      const n1 = bars[k + 1];
      if (n1 && n1.day === b.day && dir * (n1.c - b.c) > 0) { const w = { a: {} }; H.forEach(h => { if (bars[k + 1 + h] && bars[k + 1 + h].day === b.day) { w[h] = dir * (bars[k + 1 + h].c - n1.c); w.a[h] = w[h] / (b.atr || 1); } }); add(m, 'confirmed', w); add(out.all, 'confirmed', w); }
    });
    // Hold study (sweep only): enter next bar open, exit on stop or after N bars; option P&L approximated as delta 0.45 x underlying move, minus a $3 spread/slippage cost per contract.
    sigs.filter(g => g.sig.trig === 'sweep').forEach(g => {
      const k = g.k, b = bars[k], dir = g.sig.dir, e = bars[k + 1];
      if (!e || e.day !== b.day) return;
      const stops = { wick: g.sig.stopPx, none: null, atr1: e.o - dir * (b.atr || 0) };
      [5, 10, 15, 20, 30].forEach(N => Object.keys(stops).forEach(sn => {
        let ex = null, why = 'time', j = k + 1;
        for (; j <= k + N && bars[j] && bars[j].day === b.day; j++) {
          const x = bars[j], st = stops[sn];
          if (st !== null && st !== undefined && (dir > 0 ? x.l <= st : x.h >= st)) { ex = st; why = 'stop'; break; }
          ex = x.c;
        }
        if (ex === null) return;
        const u = dir * (ex - e.o), net = u * 100 * 0.45 - 3, key = sn + '/' + N + 'min';
        [out.hold[sym] = out.hold[sym] || {}, out.hold.ALL = out.hold.ALL || {}].forEach(m => {
          const c = m[key] = m[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, u: 0, stops: 0, risk: 0 };
          c.n++; c.net += net; c.u += u; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net; if (why === 'stop') c.stops++;
          c.risk += Math.abs(e.o - (g.sig.stopPx || e.o)) * 45;
        });
      }));
    });
  }
  Object.keys(out.hold).forEach(m => Object.keys(out.hold[m]).forEach(k => { const c = out.hold[m][k], r = x => Math.round(x * 100) / 100; out.hold[m][k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgNet: r(c.net / c.n), total: r(c.net), pf: c.gl ? r(c.gw / c.gl) : null, avgU: r(c.u / c.n), stopPct: Math.round(100 * c.stops / c.n), wickRiskPerContract: r(c.risk / c.n) }; }));
  const fin = m => { const r = {}; Object.keys(m).forEach(k => { const c = m[k]; r[k] = { n: c.n }; H.forEach(h => { r[k]['up' + h] = c.n ? Math.round(100 * (c.w[h] || 0) / c.n) : null; r[k]['avg' + h + '$'] = c.n ? Math.round(100 * (c.sum[h] || 0) / c.n) / 100 : null; r[k]['avg' + h + 'ATR'] = c.n ? Math.round(100 * (c.atr[h] || 0) / c.n) / 100 : null; }); }); return r; };
  Object.keys(out.syms).forEach(s => { out.syms[s] = fin(out.syms[s]); });
  out.sim = simAll; out.all = fin(out.all); out.done = new Date().toISOString();
  return out;
}
/* ---------- Study 2 (read-only): about a year of 1-minute bars. Tests (A) opening-range breakout with R-multiple targets, (B) first-half-hour -> last-half-hour momentum, (C) sweep/EMA hold variants incl. the EMA filter. Option P&L model: 0.45 delta x underlying move x 100 minus $3 per contract (screen only, not proof). Saved to kv 'bt2'. ---------- */
const BT2 = { run: false, res: null };
async function backtest2(days) {
  const now = Date.now(), out = { days, started: new Date().toISOString(), orb: {}, mom: {}, hold: {}, n: {} }, r2 = x => Math.round(x * 100) / 100;
  const acc = (m, key, net, extra) => { const c = m[key] = m[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, x: 0 }; c.n++; c.net += net; c.x += extra || 0; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net; };
  const fin = m => { const r = {}; Object.keys(m).sort().forEach(k => { const c = m[k]; r[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgNet: r2(c.net / c.n), total: r2(c.net), pf: c.gl ? r2(c.gw / c.gl) : null, avgX: r2(c.x / c.n) }; }); return r; };
  const ORBM = {}, MOMM = {}, HOLDM = {};
  for (const sym of CFG.syms) {
    const st = {};
    for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
      const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
      (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    }
    const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[sym] = 'too few bars: ' + bars.length; continue; }
    Engine.simulate(bars, {}, true);
    const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
    const half = d => dayList.indexOf(d) < dayList.length / 2 ? 'H1' : 'H2';
    out.n[sym] = { bars: bars.length, sessions: dayList.length, from: dayList[0], to: dayList[dayList.length - 1] };
    const add = (M, key, d, net, x) => { acc(M, key + '|ALL', net, x); acc(M, key + '|' + half(d), net, x); acc(M, sym + '|' + key + '|ALL', net, x); };
    // per-day slices
    let i = 0, prevClose = null;
    const moms = [];
    while (i < bars.length) {
      let j = i; while (j < bars.length && bars[j].day === bars[i].day) j++;
      const D = bars[i].day;
      // (A) opening-range breakout, first 5 minutes
      const or = []; for (let q = i; q < j; q++) if (bars[q].min >= 570 && bars[q].min <= 574) or.push(bars[q]);
      if (or.length === 5) {
        const orH = Math.max(...or.map(b => b.h)), orL = Math.min(...or.map(b => b.l));
        for (let k = i; k < j - 1; k++) {
          const b = bars[k]; if (b.min < 575 || b.min > 900) continue;
          const dir = b.c > orH ? 1 : b.c < orL ? -1 : 0; if (!dir) continue;
          const e = bars[k + 1].o, stop = dir > 0 ? orL : orH, risk = Math.abs(e - stop);
          if (risk > 0.0001 * e) [['1R', 1], ['1.5R', 1.5], ['2R', 2], ['3R', 3], ['hold', 0]].forEach(([nm, mult]) => {
            let xr = null;
            for (let q = k + 1; q < j && bars[q].min < 930; q++) {
              const x = bars[q], hitS = dir > 0 ? x.l <= stop : x.h >= stop, hitT = mult && (dir > 0 ? x.h >= e + mult * risk : x.l <= e - mult * risk);
              if (hitS) { xr = -1; break; } if (hitT) { xr = mult; break; }
              xr = dir * (x.c - e) / risk;
            }
            if (xr === null) return;
            add(ORBM, 'orb5|' + nm, D, xr * risk * 45 - 3, xr);
          });
          break; // first breakout of the day only
        }
      }
      // (B) momentum: first half-hour -> last half-hour
      const b10 = bars.find((b, ix) => ix >= i && ix < j && b.min === 599), b930 = bars.find((b, ix) => ix >= i && ix < j && b.min === 930);
      if (b10 && b930 && prevClose) {
        const last = bars[j - 1], r1 = b10.c - prevClose, rF = b10.c - bars[i].o;
        moms.push({ D, e: b930.o, x: last.c, r1, rF, rel: Math.abs(r1) / prevClose });
      }
      prevClose = bars[j - 1].c;
      i = j;
    }
    const sorted = moms.map(m => m.rel).sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * 2 / 3)] || 0;
    moms.forEach(m => {
      [['r1', m.r1], ['rFirst30', m.rF]].forEach(([nm, r]) => { const dir = r > 0 ? 1 : r < 0 ? -1 : 0; if (!dir) return; const u = dir * (m.x - m.e); add(MOMM, 'mom|' + nm, m.D, u * 45 - 3, u > 0 ? 1 : 0); if (m.rel >= top) add(MOMM, 'mom|' + nm + '|highvol', m.D, u * 45 - 3, u > 0 ? 1 : 0); });
    });
    // (C) sweep / EMA hold variants on all signals, with the EMA slope+VWAP filter flag
    Engine.signals(bars, { vwap: false, orb: false }).forEach(g => {
      const k = g.k, b = bars[k], dir = g.sig.dir, e = bars[k + 1]; if (!e || e.day !== b.day) return;
      const pk = bars[k - 5] || bars[k - 1], filt = g.sig.trig === 'ema' && dir * (b.e50 - pk.e50) > 0 && dir * (b.c - b.vwap) > 0, tag = g.sig.trig + (g.sig.trig === 'ema' ? (filt ? '-filtered' : '-pass') : '');
      const stops = { wick: g.sig.stopPx, none: null, atr1: e.o - dir * (b.atr || 0) };
      [5, 10, 15, 20, 30].forEach(N => Object.keys(stops).forEach(sn => {
        if (sn === 'wick' && (stops[sn] === undefined || stops[sn] === null)) return;
        let ex = null; const st2 = stops[sn];
        for (let q = k + 1; q <= k + N && bars[q] && bars[q].day === b.day; q++) { const x = bars[q]; if (st2 !== null && (dir > 0 ? x.l <= st2 : x.h >= st2)) { ex = st2; break; } ex = x.c; }
        if (ex === null) return;
        const u = dir * (ex - e.o); add(HOLDM, tag + '|' + sn + '/' + N, b.day, u * 45 - 3, u);
      }));
    });
  }
  out.orb = fin(ORBM); out.mom = fin(MOMM); out.hold = fin(HOLDM); out.done = new Date().toISOString();
  return out;
}
/* ---------- Study 3 (read-only): payoff-shaped exits for sweep and EMA over about a year. Entry next bar open; stop = wick (sweep) or 1/2/3 x ATR; exit = 1R/2R/3R target, a 1R chandelier trail, or a 60-minute time exit; all flat by 15:30 ET. Same-bar stop+target counts as a stop. Option P&L model: 0.45 delta x move x 100 minus $3. Saved to kv 'bt3'. ---------- */
async function backtest3(days) {
  const now = Date.now(), out = { days, started: new Date().toISOString(), n: {} }, r2 = x => Math.round(x * 100) / 100, M = {};
  const acc = (key, net, x) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, x: 0 }; c.n++; c.net += net; c.x += x; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net; };
  for (const sym of CFG.syms) {
    const st = {};
    for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
      const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
      (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    }
    const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[sym] = 'too few bars: ' + bars.length; continue; }
    Engine.simulate(bars, {}, true);
    const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
    out.n[sym] = { bars: bars.length, sessions: dayList.length };
    const halfOf = {}; dayList.forEach((d, ix) => { halfOf[d] = ix < dayList.length / 2 ? 'H1' : 'H2'; });
    Engine.signals(bars, { vwap: false, orb: false }).forEach(g => {
      const k = g.k, b = bars[k], dir = g.sig.dir, e = bars[k + 1]; if (!e || e.day !== b.day || !(b.atr > 0)) return;
      const pk = bars[k - 5] || bars[k - 1], filt = g.sig.trig === 'ema' && dir * (b.e50 - pk.e50) > 0 && dir * (b.c - b.vwap) > 0;
      const tag = g.sig.trig === 'ema' ? (filt ? 'ema-filtered' : 'ema-pass') : 'sweep', tod = b.min < 630 ? 'open' : b.min < 840 ? 'mid' : 'late';
      const stops = { atr1: b.atr, atr2: 2 * b.atr, atr3: 3 * b.atr }; if (g.sig.stopPx !== undefined && g.sig.stopPx !== null) stops.wick = Math.abs(e.o - g.sig.stopPx);
      Object.keys(stops).forEach(sn => {
        const R = stops[sn]; if (!(R > 0.0001 * e.o)) return;
        [['1R', 1], ['2R', 2], ['3R', 3], ['trail', 0], ['t60', 0]].forEach(([en, mult]) => {
          let stop = e.o - dir * R, best = e.o, xr = null;
          for (let q = k + 1; q < bars.length && bars[q].day === b.day && bars[q].min < 930; q++) {
            const x = bars[q];
            if (dir > 0 ? x.l <= stop : x.h >= stop) { xr = dir * (stop - e.o) / R; break; }
            if (mult && (dir > 0 ? x.h >= e.o + mult * R : x.l <= e.o - mult * R)) { xr = mult; break; }
            if (en === 'trail') { best = dir > 0 ? Math.max(best, x.h) : Math.min(best, x.l); const ns = best - dir * R; if (dir * (ns - stop) > 0) stop = ns; }
            xr = dir * (x.c - e.o) / R;
            if (en === 't60' && q - k >= 60) break;
          }
          if (xr === null) return;
          const net = xr * R * 45 - 3, key = tag + '|' + sn + '|' + en;
          acc(key + '|ALL', net, xr); acc(key + '|' + halfOf[b.day], net, xr); acc(key + '|' + tod, net, xr); acc(sym + '|' + key, net, xr);
        });
      });
    });
  }
  out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgNet: r2(c.net / c.n), pf: c.gl ? r2(c.gw / c.gl) : null, avgR: r2(c.x / c.n) }; });
  out.done = new Date().toISOString();
  return out;
}
/* ---------- Study 4 (read-only): tighter-trail variants for the sweep run exit, with a train/lock split (first 2/3 of sessions = train, last 1/3 = lock, look at lock once). Wick stop, entry next bar open, flat 15:30 ET. Stop is checked against the level set before each bar; after the trail moves, a close below the new stop exits at that close. 'noise' = same bars with a coin-flip direction (should come out near minus the $3 cost). Saved to kv 'bt4'. ---------- */
async function backtest4(days) {
  const now = Date.now(), out = { days, started: new Date().toISOString(), n: {} }, r2 = x => Math.round(x * 100) / 100, M = {};
  const acc = (key, net, x) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, x: 0 }; c.n++; c.net += net; c.x += x; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net; };
  // variant: [name, initial trail in R, arm level in R (null = none), trail after arm in R, breakeven at arm, fixed target in R]
  const V = [['base-1R', 1, null, 1, false, 0], ['arm1-0.5R', 1, 1, 0.5, false, 0], ['arm1-0.33R', 1, 1, 0.33, false, 0], ['arm1-BE', 1, 1, 1, true, 0], ['arm0.5-0.5R', 1, 0.5, 0.5, false, 0], ['flat-0.5R', 0.5, null, 0.5, false, 0], ['arm2-0.5R', 1, 2, 0.5, false, 0], ['tgt-1R', 1, null, 1, false, 1], ['tgt-2R', 1, null, 1, false, 2]];
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const sym of CFG.syms) {
    const st = {};
    for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
      const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
      (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    }
    const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[sym] = 'too few bars: ' + bars.length; continue; }
    Engine.simulate(bars, {}, true);
    const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
    const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
    out.n[sym] = { bars: bars.length, sessions: dayList.length, lockFrom: dayList[Math.ceil(dayList.length * 2 / 3)] };
    const run = (k, dir, R, v) => {
      const e = bars[k + 1], b = bars[k]; let stop = e.o - dir * R, best = e.o, xr = null, armed = false;
      for (let q = k + 1; q < bars.length && bars[q].day === b.day && bars[q].min < 930; q++) {
        const x = bars[q];
        if (dir > 0 ? x.l <= stop : x.h >= stop) { xr = dir * (stop - e.o) / R; break; }
        if (v[5] && (dir > 0 ? x.h >= e.o + v[5] * R : x.l <= e.o - v[5] * R)) { xr = v[5]; break; }
        if (!v[5]) {
          best = dir > 0 ? Math.max(best, x.h) : Math.min(best, x.l);
          if (v[2] !== null && !armed && dir * (best - e.o) >= v[2] * R) armed = true;
          let ns = best - dir * (armed ? v[3] : v[1]) * R; if (armed && v[4] && dir * (e.o - ns) > 0) ns = e.o;
          if (dir * (ns - stop) > 0) stop = ns;
          if (dir * (x.c - stop) < 0) { xr = dir * (x.c - e.o) / R; break; }
        }
        xr = dir * (x.c - e.o) / R;
      }
      return xr;
    };
    Engine.signals(bars, { vwap: false, orb: false, ema: false }).forEach(g => {
      const k = g.k, b = bars[k], e = bars[k + 1]; if (g.sig.trig !== 'sweep' || !e || e.day !== b.day || g.sig.stopPx === undefined || g.sig.stopPx === null) return;
      const R = Math.abs(e.o - g.sig.stopPx); if (!(R > 0.0001 * e.o)) return;
      V.forEach(v => { const xr = run(k, g.sig.dir, R, v); if (xr === null) return; const net = xr * R * 45 - 3; acc(v[0] + '|ALL', net, xr); acc(v[0] + '|' + split[b.day], net, xr); acc(v[0] + '|' + sym, net, xr); acc(v[0] + '|' + sym + '|' + split[b.day], net, xr); });
      const nd = rnd() < 0.5 ? 1 : -1, xn = run(k, nd, R, V[0]); if (xn !== null) acc('noise|ALL', xn * R * 45 - 3, xn);
    });
  }
  out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgNet: r2(c.net / c.n), pf: c.gl ? r2(c.gw / c.gl) : null, avgR: r2(c.x / c.n) }; });
  out.done = new Date().toISOString();
  return out;
}
/* ---------- Study 5 (read-only): ORB re-check with a train/lock split (first 2/3 of sessions = train, last 1/3 = lock), neighbors (3/5/10/15-minute ranges; 1R/1.5R/2R/3R/hold) and a noise check (same breakout bars, coin-flip direction, symmetric stop at R, 2R target; should come out near minus the $3 cost). Stop is checked before target in the same bar. Saved to kv 'bt5'. ---------- */
async function backtest5(days) {
  const now = Date.now(), out = { days, started: new Date().toISOString(), n: {} }, r2 = x => Math.round(x * 100) / 100, M = {};
  const acc = (key, net, x) => { const c = M[key] = M[key] || { n: 0, w: 0, gw: 0, gl: 0, net: 0, x: 0 }; c.n++; c.net += net; c.x += x; if (net > 0) { c.w++; c.gw += net; } else c.gl += -net; };
  let seed = 777; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const sym of CFG.syms) {
    const st = {};
    for (let a = now - days * 864e5; a < now; a += 4 * 864e5) {
      const d = await rh('get_equity_historicals', { symbols: [sym], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' });
      (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; });
    }
    const bars = Engine.prepare(Object.keys(st).map(k => st[k])); if (bars.length < 1000) { out.n[sym] = 'too few bars: ' + bars.length; continue; }
    const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day) dayList.push(b.day); });
    const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; });
    out.n[sym] = { bars: bars.length, sessions: dayList.length, lockFrom: dayList[Math.ceil(dayList.length * 2 / 3)] };
    const play = (k, j, dir, e, stop, risk, mult) => { let xr = null; for (let q = k + 1; q < j && bars[q].min < 930; q++) { const x = bars[q], hitS = dir > 0 ? x.l <= stop : x.h >= stop, hitT = mult && (dir > 0 ? x.h >= e + mult * risk : x.l <= e - mult * risk); if (hitS) { xr = -1; break; } if (hitT) { xr = mult; break; } xr = dir * (x.c - e) / risk; } return xr; };
    let i = 0;
    while (i < bars.length) {
      let j = i; while (j < bars.length && bars[j].day === bars[i].day) j++;
      const D = bars[i].day;
      [3, 5, 10, 15].forEach(W => {
        const or = []; for (let q = i; q < j; q++) if (bars[q].min >= 570 && bars[q].min < 570 + W) or.push(bars[q]);
        if (or.length !== W) return;
        const orH = Math.max(...or.map(b => b.h)), orL = Math.min(...or.map(b => b.l));
        for (let k = i; k < j - 1; k++) {
          const b = bars[k]; if (b.min < 570 + W || b.min > 900) continue;
          const dir = b.c > orH ? 1 : b.c < orL ? -1 : 0; if (!dir) continue;
          const e = bars[k + 1].o, stop = dir > 0 ? orL : orH, risk = Math.abs(e - stop);
          if (risk > 0.0001 * e && dir * (e - stop) > 0) {
            [['1R', 1], ['1.5R', 1.5], ['2R', 2], ['3R', 3], ['hold', 0]].forEach(([nm, mult]) => {
              const xr = play(k, j, dir, e, stop, risk, mult); if (xr === null) return;
              const net = xr * risk * 45 - 3, key = 'orb' + W + '|' + nm;
              acc(key + '|ALL', net, xr); acc(key + '|' + split[D], net, xr); acc(key + '|' + sym + '|' + split[D], net, xr); acc(key + '|' + (dir > 0 ? 'long' : 'short') + '|ALL', net, xr);
            });
            if (W === 5) for (let rep = 0; rep < 20; rep++) { const nd = rnd() < 0.5 ? 1 : -1, xn = play(k, j, nd, e, e - nd * risk, risk, 2); if (xn !== null) acc('noise5|2R|ALL', xn * risk * 45 - 3, xn); }
          }
          break;
        }
      });
      i = j;
    }
  }
  out.res = {}; Object.keys(M).sort().forEach(k => { const c = M[k]; out.res[k] = { n: c.n, win: Math.round(100 * c.w / c.n), avgNet: r2(c.net / c.n), pf: c.gl ? r2(c.gw / c.gl) : null, avgR: r2(c.x / c.n) }; });
  out.done = new Date().toISOString();
  return out;
}
/* ---------- one-time probe: can we get real historical option prices for expired 0DTE contracts from Alpaca? Saved to kv 'probe'. ---------- */
async function optProbe() {
  const out = { at: new Date().toISOString(), days: {} };
  for (const day of ['2026-11-06', '2026-05-15', '2025-03-14', '2024-03-15']) {
    const o = out.days[day] = {};
    try {
      const sb = await ap('/v2/stocks/SPY/bars', { timeframe: '1Day', start: day + 'T00:00:00Z', end: day + 'T23:59:00Z', feed: 'iex', limit: 1 });
      const px = sb.bars && sb.bars[0] ? sb.bars[0].o : null; o.spyOpen = px; if (!px) continue;
      const k = Math.round(px), ymd = day.slice(2, 4) + day.slice(5, 7) + day.slice(8, 10);
      const syms = [k, k + 2, k - 2].map((x, ix) => 'SPY' + ymd + (ix === 2 ? 'P' : 'C') + String(x * 1000).padStart(8, '0')); o.syms = syms;
      const b = await ap('/v1beta1/options/bars', { symbols: syms.join(','), timeframe: '1Min', start: day + 'T13:30:00Z', end: day + 'T21:00:00Z', limit: 1500 });
      o.bars = {}; Object.keys(b.bars || {}).forEach(x => { const a = b.bars[x]; o.bars[x] = { n: a.length, first: a[0], last: a[a.length - 1] }; }); o.next = b.next_page_token || null;
      try { const t = await ap('/v1beta1/options/trades', { symbols: syms[0], start: day + 'T13:30:00Z', end: day + 'T21:00:00Z', limit: 5 }); o.trades = (t.trades && t.trades[syms[0]] || []).length; o.trade0 = t.trades && t.trades[syms[0]] && t.trades[syms[0]][0]; } catch (e) { o.tradesErr = String(e.message).slice(0, 160); }
    } catch (e) { o.err = String(e && e.message || e).slice(0, 200); }
  }
  return out;
}
setTimeout(async () => { try { const cur = await kget('bt13'); if (cur && cur.progress === 'done') return; await kset('bt13', await require('./study_orb15.js')(ap, kset)); } catch (e) { try { await kset('bt13', { error: String(e && e.message || e) }); } catch (e2) {} } }, 50000); // ORB variants from the QuantORB reel on real 0DTE prices, once
setTimeout(async () => { try { const cur = await kget('bt14'); if (cur && cur.progress === 'done') return; await kset('bt14', await require('./study_fp.js')(ap, kset)); } catch (e) { try { await kset('bt14', { error: String(e && e.message || e) }); } catch (e2) {} } }, 55000); // fair-pricing theory (JJ Simon video) on real 0DTE prices, once
setTimeout(async () => { try { const cur = await kget('bt12'); if (cur && cur.progress === 'done') return; await kset('bt12', await require('./study_x9.js')(ap, rh, Engine, kset, { key: 'bt12' })); } catch (e) { try { await kset('bt11', { error: String(e && e.message || e) }); } catch (e2) {} } }, 45000); // EMA9 x VWAP reel strategy on real 0DTE prices, once
setTimeout(async () => { try { const cur = await kget('bt10'); if (cur && cur.progress === 'done') return; await kset('bt10', await require('./study_lock.js')(ap, rh, Engine, kset)); } catch (e) { try { await kset('bt10', { error: String(e && e.message || e) }); } catch (e2) {} } }, 45000); // profit-lock study on real 0DTE prices, once
setTimeout(async () => { try { const cur = await kget('bt9'); if (cur && cur.progress === 'done') return; await kset('bt9', await require('./study_exits.js')(ap, rh, Engine, kset)); } catch (e) { try { await kset('bt9', { error: String(e && e.message || e) }); } catch (e2) {} } }, 45000); // exit studies (spread profit taking, sweep signal failure), once
setTimeout(async () => { try { const cur = await kget('bt8'); if (cur && cur.progress === 'done') return; await kset('bt8', await require('./study_sweep.js')(ap, rh, Engine, kset)); } catch (e) { try { await kset('bt8', { error: String(e && e.message || e) }); } catch (e2) {} } }, 45000); // sweep on real option prices by symbol, once
setTimeout(async () => { try { const cur = await kget('bt7'); if (cur && cur.progress === 'done') return; await kset('bt7', await require('./study0dte2.js')(ap, kset)); } catch (e) { try { await kset('bt7', { error: String(e && e.message || e) }); } catch (e2) {} } }, 30000); // call-spread reliability study, once
setTimeout(async () => { try { const cur = await kget('bt6'); if (cur && cur.progress === 'done') return; await kset('bt6', await require('./study0dte.js')(ap, kset)); } catch (e) { try { await kset('bt6', { error: String(e && e.message || e) }); } catch (e2) {} } }, 30000); // 0DTE real-option-price study, once
setTimeout(async () => { try { if (await kget('probe')) return; await kset('probe', await optProbe()); } catch (e) { try { await kset('probe', { error: String(e && e.message || e) }); } catch (e2) {} } }, 20000);
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (u.pathname === '/health') return send(res, 200, { ok: true });
    if (u.pathname === '/oauth/callback') {
      const code = u.searchParams.get('code');
      if (!code) return send(res, 400, 'Missing code', 'text/plain');
      await S.transport.finishAuth(code); await connect();
      return send(res, 200, '<meta name=viewport content="width=device-width"><body style="font:18px system-ui;padding:24px;background:#080626;color:#fff">Robinhood is connected. You can close this tab and open your dashboard.</body>', 'text/html');
    }
    if (!authed(u, req)) return send(res, 401, 'Add ?key=YOUR_KEY to the address.', 'text/plain');
    if (u.pathname === '/' && CITY) { const gz = /gzip/.test(req.headers['accept-encoding'] || ''); res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, gz ? { 'content-encoding': 'gzip' } : {})); return res.end(gz ? CITY_GZ : CITY); }
    if (u.pathname === '/' || u.pathname === '/ops') return send(res, 200, DASH, 'text/html');
    if (req.method === 'POST' && u.pathname === '/api/watch') {
      const l = (u.searchParams.get('syms') || '').toUpperCase().split(',').map(x => x.trim()).filter((x, i, a) => /^[A-Z.]{1,6}$/.test(x) && a.indexOf(x) === i).slice(0, 8);
      if (!l.length) return send(res, 400, { error: 'need at least one symbol' });
      WATCH = l; await kset('watch', l); return send(res, 200, { watch: l });
    }
    if (req.method === 'POST' && u.pathname === '/api/stopday') {
      if (!P.rec) return send(res, 200, { ok: false, error: 'no journal yet' });
      let closed = null; if (P.rec.pos) { const r = await manualClose(); closed = r.ok ? r.bid : null; }
      P.rec.shut = 'stopped by you'; await saveRec(); return send(res, 200, { ok: true, closedAt: closed });
    }
    if (req.method === 'POST' && u.pathname === '/api/resumeday') {
      if (!P.rec || P.rec.shut !== 'stopped by you') return send(res, 200, { ok: false, error: 'not stopped by you' });
      P.rec.shut = ''; await saveRec(); setImmediate(tick); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/bt') {
      const days = Math.min(+u.searchParams.get('days') || 20, 40);
      if (!BT.run && (!BT.res || u.searchParams.get('fresh') === '1')) { BT.run = true; BT.res = null; backtest(days).then(r => { BT.res = r; }).catch(e => { BT.res = { error: String(e && e.message || e) }; }).finally(() => { BT.run = false; }); }
      return send(res, 200, BT.res || { running: true });
    }
    if (u.pathname === '/api/live') { return send(res, 200, liveData()); }
    if (u.pathname === '/api/city') return send(res, 200, await cityData((u.searchParams.get('syms') || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean)));
    if (u.pathname === '/auth') { if (!S.authUrl) await connect(); if (S.authUrl) { res.writeHead(302, { location: S.authUrl }); return res.end(); } return send(res, 200, { connected: S.connected, err: S.err }); }
    if (u.pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'POST' && u.pathname === '/api/control') { P.ctl.running = u.searchParams.get('run') === '1'; await kset('control', P.ctl); setImmediate(tick); return send(res, 200, status()); }
    if (req.method === 'POST' && u.pathname === '/api/close') return send(res, 200, await manualClose());
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) { return send(res, 500, { error: String(e && e.message || e) }); }
});

const DASH = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Scalp City Server</title>
<style>:root{--bg:#080626;--ink:#e9e9ff;--dim:#8a90d0;--g:#34ff9a;--r:#ff3d6e;--c:#38f4d8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 ui-monospace,Menlo,monospace;padding:16px}
h1{font-size:18px;letter-spacing:.1em;color:var(--c);margin:0 0 4px}.bar{padding:8px 10px;border:1px dashed var(--c);color:var(--c);font-weight:700;letter-spacing:.06em;margin:8px 0}.bar.off{border-color:var(--dim);color:var(--dim)}.bar.warn{border-color:#ffb000;color:#ffb000}
.card{border:1px solid #3a3f88;padding:10px;margin:10px 0;background:rgba(10,8,52,.8)}.big{font-size:28px;font-weight:700;margin:4px 0}.up{color:var(--g)}.dn{color:var(--r)}.dim{color:var(--dim);font-size:12px}
button{font:700 14px ui-monospace,monospace;padding:12px;border:1px solid var(--c);background:transparent;color:var(--c);width:100%;margin:6px 0}button.stop{border-color:var(--r);color:var(--r)}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:3px 4px;border-bottom:1px solid #22265f}</style></head><body>
<h1>SCALP CITY SERVER</h1><div id=bar class="bar off">LOADING</div><div id=msg class=dim></div>
<div id=pos></div><div class=card><div class=dim>TODAY (PAPER)</div><div id=pnl class=big>--</div><div id=shadow class=dim></div></div>
<button id=ctl></button><div id=login></div>
<div class=card><div class=dim>TRADES TODAY</div><table id=tr></table></div><div class=card><div class=dim>RECENT SIGNALS</div><div id=sg class=dim></div></div>
<script>
var KEY=new URLSearchParams(location.search).get('key')||'';function api(p,m){return fetch(p+(p.indexOf('?')<0?'?':'&')+'key='+encodeURIComponent(KEY),{method:m||'GET'}).then(function(r){return r.json()})}
var armed=0,s=null;function $(i){return document.getElementById(i)}function money(n){return(n<0?'-':'+')+'$'+Math.abs(n).toFixed(2)}
function t(ms){return new Date(ms).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',timeZone:'America/New_York'})}
function draw(){if(!s)return;var b=$('bar');b.textContent=s.running?'PAPER · PRETEND MONEY · RUNNING ON SERVER':'PAPER · STOPPED';b.className='bar'+(s.running?'':' off');
if(!s.robinhood.connected){b.className='bar warn';b.textContent=s.robinhood.needsLogin?'ROBINHOOD LOGIN NEEDED':'ROBINHOOD NOT CONNECTED'}
if(s.store!=='database'){b.className='bar warn';b.textContent='WARNING: NO DATABASE. LOGIN/JOURNAL LOST ON RESTART'}
$('msg').textContent=s.msg+(s.saveErr?' · '+s.saveErr:'');
var lg=$('login');lg.innerHTML='';if(!s.robinhood.connected){var a=document.createElement('button');a.textContent='CONNECT ROBINHOOD (one-time login)';a.onclick=function(){location.href='/auth?key='+encodeURIComponent(KEY)};lg.appendChild(a)}
$('pnl').textContent=s.pnl==null?'--':money(s.pnl);$('pnl').className='big '+(s.pnl>0?'up':s.pnl<0?'dn':'');
$('shadow').textContent=s.shadow?('tight-exit test (B): '+money(s.shadow.pnl)+' on '+s.shadow.closed+' closed'+(s.shadow.open?', '+s.shadow.open+' open':'')):'';
var p=s.pos,ph=$('pos');ph.innerHTML='';if(p){var has=p.bid!=null,pn=has?(p.half?p.half.pnl:0)+(p.bid-p.entryAsk)*100*((p.qty||1)-(p.half?1:0)):0,pc=has?(p.bid/p.entryAsk-1)*100:0,d=document.createElement('div');d.className='card';
d.innerHTML='<div class=dim>OPEN PAPER POSITION · '+(p.qty||1)+' contract'+((p.qty||1)>1?'s':'')+(p.half?' (1 sold, 1 riding)':'')+'</div><div><b>'+p.sym+' '+p.strike+(p.type==='call'?' CALL':' PUT')+'</b> exp '+p.exp+'</div><div class="big '+(pn>=0?'up':'dn')+'">'+(has?money(pn)+' ('+(pc>=0?'+':'')+pc.toFixed(1)+'%)':'waiting for price…')+'</div><div class=dim>bought $'+p.entryAsk.toFixed(2)+' at '+t(p.t0)+' ET'+(has?' · sell price $'+p.bid.toFixed(2)+' · best $'+p.peak.toFixed(2):'')+' · auto-exits: stop $'+p.stopPx.toFixed(2)+' / target $'+p.targetPx.toFixed(2)+'</div>';
var c=document.createElement('button');c.textContent=Date.now()-armed<5000?'TAP AGAIN TO CLOSE (PAPER)':'CLOSE THIS TRADE NOW';c.onclick=function(){if(Date.now()-armed<5000){armed=0;api('/api/close','POST').then(load)}else{armed=Date.now();draw();setTimeout(draw,5200)}};d.appendChild(c);ph.appendChild(d)}
var c=$('ctl');c.textContent=s.running?'STOP':'START PAPER TRADING';c.className=s.running?'stop':'';c.onclick=function(){api('/api/control?run='+(s.running?0:1),'POST').then(function(x){s=x;draw()})};
var tb=$('tr');tb.innerHTML='<tr><th>Time</th><th>Contract</th><th>Paid</th><th>Sold</th><th>P&L</th><th>Why</th></tr>';s.trades.slice().reverse().forEach(function(x){var r=tb.insertRow();[t(Date.parse(x.entryT))+'-'+t(Date.parse(x.exitT)),x.sym+' '+x.strike+(x.type==='call'?'C':'P'),'$'+(+x.entryAsk).toFixed(2),x.exitBid==null?'--':'$'+(+x.exitBid).toFixed(2),money(x.pnl),x.reason].forEach(function(v,i){var td=r.insertCell();td.textContent=v;if(i===4)td.className=x.pnl>0?'up':x.pnl<0?'dn':''})});
$('sg').textContent='';s.signals.slice().reverse().forEach(function(x){var l=document.createElement('div');l.textContent=t(Date.parse(x.t))+' '+x.sym+' '+(x.dir>0?'▲':'▼')+' '+x.trig+' → '+x.action+(x.why?' ('+x.why+')':'');$('sg').appendChild(l)})}
function load(){api('/api/status').then(function(x){s=x;draw()}).catch(function(){$('msg').textContent='Cannot reach the server.'})}load();setInterval(load,10000);
</script></body></html>`;

(async () => {
  await initStore();
  P.ctl = (await kget('control')) || { running: false };
  { const w = await kget('watch'); if (Array.isArray(w) && w.length) WATCH = w; }
  await connect();
  setInterval(() => { tick(); }, TICK_MS);
  setInterval(() => { fastPos(); }, FAST_MS);
  setInterval(() => { if (!S.connected && !S.connecting && !S.needsLogin) connect(); }, 60000);
  server.listen(PORT, () => console.log('listening on ' + PORT + ' paper mode, running=' + P.ctl.running));
setTimeout(async () => { try { if (await kget('bt5')) return; await kset('bt5', await backtest5(+process.env.BT2_DAYS || 365)); } catch (e) { try { await kset('bt5', { error: String(e && e.message || e) }); } catch (e2) {} } }, 100000); // ORB re-check once, saved to kv 'bt5'
setTimeout(async () => { try { if (await kget('bt4')) return; await kset('bt4', await backtest4(+process.env.BT2_DAYS || 365)); } catch (e) { try { await kset('bt4', { error: String(e && e.message || e) }); } catch (e2) {} } }, 100000); // trail-variant study once, saved to kv 'bt4'
setTimeout(async () => { try { if (await kget('bt3')) return; await kset('bt3', await backtest3(+process.env.BT2_DAYS || 365)); } catch (e) { try { await kset('bt3', { error: String(e && e.message || e) }); } catch (e2) {} } }, 120000); // payoff study once, saved to kv 'bt3'
setTimeout(async () => { try { if (BT2.run || (await kget('bt2'))) return; BT2.run = true; BT2.res = await backtest2(+process.env.BT2_DAYS || 365); await kset('bt2', BT2.res); } catch (e) { BT2.res = { error: String(e && e.message || e) }; try { await kset('bt2', BT2.res); } catch (e2) {} } finally { BT2.run = false; } }, 150000); // year-long study once, saved to kv 'bt2' (delete the key to re-run on next boot)
setTimeout(() => { if (!BT.run && !BT.res) { BT.run = true; backtest(20).then(r => { BT.res = r; return kset('bt', r); }).catch(e => { BT.res = { error: String(e && e.message || e) }; return kset('bt', BT.res); }).catch(() => {}).finally(() => { BT.run = false; }); } }, 90000); // one study per boot, saved to kv key 'bt'
})();
