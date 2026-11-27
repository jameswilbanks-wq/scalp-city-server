# RUNBOOK.md — Scalp City

Last updated: 2026-11-14 (copied into the repo 2026-11-18; sections that still describe the chat-based setup need updating, see "Moving to Claude Code" below).

Startup, monitoring, shutdown, recovery, deployment, and how to pick this project up in a brand-new chat. Strategy specs are in STRATEGY_REGISTRY.md; limits are in RISK_POLICY.md; status/blockers are in PROJECT_STATE.md.

## Moving to Claude Code (2026-11-18)

James is moving code and deployment work from chat to Claude Code, with this repo's `docs/` folder as the home of the records and `CLAUDE.md` in the repo root holding the standing rules. Sections below that mention "the primary/build chat", cloning the repo via `add_repo`, or reading these files from the claude.ai Project are out of date once that move is done and should be rewritten to point at the repo. The morning-review scheduled task (prompt backup at `claude/morning-review-prompt.md` in the Project) also reads the Project docs and needs repointing. Keep one copy of each record as the source of truth.

## Two kinds of chat for this project — know which one you're in

This project gets worked on from two structurally different kinds of session, and it matters which one you're using:

- **A regular claude.ai chat (web/app).** Can read and write the Project's docs, browse the web, and watch/transcribe videos. **Cannot** touch code, clone the repo, run anything, or deploy — those tools simply don't exist in this kind of session, no matter what any project doc says. Use this kind of chat for: watching a strategy video and drafting a spec doc, general research, discussing results. A session like this correctly says "the build has to happen wherever the repo is open" when asked to build something — that's accurate, not a missed step.
- **A Claude Code / cloud agent session** (this file is maintained from one). Has a shell, file tools, GitHub access, and the Alpaca/Render/Supabase connectors. This is where code actually gets written, tested, committed, and deployed, and where studies get read back out of Supabase.

**James's convention (set 2026-11-14): one session is the designated "primary"/build chat.** Its reference link is `https://claude.ai/code/session_01BRtGLGbiUfLUyz1kJMdZDJ`. Any Claude Code / cloud agent session can technically do the repo/deploy work (there's nothing special in the code itself that requires this exact session), but keeping one designated place for it avoids split context and makes "where did we leave off" unambiguous. Route anything that needs to touch the repo, Render, or Supabase there; use other chats (regular claude.ai included) for video-watching, research, and drafting proposals, then bring the resulting spec doc back to be built.

## Infrastructure map

