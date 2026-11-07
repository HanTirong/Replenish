<div align="center">
  <img src="docs/images/logo.png" width="500" alt="Replenish">
</div>

<p align="center">
  <a href="https://replenish-ai-eze1.onrender.com/">Live demo</a>
  |
  <a href="https://www.youtube.com/watch?v=6BOedfIEZoA">Demo video</a>
</p>

<div align="center">
<table>
  <tr>
    <td valign="top" width="240">
      <strong>Food forecast</strong><br>
      <img src="docs/images/home.png" width="240" alt="Home screen: about 8 days of food left and a Nov 6 reorder">
    </td>
    <td valign="top" width="240">
      <strong>Feeding update</strong><br>
      <img src="docs/images/feeding-update.png" width="240" alt="Feeding change saved: 75g to 65g per meal, 150g to 130g per day, reorder Nov 7, with Undo">
    </td>
    <td valign="top" width="240">
      <strong>Order approval</strong><br>
      <img src="docs/images/approval.png" width="240" alt="Approval screen: unpaid 8kg order for 72.99 USD, 22.99 USD over the 50 USD limit">
    </td>
  </tr>
</table>
</div>

Replenish is an AI-assisted pet-food agent that turns feeding changes into inventory forecasts, replenishment decisions and budget-controlled PayPal Sandbox payments.

Payments use PayPal Sandbox only. The store, stock, and delivery are simulated, and stock is estimated rather than sensor-measured.

These are feature states, not a completed automatic payment. The video shows a completed Sandbox test transaction. The hosted demo is one shared household, so its state can change.

## How it works

From Qizai's two 75g meals per day, send **“Feed him 10g less per meal from now on”**: the saved result is **65g per meal / 130g per day**, with a recalculated forecast and Undo.

```mermaid
flowchart TD
    F[Feeding instruction] --> I[Parse intent and validate]
    I --> P[Deterministic stock and date forecast]
    P --> D{Order due?}
    D -->|No| W[Wait for next check]
    D -->|Yes| G{Stored method, auto authorization<br/>and budget available?}
    G -->|Yes| A[Automatic payment]
    G -->|No| R[Review exact order]
    R -->|Approve and method ready| C[Create and capture payment]
    R -->|Decline or no approval| N[No payment]
    A --> C
    C --> V[Validate result and record status]
```

The **8kg / $72.99 USD** bag exceeds the default **$50/order** cap; the monthly limit is **$120**, including commitments. A fresh, authorized household with an owner-set **$100/order** cap can take the automatic branch. Approval does not change future limits.

Checks run at startup and every 15 minutes. **Food received** adds the bag once; delivery is simulated. Follow the [repeatable mock walkthrough](docs/demo-runbook.md#repeatable-local-mock-scenario) for both branches.

## Quick start

Requires **Node.js 22.13+ or 24.x**, **pnpm 10.33.4** and a browser. Install Corepack if your Node distribution omits it. Use a fresh shell without exported service settings and fresh local state.

```bash
git clone https://github.com/HanTirong/replenish-ai-hackathon.git
cd replenish-ai-hackathon
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm build:web
node --env-file=.env --import tsx packages/api/src/http.ts
```

PowerShell: replace `cp` with `Copy-Item`. Open **http://127.0.0.1:4781**; `/v1/health` returns `{"ok":true}`. No AI key, PayPal credentials or external database are needed.

The template uses `PAYMENT_PROVIDER=mock`. **`pnpm api` does not load `.env`**; the explicit Node command does. Exported variables override the file; `PORT` overrides `API_PORT`. Leave `DATABASE_URL` unset.

Mock startup does not establish a saved payment method or auto-pay authorization; the walkthrough supplies simulated prerequisites. Frontend hot reload and the rest of the setup are in [local development](docs/local-development.md#separate-backend-and-frontend-development).

## Architecture

```mermaid
flowchart LR
    Web[web<br/>React / Vite] --> API[api<br/>Node.js orchestration]
    API --> Domain[domain<br/>Deterministic forecast and budget]
    Domain <-->|Intent only| AI[DeepSeek<br/>or local rule parser]
    API --> Agent[agent<br/>Payment adapter and journal]
    Agent --> PayPal[PayPal Sandbox<br/>Vault v3 / Orders v2]
    API --> Store[store<br/>Simulated catalog and orders]
    API --> DB[(SQLite)]
    API -.-> Telegram[Optional Telegram notifications]
```

Package names correspond to `packages/`. AI interprets intent; backend rules validate commands and decide purchases. PayPal credentials never enter the LLM. Stock is estimated, not sensor-measured.

## Tests and verification

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:web
```

These checks use simulated services. Browser verification requires Playwright Chromium; see [developer tests](docs/local-development.md#tests-and-browsers).

## Documentation

- [Local development](docs/local-development.md)
- [Sandbox setup](docs/paypal-integration.md)
- [Walkthrough](docs/demo-runbook.md)

[Security](SECURITY.md) · [MIT license](LICENSE) · [Asset/font licenses](THIRD-PARTY-NOTICES.md)
