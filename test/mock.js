// fake Robinhood MCP server (no auth) with a synthetic market
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const MODE = process.env.MODE || 'trend';
const priceAt = ms => { const m = ms / 60000; let b = 665 + 1.2 * Math.sin(m / 37) + .9 * Math.sin(m / 11);
  if (MODE === 'trend') { const mins = (ms % 864e5) / 60000; if (mins > 14 * 60 + 30 + 75) b += (mins - (14 * 60 + 30 + 75)) * .35; } return b; };
const J = d => ({ content: [{ type: 'text', text: JSON.stringify({ data: d }) }] });
function mk() {
  const s = new McpServer({ name: 'mock', version: '1' });
  s.tool('get_equity_historicals', { symbols: z.array(z.string()), start_time: z.string(), end_time: z.string().optional(), interval: z.string().optional(), bounds: z.string().optional() }, async (i) => {
    const a = Date.parse(i.start_time), b = Date.parse(i.end_time || new Date().toISOString()), out = [];
    for (let t = Math.ceil(a / 60000) * 60000; t < b; t += 60000) { const dt = new Date(t), dow = dt.getUTCDay(), mm = dt.getUTCHours() * 60 + dt.getUTCMinutes();
      if (dow === 0 || dow === 6 || mm < 14 * 60 + 30 || mm >= 21 * 60) continue; const o = priceAt(t), c = priceAt(t + 60000);
      out.push({ begins_at: dt.toISOString(), open_price: o.toFixed(2), close_price: c.toFixed(2), high_price: (Math.max(o, c) + .05).toFixed(2), low_price: (Math.min(o, c) - .05).toFixed(2), volume: 100000 }); }
    return J({ results: i.symbols.map(sy => ({ symbol: sy, bars: out })) }); });
  s.tool('get_option_chains', { underlying_symbol: z.string() }, async i => J({ chains: [{ id: 'chain1', symbol: i.underlying_symbol, can_open_position: true, settle_on_open: false, expiration_dates: ['2026-11-10', '2026-11-11', '2026-11-12'] }] }));
  s.tool('get_option_instruments', { chain_id: z.string(), expiration_dates: z.string(), type: z.string(), cursor: z.string().optional() }, async i => {
    const out = []; for (let k = 650; k <= 680; k++) out.push({ id: i.type + '|' + k, strike_price: k + '.0000', type: i.type, state: 'active', tradability: 'tradable' }); return J({ instruments: out, next: '' }); });
  s.tool('get_option_quotes', { instrument_ids: z.array(z.string()) }, async i => J({ results: i.instrument_ids.map(id => { const [ty, k] = id.split('|'); const u = priceAt(Date.now()), sg = ty === 'call' ? 1 : -1;
    const m = Math.max(.05, 1.2 + .5 * (sg * (u - 665)) - .1 * Math.abs(+k - 665)); return { quote: { instrument_id: id, ask_price: (m + .02).toFixed(2), bid_price: (m - .02).toFixed(2), implied_volatility: '0.3', delta: '0.4', updated_at: new Date().toISOString() } }; }) }));
  return s;
}
http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const s = mk(), t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); res.on('close', () => { t.close(); s.close(); });
    await s.connect(t); await t.handleRequest(req, res, JSON.parse(body || '{}')); });
}).listen(+process.env.MOCK_PORT || 4010, () => console.log('mock up'));