| Piece | What it is | Where |
|---|---|---|
| Server bot | Node service, paper-trades all day, no browser open | Render service `scalp-city-server` (id `srv-dbov0erl550s73avgqp0`, workspace `tea-d9s84elbedkc73d2q9ig`), https://scalp-city-server.onrender.com |
| Code | Private GitHub repo, auto-deploys to Render on every push to `main` (~1 min restart via GitHub webhook — no manual trigger needed) | `jameswilbanks-wq/scalp-city-server` — `server.js`, `engine.js`, `ai_overlay.js`, `orb15.js`, `study_*.js`, `public/city.html`, `test/*.test.js` |
| Journal and studies | Supabase table `scalp.kv` (`key`, `value` jsonb, `updated`) | Supabase project `rmktbayxhplkuonifxfw` |
| Dashboard ("the Board") | 3D page: all live books, open positions, closed trades, both leaderboards, scorecard | https://claude.ai/artifact/3YNxWLSEHZBpK7WUtgLuXM |
| Market data | Free Alpaca feed: 1-min stock bars, "indicative" option quotes, historical 1-min option bars back to Mar 2024 | Render env vars `ALPACA_KEY_ID`/`ALPACA_SECRET` (rotated Nov 12) |
| Sweep real orders | Paper-account order placement (STRATEGY_REGISTRY.md) | Same Alpaca key, hardcoded to `paper-api.alpaca.markets` |
| Wheel2 real orders | Paper-account order placement, currently off | Separate env vars `WHEEL2_ALPACA_KEY_ID`/`WHEEL2_ALPACA_SECRET`, hardcoded to `paper-api.alpaca.markets` |
| AI overlay (CDR, shadow-log only) | Advisory-only AI decision layer, logged not acted on (see below) | `Anthropic` API, env `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, **armed as of 2026-11-14** (`AI_OVERLAY_ON=1`, key set) — unconfirmed in practice, see PROJECT_STATE.md |
| Morning review | Scheduled task, weekdays 5:34 AM CT, doc-sync then analyze-and-suggest. Prompt reads the six project docs instead of inlining strategy detail | trigger id `trig_01C3S3Z52MhPQLYqkfz5jmm4`; prompt backed up at `claude/morning-review-prompt.md` in the Project |
| Robinhood | Account "BOT Trading" (ends 7817), limited margin, options level 3 — read-only (feeds the real-money leaderboards). The server itself reads Robinhood minute bars for ORB signals | `Robinhood` connector |
| Alpaca (chat connectors) | Direct paper + unfunded live account access | `Alpaca_Paper_Trading`, `Alpaca_Live_MCP` connectors (do not connect the live one in Claude Code) |
| Supabase (chat connector) | Direct SQL on the journal/study table | `Supabase` connector, project `rmktbayxhplkuonifxfw` |
| Render (chat connector) | Deploys, logs, env vars | `Render` connector, workspace `tea-d9s84elbedkc73d2q9ig` |
| Web research | Broker docs, strategy source material | `Firecrawl` / `WebSearch`/`WebFetch` |

Why Alpaca and not Robinhood for the server's option data: Robinhood rejected the server's login for options quotes. Paper fills (other than the real-order pilots) use Alpaca quotes and are probably a little better than real fills would be. Note: ORB's signal bars come from Robinhood minute bars while backtests use Alpaca IEX bars, so a candle can break out on one feed and not the other.

## Known gap: no broker-resident stop for options (confirmed 2026-11-14)

Checked Alpaca's own docs directly (`options-trading-overview`, `orders-at-alpaca`): Alpaca's options order support is **market and limit orders only** — no bracket, OTO, OCO, stop, or trailing-stop order type exists for options, single-leg or multi-leg. This was investigated as a way to give sweep's real-order pilot a broker-side floor (so a Render outage wouldn't leave an open position unmanaged) — it is not possible to build at Alpaca today. Sweep's wick/trailing stop (and every other book's stop) exists only inside the running Node process; if Render goes down or loses its connection, an open position has no stop until the app or a human reconnects. Not fixed. Options considered but not yet decided (see DECISIONS.md unresolved questions): a separate external watchdog process, tighter outage alerting, or accepting this as a documented operational risk. Re-check Alpaca's docs periodically in case they add options stop-order support.

## AI trade-management overlay (added 2026-11-14, armed same day, CDR only, shadow-log only)

`ai_overlay.js` is a Node port of a Python prototype James supplied (`ai_trade_overlay.py`, saved in the Project at `claude/ai_trade_overlay.py`). It calls Claude as an advisory layer for a position/candidate, and is built so it **cannot** be the sole order authority, per this project's own standing rule:

- `entries_allowed`, `risk_budget_usd`, and `base_exit` are computed by `server.js`'s own existing deterministic logic and handed to the model as inputs — the model never computes or overrides these itself.
- `base_exit: true` always wins; the model is never consulted on whether a mandatory exit should happen.
- The model can only approve or reject a pre-built candidate (exact legs/strikes/qty/risk) — it cannot invent one or resize it.
- Any staleness (quote, snapshot, evidence), timeout, schema mismatch, invented-evidence citation, or audit-logging failure fails safe to `DEFER` ("no AI override") — never to a default of acting.
- `test/ai_overlay.test.js` checks these properties (7/7 passing) without needing a live API key.

**Current scope, by James's explicit choice (2026-11-14): CDR only, shadow-log only.** The overlay's decision on each CDR entry candidate (once per symbol per day) and each open CDR position (throttled to about once per 60 seconds) is appended to `rec.cdrk.aiShadow` (capped at 100, last 20 surfaced in `/api/city` as `cdr.aiShadow`) — it is never read by any code path that places, blocks, or closes a trade. Call sites are fire-and-forget (not awaited in the main tick), so a slow or failing API call can't delay CSK/X9/FP/ORB/sweep processing.

**Status as of 2026-11-14: fully armed.** James added `ANTHROPIC_API_KEY` as a Render secret and set `AI_OVERLAY_ON=1`, both deploys confirmed `status: live`. However, no CDR shadow decision has actually fired or been confirmed working yet — CDR itself only runs during regular trading hours and has fired zero trades. Check: Render logs for `aiOverlayErr` (set if the key is missing/rejected), and `cdrk.aiShadow` in the day's Supabase `rec:YYYY-MM-DD` row for actual logged decisions.

Before extending this beyond CDR or giving it any real effect (even in paper), this needs the same validation discipline as any other strategy change here: enough shadow decisions to judge against CDR's own deterministic calls, not a vibe check after a handful.

## "Levels family" signal studies — video-sourced, cross-session workflow (added 2026-11-14)

Two strategies so far have arrived via the two-chat pattern described above: a regular claude.ai chat watches a YouTube video and drafts a critically-reviewable spec doc, then a build session reads it, questions it, and builds Stage 0 if approved.

- **IB / "Levels"** (`study_ib.js`, kv `bt24`): Failed-Auction/Trend-Continuation off the 9:30-10:30 Initial Balance. Built, run, and **failed** its pre-registered pass criteria (2026-11-14). Dormant. See STRATEGY_REGISTRY.md and EXPERIMENT_LOG.md.
- **BRT / "Break & Retest of Critical Levels"** (`claude/brt-strategy-spec.md` in the Project): proposal only, not built. Still pending whether to build `study_brt.js`/`bt25` at all, and three ambiguous transcript-interpretation calls. See DECISIONS.md and STRATEGY_REGISTRY.md.

## Supabase keys in `scalp.kv`

| Key | Holds |
|---|---|
| `rec:YYYY-MM-DD` | One trading day (NY date): `trades[]`, `signals[]`, `pnl`, `pos` (open main trade), `sh` (shadow test), `orbk`, `csk`, `x9k`, `fpk`, `cdrk` (incl. `aiShadow[]`, see above) |
| `control` | `{running}` on/off switch |
| `notes` | Strategy and code changes since the review prompt was last rewritten — morning review reads this first. Newest item last. Current through 2026-11-18 (ORB15 detection fix) |
| `vt` | Forward tracker: every raw sweep/EMA signal with hypothetical exits, traded or not |
| `bt` through `bt26`, `probe` | Saved study results — see EXPERIMENT_LOG.md |
| `watch` | Extra tickers shown on the page (IWM removed Nov 13) |
| `wheel_account_check`, `wheel2_account_check` | Read-only boot checks for the two wheel-research Alpaca accounts |
| `wheel2_csp` | Wheel2 CSP book's own trade/position state |
| `wheel2_csp_dryrun` | Wheel2 CSP's daily decision log while `WHEEL2_CSP_ON=0` |
| `oauth_client`, `oauth_verifier` | Leftover from the Robinhood login attempt |

## Server settings (Render environment variables)

Secrets (values not recorded here): `ALPACA_KEY_ID`, `ALPACA_SECRET`, `WHEEL_ALPACA_KEY_ID`, `WHEEL_ALPACA_SECRET`, `WHEEL2_ALPACA_KEY_ID`, `WHEEL2_ALPACA_SECRET`, `DATABASE_URL`, `ADMIN_KEY`, `ANTHROPIC_API_KEY`.

| Setting | Current | Meaning |
|---|---|---|
| `DTE` | 0 | Same-day expiry |
| `QTY` | 1 | Contracts per main trade |
| `TRIGGERS` | `sweep` (set explicitly 2026-11-13 — do not trust the code's hardcoded default of `sweep,ema`) | Main-book entry signals |
| `EXCLUDE_SYMS` | `IWM` (set explicitly 2026-11-13 — same caveat, don't trust the code default) | Symbols never traded (main, X9, ORB — anything falling back to `CFG.syms`) |
| `EMA_FILTER` | on | Moot while EMA is paused |
| `SWEEP_RUN` | on | Sweep uses wick stop + trailing stop |
| `SWEEP_REAL_ORDERS` | on | Sweep places real paper orders (market/limit only — see "Known gap" above) |
| `ORB_ON`, `ORB_MODE`, `ORB_R`, `ORB_BE` | on, 15, 1.25, 0.5 | ORB book config |
| `CSK_ON` | on | Call-spread book |
| `CSK_SYMS`, `CSK_PCT`, `CSK_WIDTH`, `CSK_MIN` | SPY,QQQ / 0.0045 / 2 / 660 | CSK config |
| `CSK_STOP` | 3 | 3x-credit buy-back stop |
| `X9_ON` | on | X9 book |
| `X9_SYMS`, `X9_STOP`, `X9_TF`, `X9_TRAIL_ARM`, `X9_TRAIL_GIVE` | `CFG.syms` / 30 / 5 / 25 / 0.5 | X9 config |
| `X9_TP_SYMS`, `X9_TP_PCT` | QQQ / 70 | X9's per-symbol take-profit exit (added Nov 13) |
| `FP_ON` | **off (`0`) since 2026-11-18** | FP book retired; open positions still exit normally |
| `CDR_ON` | on | CDR book |
| `CDR_SYMS`, `CDR_FEE`, `CDR_TRADE_MAX`, `CDR_DAILY_MAX`, `CDR_TRADE_STOP`, `CDR_DAILY_STOP` | SPY,QQQ / 20 / 200 / 400 / 140 / 280 | CDR risk budget |
| `CORR_GROUPS` | `SPY,QQQ` — set explicitly 2026-11-14 | Symbols treated as one correlated bucket for the cross-book exposure cap |
| `CORR_CAP_USD` | `500` — confirmed by James and set explicitly 2026-11-14 | Combined open-risk cap in dollars across all books for symbols in `CORR_GROUPS`; `0` disables |
| `AI_OVERLAY_ON` | on (`1`), set 2026-11-14 | Turns on CDR shadow-logging via `ai_overlay.js`. Requires `ANTHROPIC_API_KEY`; first real call unconfirmed |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` (code default, not yet set explicitly) | Model used by the AI overlay |
| `WHEEL_ON` | off | First wheel account — read-only, no logic uses this |
| `WHEEL2_CSP_ON` | **off** | Required =1 for Wheel2 CSP to place real orders |
| `WHEEL2_CSP_SYM`, `WHEEL2_CSP_OTM`, `WHEEL2_CSP_WIDTH`, `WHEEL2_CSP_QTY` | QQQ / 0.02 / 0.01 / 1 | Wheel2 CSP config |
| `ENFORCE_LIMITS` | off | `1` restores daily caps (see RISK_POLICY.md) |
| `DOLLAR_EXITS` | on | Moot while EMA is paused |
| `CHOP_MAX` | 0 (off) | Chop-skip gate (see STRATEGY_REGISTRY.md day-type idea) |
| `EXT_SYMBOLS`, `EXT_PRE`, `EXT_POST`, `EXT_MAXPREM` | NVDA, AAPL | Extended-hours scanning — never produced a trade |
| `VT_EXTRA` | `IWM` | Signal-only tracking (separate from the trading exclusion) |
| `BT2_DAYS` | 365 | History window for server-side studies |

