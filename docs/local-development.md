# Local development

## Prerequisites and installation

Use Git, Node.js 22.13+ or 24.x, and pnpm 10.33.4 selected by Corepack. The API uses Node's built-in SQLite module; it does not need an external database server. The supported engine declaration is in [package.json](../package.json); dependency resolution is fixed by [pnpm-lock.yaml](../pnpm-lock.yaml).

```bash
git clone https://github.com/HanTirong/replenish-ai-hackathon.git
cd replenish-ai-hackathon
corepack pnpm --version
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

PowerShell setup:

```powershell
git clone https://github.com/HanTirong/replenish-ai-hackathon.git
Set-Location replenish-ai-hackathon
corepack pnpm --version
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

Expected pnpm version: `10.33.4`. If Corepack is absent, install Corepack or the pinned pnpm release using your Node distribution's supported procedure. A bare global `pnpm` can be a different version. `--offline` is an optional install variation only when the necessary packages are already cached; the normal install can download dependencies.

## Environment loading

The root [.env.example](../.env.example) is documentation, not an automatically applied configuration file. Copying it to `.env` alone does not affect `corepack pnpm api`: that script runs `tsx packages/api/src/http.ts` and does not call a dotenv loader.

Use the explicit command, from the repository root, in either shell:

```sh
node --env-file=.env --import tsx packages/api/src/http.ts
```

