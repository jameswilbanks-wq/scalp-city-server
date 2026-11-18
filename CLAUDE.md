# Scalp City — working rules for Claude Code

Node paper-trading server (`server.js`) on Render, journal in Supabase `scalp.kv`. Paper trading only. James approves every strategy or trading-logic change.

## Read first, every session
1. `docs/PROJECT_STATE.md` (status, blockers), then `docs/DECISIONS.md`. Open the others as the task needs: `STRATEGY_REGISTRY.md`, `RISK_POLICY.md`, `EXPERIMENT_LOG.md`, `RUNBOOK.md`.
2. Supabase `scalp.kv` key `notes` (project `rmktbayxhplkuonifxfw`): newest strategy changes. It beats the docs when they disagree.
3. Facts about the world (prices, broker rules, who holds what) get looked up, not recalled.

## Hard rules
- Paper only. Never place orders on the Robinhood account or the Alpaca live account. Do not connect the Alpaca live connector in this environment.
- No strategy, entry/exit, sizing or risk-limit change without James's explicit yes. Research and backtests are read-only unless he approves otherwise.
- Never claim a test passed, a deploy is live, or an order executed without showing the evidence (command output, Render deploy status, Supabase row).
- Never put secrets in code, docs, commits, chat or Supabase. They live only in Render environment variables and local env vars. Never echo a key.
- Order validation and risk enforcement stay deterministic code. No language model is ever the sole authority for an order decision (the CDR AI overlay is shadow-log only).
- Backtests: report historical, out-of-sample, forward-paper and live results separately. Include fees and bid/ask. Record every variant tried, including failures. Dev and holdout periods stay separate. Never call hypothetical results profits.
- Report the average over all trading days. Explain plainly, separate verified facts from assumptions and unknowns.

## Deploy procedure (push to `main` = auto-deploy, ~1 min restart)
1. `node --check server.js` and run the relevant `node test/<name>.test.js` files.
2. During market hours (9:30-16:00 ET), first check no book has an open position: main `pos`, `orbk.open`, `csk.open`, `x9k.open`, `fpk.open`, `cdrk.open` in today's `rec:YYYY-MM-DD` row. Soft rule: if one is open, tell James before pushing.
3. Commit with a clear message, push to `main`.
4. Confirm the Render deploy reached `status: live` (service `srv-dbov0erl550s73avgqp0`, workspace `tea-d9s84elbedkc73d2q9ig`).
5. Add an item to the Supabase `notes` key after any strategy or code change, and update the relevant `docs/` files in the same commit.
- A docs-only push to `main` also redeploys and restarts the server. Batch doc updates with code changes or push them outside market hours, unless Render's ignored-paths setting excludes `docs/`.
- Render env-var changes (`update_environment_variables`) need `workspaceId` and also restart the server. There is no tool to read current values, so set values explicitly rather than trusting code defaults.

## Records (`docs/`)
Keep these current after meaningful changes: PROJECT_STATE, DECISIONS, STRATEGY_REGISTRY, RISK_POLICY, EXPERIMENT_LOG, RUNBOOK. Edit in place, dated entries. If a note exists only in Supabase or only in a doc, fix that.

## Pointers
- Saved studies live in `scalp.kv` as `bt*` keys; study harnesses are `study_*.js`, run server-side after boot and saved once.
- Tests are plain Node scripts: `node test/<name>.test.js`.
- Known gap: no broker-resident stop exists for options at Alpaca, so stops exist only while the Render process runs (see `docs/RISK_POLICY.md`).