**Important Render MCP constraint:** `update_environment_variables` requires `workspaceId` (`tea-d9s84elbedkc73d2q9ig`) explicitly or it fails. There is **no tool to read current env var values directly** — only to set/merge them. When in doubt about current live config, set the value explicitly rather than trusting the code's hardcoded default (this caused two separate issues on Nov 13 before `TRIGGERS`/`EXCLUDE_SYMS` were set explicitly).

## Deployment / change procedure

1. Edit code, `node --check server.js` and run the relevant `node test/<name>.test.js` files before committing.
2. Check for open positions across every book before pushing during market hours: main `pos`, `orbk.open`, `csk.open`, `x9k.open`, `fpk.open`, `cdrk.open` in the current day's `rec:YYYY-MM-DD` row. Soft preference, not absolute — but check first.
3. Commit, push to `main`. Auto-deploys via GitHub webhook (~1 min restart). Open trades are saved/picked back up, but go unmanaged during the restart window. A docs-only push also restarts the server.
4. For a config-only change, use `mcp__Render__update_environment_variables` with the explicit workspace id — this also restarts the server.
5. Confirm the deploy reached `status: live` via `mcp__Render__list_deploys` before telling James it's done.
6. **Add an item to the Supabase `notes` key after any strategy or code change** — this is what keeps the morning review (and any new session) from going stale. This slipped for the Nov 13 changes until caught up Nov 14; don't let it happen again.