Node reads the root file relative to the current directory. Already exported environment variables win over values from `--env-file`. Changes require restarting the process. These rules follow [Node's CLI documentation](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html#--env-fileconfig). Node 22.13 also removed the `node:sqlite` launch-flag requirement; older Node 22 releases are not this guide's startup target.

Use a fresh shell without exported service credentials for the no-key path. In a reused shell, clear inherited settings before relying on the template. Bash examples:

```bash
unset PORT
unset DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY
unset PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_VAULT_ID
unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
```

PowerShell equivalents:

```powershell
Remove-Item Env:PORT -ErrorAction SilentlyContinue
Remove-Item Env:DEEPSEEK_API_KEY, Env:OPENAI_API_KEY, Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PAYPAL_CLIENT_ID, Env:PAYPAL_CLIENT_SECRET, Env:PAYPAL_VAULT_ID -ErrorAction SilentlyContinue
Remove-Item Env:TELEGRAM_BOT_TOKEN, Env:TELEGRAM_CHAT_ID -ErrorAction SilentlyContinue
```

These change the current shell only; they do not delete a credential from another service. Keep `PAYMENT_PROVIDER=mock` in `.env` for local offline use. Use the file's server-only names, never `VITE_` names for secrets. The repository ignores `.env`, `data/`, build output and dependency directories. Other `.env.*` filenames are not all ignored, so do not create credential-bearing variants inside the checkout.

### Local state

With no override, SQLite is `data/replenish.sqlite`; `DATA_DIR` relocates default state files. `SQLITE_PATH` explicitly selects the SQLite file. A Postgres `DATABASE_URL` selects an unimplemented adapter, even when other paths are set; leave it unset. The API and CLI use different state models: do not treat a legacy CLI household JSON file as the web database.

Use separate fresh directories for mock and Sandbox sessions. In particular, mock mode can still read a configured/saved vault reference; it is not automatic isolation from existing Sandbox state. Do not copy anyone else's database or vault to make the demo work.

## Environment variables

Defaults below describe code behavior when unset. The [.env.example](../.env.example) deliberately overrides the API host to loopback for local use. Keep all values server-side; do not put credentials in `VITE_` variables.

| Variable | Code default | Required when / purpose |
| --- | --- | --- |
| `PAYMENT_PROVIDER` | `mock` | Set `paypal` only for an intentional independent Sandbox session. |
| `API_HOST` | `0.0.0.0` | Template uses `127.0.0.1`; bind address. |
| `API_PORT` / `PORT` | `4781` / unset | `PORT` takes priority, then `API_PORT`; Vite's proxy expects 4781. |
| `DATA_DIR` | `./data` | Local SQLite and state directory; use separate directories for mock and Sandbox. |
| `SQLITE_PATH` | `DATA_DIR/replenish.sqlite` | Optional explicit SQLite path. Postgres is not implemented. |
| `REORDER_INTERVAL_MS` | `900000` | Reorder scheduler interval; `0` disables scheduled checks, including startup. |
| `PREFERRED_SKU` | `RC-SMALL-8` | Current browser default: 8kg / $72.99. |
| `REPLENISH_MAINTENANCE_TOKEN` | unset | At least 32 characters for forced checks, demo resets and recovery writes; no default access code. |
| `DEEPSEEK_API_KEY` | unset | Optional model-backed intent parsing; no key uses supported rule parsing. |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | `deepseek-flash` / `https://api.deepseek.com` | Optional intent-model configuration. |
| `LLM_TIMEOUT_MS` | `8000` | Model timeout before rule fallback. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | unset | Your own Sandbox app; needed when a PayPal operation is invoked. Health alone does not verify them. |
| `PAYPAL_ENV` / `PAYPAL_API_BASE` | `sandbox` / Sandbox REST host | Keep Sandbox settings; endpoint overrides are not a protection against live-money use. |
| `PAYPAL_VAULT_FILE` / `PAYPAL_VAULT_ID` | `DATA_DIR/paypal-vault.json` / unset | Stored method; explicit ID overrides the file. Treat actual tokens as credentials. |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | example.com placeholders | Set your own return/cancel URLs for an independent integration. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Optional owner notifications; private recipient ID and explicit opt-in required. |
| `PUBLIC_APP_URL` | `RENDER_EXTERNAL_URL`, otherwise unset | Notification link origin; HTTPS, or HTTP loopback locally. |
| `TELEGRAM_BOT_USERNAME` | unset | Optional public Bot link, without `@`. |

Provider precedence is DeepSeek, then OpenAI, then Anthropic if their keys are set. See [environment loading](#environment-loading) and the [Sandbox variables](paypal-integration.md#sandbox-environment).

## Built frontend hosted by the API

```sh
corepack pnpm build:web
node --env-file=.env --import tsx packages/api/src/http.ts
```

Open http://127.0.0.1:4781. `webRootFromHere()` points at `packages/web/dist`; the API serves that directory and falls back to its `index.html` for client-side routes. `WEB_ROOT` can override the directory. Without a build, `/v1/health` can still work while the website returns 404, so check both.

Expected read-only check, bash:

```bash
curl --fail-with-body http://127.0.0.1:4781/v1/health
```

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4781/v1/health
```

The health JSON is `{"ok":true}`. This proves the local server responds, not that PayPal or DeepSeek credentials are valid.

## Separate backend and frontend development

Start the same API command in terminal 1. In terminal 2, from the same repository root:

```sh
corepack pnpm --filter @replenish/web dev
```

Open http://localhost:43123. The Vite dev server has hot reload and a `/v1` proxy to `http://127.0.0.1:4781`. Its port is strict: an occupied 43123 is an error, not an automatic alternative. If you change the backend port, its fixed proxy target will not follow automatically. For independent Sandbox work, prefer the built UI/API on one origin so return URLs and application origin are straightforward.

`vite preview` is a preview of built static files; the current config does not add the dev server's API proxy to it. Starting the optional standalone store (`corepack pnpm store`) or MCP adapter (`corepack pnpm mcp`) is not required for the browser demo. These adapters use their own configured state and are not a live merchant connection.

## Tests and browsers

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:web
corepack pnpm exec playwright install chromium
corepack pnpm verify
```

| Command | What it checks |
| --- | --- |
| `test` | Unit/integration tests with simulated payments and external HTTP responses. Other test amounts are intentional boundary data. |
| `typecheck` | TypeScript without emitting files. |
| `build` / `build:web` | Vite production assets; `build` is an alias. |
| `verify:flows` | Local built UI, HTTP/SQLite, feeding/Undo, budget/approval, simulated payment/receipt cycles, recovery and pause/resume. |
| `verify:notifications` | Local notification controls and simulated delivery states. |
| `verify:feedback` | Pending feedback, lost responses, operation recovery and background-check visibility. |
| `verify:acceptance` | Local acceptance scenarios, including failure/latency cases. |
| `verify:mobile`, `verify:guide` | Mobile layout/input behavior and the optional tour. |
| `verify` | Typecheck → unit tests → build → all six browser checks above, stopping on failure. |

`verify` runs these checks in the order listed in `package.json`, stopping at a failure. It uses local services and simulated transports, not owner Sandbox or Telegram credentials. `verify:flows` includes simulated payment and receipt actions; those are not real PayPal captures.

To use an already installed browser instead of bundled Chromium, bash:

```bash
SCREENSHOT_BROWSER_CHANNEL=msedge corepack pnpm verify:guide
```

PowerShell:

```powershell
$env:SCREENSHOT_BROWSER_CHANNEL = 'msedge'
corepack pnpm verify:guide
```

`chrome` is another supported channel when Chrome is installed. Mobile browser emulation is not a substitute for testing a physical iPhone. Some pnpm versions verify/reinstall dependency layouts before a command; when intentionally reusing an existing local install, the existing project workaround is `corepack pnpm --config.verify-deps-before-run=false --config.update-notifier=false test`. It is not needed as an unexplained default quick-start step.

## Authenticated demo reset

Ordinary and full resets require `REPLENISH_MAINTENANCE_TOKEN` (at least 32 characters) on the server and the matching `Authorization: Bearer <operator code>` request header. Missing, incorrect or URL/body-only credentials return 403 before changing state. No token is configured by default.

Send an authenticated `POST /v1/demo/reset` to the intended local server to preserve the saved payment method, or deliberately add `?full=1` to clear it too. Both remain blocked while payment reconciliation is pending. Do not put the code in a URL or recording. The old browser `?reset=1` links do not supply this header and no longer reset data. The isolated screenshot script supplies its own freshly generated local code.

## Common setup problems

| Symptom | Check |
| --- | --- |
| `.env` changes seem ignored | Use `node --env-file=.env --import tsx ...`; check inherited shell variables and restart. |
| Health works but homepage is 404 | Run `build:web`; verify `WEB_ROOT` and the built `index.html`. |
| Vite loads but API requests fail | API must run on 4781 for the current proxy; `PORT` can override `API_PORT`. |
| SQLite import/launch error | Use the documented Node version; do not configure the Postgres stub. |
| Mock Connect does not enable automatic payment | It does not save a real token; use the explicitly simulated prerequisites in the mock guide. |
| Forced check returns 403 | Set a local maintenance code of at least 32 characters; it is not a debug-mode switch. |
| Changed meal amount asks a question | Reply with an explicit daily total/per-meal target as requested; a bare yes does not apply an ambiguous change. |

See the [full usage guide](demo-runbook.md) and [independent Sandbox setup](paypal-integration.md#independent-sandbox-setup).
