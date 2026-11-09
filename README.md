# Scalp City server (paper trading)

Always-on server version of the Scalp City bot. PAPER ONLY: the only Robinhood tools it can call are read-only
(see READ_ONLY in server.js); it contains no code that places, cancels or changes an order.

Env vars: DATABASE_URL (Postgres, keeps login + journal), PUBLIC_URL (this service's https address),
ADMIN_KEY (secret for the dashboard), ACCOUNT_NUMBER, SYMBOLS, MAX_PREM, DTE, DAILY_TARGET, DAILY_LOSS.

Dashboard: https://YOUR-SERVICE.onrender.com/?key=ADMIN_KEY
One-time login: tap "CONNECT ROBINHOOD" on the dashboard.
Local test: node test/mock.js (fake Robinhood) with `node -r ./test/fakedate.js server.js`.