## Monitoring / recovery

- The cloud workspace used by chats cannot reach Alpaca or the Render site directly except through allowlisted package managers. The server itself has its own network path and works fine.
- Studies run server-side on a delay after boot (a `setTimeout` per study) and save once to Supabase — they don't need to be re-triggered manually, just allow a few minutes after a deploy that includes a new study.
- A Render redeploy mid-fill on the sweep real-order pilot is restart-safe: pending order IDs are persisted in the Supabase journal and re-polled on the next tick.
- **A Render outage or lost Alpaca connection is NOT restart-safe for risk management** — see "Known gap" above.
- Render free/low-memory instances have crash-looped on out-of-memory before (2026-11-13, restart about every 7 minutes until about 9:30 AM CT). Missed signals that day are consistent with this but unproven.

## Security (standing rule, repeated here because it's operational)

Never echo pasted Alpaca/Anthropic API keys or secrets in plaintext anywhere in chat. Never write them anywhere outside Render secret environment variables — not in code, not in any doc, not in Supabase.

## How to pick this project up in a brand-new session

1. Read `CLAUDE.md`, then `docs/PROJECT_STATE.md`, then skim `docs/DECISIONS.md` and the others as the task needs.
2. Check the Supabase `notes` key for anything newer than a doc's "last updated" date — `notes` is the most current source for recent changes.
3. Check today's journal: `SELECT value FROM scalp.kv WHERE key = 'rec:YYYY-MM-DD'` (NY date), project `rmktbayxhplkuonifxfw`.
4. Confirm no open positions before pushing any code/config change during market hours.
5. After any change, update the relevant file(s) in `docs/` AND add a `notes` entry in Supabase — both, not just one.

## Health logging (added 2026-11-19, observability only)

`server.js` writes one JSON log line per minute (`"tag":"heartbeat"`) plus `boot`, `new_day`, `status` (on change) and `tick_skipped_busy` lines. Search Render logs for `heartbeat`. Fields: `stage` and `busyS` (where a stuck tick is), `lastTickAgoS` (null = loop never ran), `bookErr` (per-book error text), `scanBars` (bars per ticker), `open` (open positions per book). A repeated `status` line containing `alpaca 401` means the Alpaca data keys in Render env (`ALPACA_KEY_ID`/`ALPACA_SECRET`) are invalid, as happened 2026-11-19 after the keys were regenerated. No trading logic changed; test: `node test/health_log.test.js`.

**Per-book scan state and dashboard status (added 2026-11-19, read-only diagnostics).** The heartbeat now carries `books`: for orb/csk/x9/fp/cdr the state (`in window`, `outside window`, `market closed`, `off`, `shut:<why>`, `halted today`), the window in ET minutes, symbols done today, open/closed counts, plus signal counts by action and the last signal. Every `logSignal` also writes a `tag:"signal"` log line (taken or skipped, with the reason). The city page status pill shows `SERVER DATA ERROR · <error>` when a tick fails, `SERVER NOT SCANNING` when the last check is over 90 s old during market hours, otherwise `SERVER · PAPER RUNNING · SCANNED Ns AGO`; hover the pill for per-book state. Data comes from `health` in `/api/city`. `bookDiag()` mirrors each book's window constants and decides nothing; if a window changes, update it too.

**Quote-age logging (added 2026-11-19).** When `pickContract` finds no usable option quote it writes a `tag:"quote_check"` log line: candidates tried, how many had no quote, how many were stale and the min/median/max age in seconds, and the result (`stale` or `no live quotes`). Logging only: the 120 s stale limit and the returned reason text are unchanged. Background: on 2026-11-19 both ORB15 signals (SPY, QQQ at 10:15 ET) were skipped with "option quotes are stale"; the server reads option quotes from Alpaca's `indicative` feed (`feed: 'indicative'` in `alpacaTool`), and James reports the account has an options subscription, so switching to `opra` is an open decision (not made).

**Quote sampler and wider skip logging (added 2026-11-19, logging only).** Once a minute while the market is open the server logs `tag:"quote_sample"`: for SPY and QQQ, the quote age (seconds) and spread of the 3 nearest-the-money calls and puts, using the same chain/expiry/quote calls as `pickContract`. `tag:"quote_check"` is now written on every `pickContract` skip that finds no contract (stale, no quote, or filtered by premium/spread) with counts and the stale-age min/median/max, and by the call-spread book when its own stale check skips. Neither touches the journal or any decision; stale limits (120 s, 180 s for call spreads) and reason texts are unchanged. Purpose: find out why both ORB15 signals on 2026-11-19 were skipped as "option quotes are stale".

**Triple RSI dry-run cron (added 2026-11-19).** Render cron `triple-rsi-dryrun` (Python runtime, build `pip install -r requirements-triple-rsi.txt`, start `python -m execution.triple_rsi_paper --once`, weekdays after the close). Read its output in the job's Render logs (`decisions`, `action`, `result: dry_run`). It has no env vars and no broker access by design. Ephemeral disk: nothing persists between runs.

**ORBN book (added 2026-11-19).** Env `ORBN_ON` (on unless `0`), `ORBN_MAXPREM` (150). Today's trades: `rec:YYYY-MM-DD` key `orbnk` (`open`, `trades`, `pnl`, `done`). Errors show in the heartbeat `bookErr.orbn`. Open-position check before a push now also includes `orbnk.open`.

**SWEEPX (Sweep improvement pack, added 2026-11-20).** Env: `SWEEPX_ON` (master; `0` = original behavior), per-piece `SWEEPX_LIMIT`, `SWEEPX_SPREAD`, `SWEEPX_TIME`, `SWEEPX_LEVEL`, `SWEEPX_RVOL` (`0` turns that piece off), numbers `SWEEPX_MAXSPREAD` (0.03), `SWEEPX_RVOL_MIN` (1.5), `SWEEPX_LIMIT_MS` (30000). Read it in the day's `rec:YYYY-MM-DD` key `sweepx` (one object per sweep signal: `action` entered/blocked/no_contract, `blocks`, `rvol`, `keyHit`, `keys`, `spread`, `tmin`, `fill`, `limitPx`, `fillPx`). Signal-log lines `sweepx blocked [...]` and `sweep limit entry ... not filled` appear in the day's `signals`. Env changes restart the server (set values explicitly). Trade rows from 2026-11-20 carry `strategyVersion: sweep-run-2`.

**CSK2 env (2026-11-20):** `CSK2_ON` (default on; `0` disables the second slot), `CSK2_MIN` (default 750 = 12:30 ET). Render env changes restart the server; set values explicitly.

## CSK real order path (paper) — env switches
`CSK_REAL_ON=1` enables real multi-leg orders on the Alpaca PAPER account (default off; unset or any other value = off). `CSK_REAL_QTY` lots per spread (default 1, hard max 5; raise only with James's yes, per the sizing ladder). `CSK_REAL_DAYLIMIT` daily real-loss halt in dollars (default 540). Status: `/` callSpreads.real (halted, haltWhy, dayLoss, per-spread state). Kill switch: set `CSK_REAL_ON=0` (restarts the server); open real positions are then NOT managed by the server, so check Alpaca paper positions by hand. A reconciliation halt (two consecutive mismatches between our record and Alpaca) blocks new real orders for the rest of that day. Orders only go out during market hours; sending off-hours queues them to the next open.

## 2026-11-24 — Manual close of any open server paper position
Added at James's request ("when there is a orb, or x9 or csk open order there isn't a way to manually close out the trade in scalp city. can you add this feature to all orders"). On the web page (`/?key=...`), every open ORB, ORBN, CSK, X9, FP and CDR position has a **Close** button in the server table (two taps within 5 s: the first arms it, the second sends it), and the rotating ACTIVE TRADE card's EXIT TRADE NOW button now works for any of those books (CSK is only in the table). The main Sweep position keeps its own button. Endpoint: `POST /api/closebook?book=orb|orbn|csk|x9|fp|cdr&sym=SPY&t0=<entry ms>&key=...` (behind the same key as the other endpoints; refused when the market is closed).
How it works: the server flags the position (`manual: true`) and the book's own manage function books the close on the current quote, so the journal row, P&L fields and the CSK real-mirror exit are the normal ones; reason is `manual` (ORB/ORBN/X9/FP) or `manual close` (CSK, CDR). A stale quote does not block a manual close. With no quote at all the close is queued and fires on the next price (the flag survives a restart). It takes the same lock as the 20-second tick, so a position cannot be closed twice. Prices: options books sell at the bid, CSK buys back at the natural (short ask minus long bid), CDR pays the current debit (falls back to the last known debit, never to the full wing width). For CSK with real orders on, the real spread exits on the normal ladder from that natural debit, exactly like a stop. Paper only; nothing here can reach the Robinhood or Alpaca live accounts.

## 2026-11-24 — PAPER / REAL toggle
On the web page, the PAPER | REAL switch is at the top next to SCALP CITY (it remembers your choice in the browser). REAL opens a separate red page showing why it is not connected and the readiness list. It cannot place orders; there is no real-account code in this version. To go back, tap PAPER on the Real page.

## 2026-11-24 — On-demand order book (`mank`)
City page panel "ON-DEMAND 0DTE (PAPER)", `POST /api/ondemand?sym=&side=call|put&qty=1..3` (behind the key). Journal list `rec:YYYY-MM-DD` -> `mank` (`open`, `trades`, `pnl`); signals log as trig `manual`. Close via the Close button (`/api/closebook?book=man`) or automatically at 15:59 ET. Add `mank.open` to the open-position check before a market-hours deploy (the heartbeat open map now includes `mank`). Env: `MAN_ON` (0 = off), `MAN_MAXPREM` (default 400), `MAN_STOP` (default 0 = no stop).

## 2026-11-24 — Pause / resume books, on-demand env
Paused via Render env (restarts the server): `X9_ON=0`, `ORB_ON=0`, `ORBN_ON=0`. Resume: set to `1`. On-demand: `MAN_MAXPREM` (index, 400), `MAN_MAXPREM_STK` (stocks, 800), `MAN_MAXCOST` (per order, 1200), `MAN_STOP` (0 = none), `MAN_ON`.

## 2026-11-24 — Reading the 15:40 measurement
In `rec:YYYY-MM-DD` -> `cskreal.list[]`: `pc` (taken once per spread at the 15:40 look), next to `state`, `exitReason`, `realPnl`, `verified`. `wouldClose: true` means the pre-close sent a buyback; `closeNat` is the natural buyback price at that moment.

## 2026-11-25 — Guardrails switch (pending push)
`POST /api/manguard?on=1|0` (behind the key; the page button calls it). State in kv key `man_guard` `{on, at}`; no key = ON. Page data field `mg` `{on, loss, gain}`. Env: `MAN_GUARD_LOSS` (25), `MAN_GUARD_GAIN` (100); `MAN_STOP` no longer exists. Trade reasons: `guard stop`, `guard target`, `manual`, `time`.

## 2026-11-25 — CSK per-day switch (pending push)
`POST /api/cskday?on=1|0` (behind the key; the page button calls it) sets `rec.cskOff` on today's record (`on=0` -> OFF). Page data field `cd` `{on, master}` (`master` is the `CSK_ON` env). OFF stops new CSK auto entries today only (open spreads still managed); every NEW trading day starts OFF (`newRec` sets `cskOff: true`, James 2026-11-27) and the flag lives on the day's row, so a restart the same day keeps your choice. To check: the `csk_day` log line, or `value->'cskOff'` in `rec:YYYY-MM-DD`. To turn CSK off for good use the `CSK_ON=0` env var (restarts the server).

## 2026-11-27 — Trade Deck pages and the son's access (pending push)
- `/?key=ADMIN_KEY` = Trade Deck for James. `/city?key=ADMIN_KEY` = the old 3D page. `/ops` = server dashboard. `/son?key=SON_KEY` = the son's deck (James's own key also opens it).
- **To give the son access:** in Render, set env var `SON_KEY` to a different long random value (James does this; it restarts the server). Send him `https://<service>/son?key=<SON_KEY>`. To cut his access, change or remove `SON_KEY`. His key cannot open anything but `/son` and `/api/son/*`.
- His data: `rec:YYYY-MM-DD` -> `sonk` (`open`, `trades`, `pnl`), `sonShut`; guardrails in kv `son_guard`. To check: `select value->'sonk' from scalp.kv where key='rec:YYYY-MM-DD'`. His trades are not in `mank` or any strategy book.
- CSK now starts OFF on every new day row (`cskOff: true`). Turn it on from the deck's CSK switch each day you want CSK entries. Check: `value->'cskOff'` in the day row.
- **Pre-push open-position check now also includes `sonk.open`** (the son's simulated positions; a restart leaves them unwatched for about a minute like every other book). The heartbeat log line `open` carries `sonk`. CLAUDE.md's list (main `pos`, `orbk`, `orbnk`, `csk`, `x9k`, `fpk`, `cdrk`, `mank`) should gain `sonk`; that file is James's to change.
- Deploy check for these pages: `node test/son_book.test.js`, `node test/deck_page.test.js`, plus the older `ondemand`, `manual_close`, `signal_board`, `csk_day_switch` tests.
- 2026-11-27: both decks end with a month calendar (manual book on `/`, his own book on `/son`). It is drawn from `/api/deck/history` and `/api/son/history`; nothing to configure. Test: `node test/deck_calendar.test.js`.
