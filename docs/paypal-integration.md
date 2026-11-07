# Independent PayPal Sandbox integration

## What is implemented

The browser scenario buys Taste of the Wild Pacific Stream Small Breed, **8kg at $72.99 USD** (`RC-SMALL-8`). Default application limits are $50 per order and $120 per calendar month, including committed orders. The [final video](https://www.youtube.com/watch?v=6BOedfIEZoA) shows approval before a completed Sandbox capture and the matching Sandbox record. Goods, stock and delivery are simulated.

The server authenticates through **OAuth 2.0**, saves a test card using **Vault v3 setup/payment tokens**, and creates/captures a permitted purchase using **Orders v2**. Amount, item, merchant, currency, quantity and order snapshot checks belong to Replenish's backend, not the model or a PayPal budget API.

## Independent Sandbox setup

These are instructions for an account owner's deliberate future test. They were not executed against PayPal during this documentation update. Health checks and written setup steps are not proof of account eligibility, vaulting or capture success.

### Prerequisites

1. Use your own PayPal Developer account and Sandbox business REST application; keep its buyer/test-card environment separate from any real-money account.
2. In the Developer Dashboard, select the Sandbox app. Under Sandbox App Settings / App Feature Options, enable **Accept payments** and **Vault** under the advanced options. Card vaulting also requires the business account's advanced card-payment capability/approval and regional eligibility.
3. PayPal documents server-side card saving and its account/compliance requirements in [Save cards with Payment Method Tokens](https://developer.paypal.com/api/payment-tokens/save-without-purchase/cards/). Account capability is not guaranteed just because OAuth credentials work.
4. Use PayPal's Sandbox test-card data or the adapter's built-in Sandbox test fixture. Never use an actual card here. Obtain your own Sandbox client ID and secret privately.

The web **Connect PayPal** path currently calls the card-vault helper (`ensureSandboxCard`). Do not expect a traditional PayPal Wallet checkout popup or a configurable web wallet selector from this button. Advanced wallet-related adapter/CLI code does not establish a verified browser wallet flow.

### Sandbox environment

Stop any mock server and use a fresh shell. Copy the template to the ignored root `.env` if needed. Edit it locally; do not put actual values in commands or commit the file:

```dotenv
PAYMENT_PROVIDER=paypal
PAYPAL_ENV=sandbox
API_HOST=127.0.0.1
API_PORT=4781
DATA_DIR=./data/sandbox-local
REORDER_INTERVAL_MS=0
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
```

Fill the two blank credential fields only on your machine. Keep the API base at `https://api-m.sandbox.paypal.com`, use a fresh state directory for a fresh account, and leave `PAYPAL_VAULT_ID` unset unless intentionally reusing a valid token from this same Sandbox context. Remove the mock sentinel and inherited mock variables. The application can read actual saved token state even if another session used mock mode.

| Optional setting | Actual behavior/default |
| --- | --- |
| `PAYPAL_API_BASE` | Overrides the derived REST host. Do not point this demo at a live endpoint. |
| `PAYPAL_VAULT_FILE` | Default `DATA_DIR/paypal-vault.json`; explicit path wins. |
| `PAYPAL_VAULT_ID` | Overrides the saved file. An arbitrary value is not proof that PayPal recognizes a token. |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | Configure your own app URLs, e.g. local `/paypal`; code fallback is an example.com placeholder. No special callback route is claimed. |
| `PAYPAL_TEST_CARD_NUMBER`, `PAYPAL_TEST_CARD_EXPIRY`, `PAYPAL_TEST_CARD_CVV`, `PAYPAL_TEST_CARD_NAME` | Optional Sandbox-only card fixture overrides, read server-side. Do not use real card data. |
| `PAYPAL_APPROVAL_TIMEOUT_MS`, `PAYPAL_APPROVAL_POLL_MS` | Setup approval polling defaults: 180000ms and 3000ms. An approval-required setup may need the operator to follow its PayPal link. |
| `REPLENISH_MAINTENANCE_TOKEN` | A locally chosen code of at least 32 characters for an early check/recovery write. Leave unset until deliberately using that controlled entry. |
| `PAYPAL_WEBHOOK_URL` | Exposed configuration metadata; no completed webhook verification/processing integration is claimed. |

`PAYPAL_ENV=live` and API-host overrides are capable of changing the endpoint. Sandbox is the supported demonstration boundary, not a blanket guarantee that every code entry point blocks live configuration.

### Start and check without capturing

From the repository root, in either bash or PowerShell:

```sh
corepack pnpm build:web
node --env-file=.env --import tsx packages/api/src/http.ts
```

In a second terminal, bash:

```bash
curl --fail-with-body http://127.0.0.1:4781/v1/health
curl --fail-with-body http://127.0.0.1:4781/v1/home
```

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4781/v1/health
Invoke-RestMethod http://127.0.0.1:4781/v1/home
```

Expected: health is `{"ok":true}`; a fresh household has no saved method/automatic authorization. These GETs do not validate PayPal credentials or create a capture. Keep the timer at zero for a controlled session.

### Connect, authorize and deliberately exercise payment

1. Open http://127.0.0.1:4781/paypal and select **Connect PayPal**. This invokes card setup-token approval and payment-token creation, reusing a saved card token where appropriate. It contacts PayPal; it is not a local-only connectivity check.
2. Expected on success: an actual stored token, Connected in the refreshed home state, and automatic payment still not enabled. A setup error, account restriction or approval timeout must not be called a successful connection.
3. Explicitly allow automatic payments and save. Review the $50/$120 limits. A connected token alone does not authorize unattended payment.
4. Only when deliberately testing a purchase, configure a local maintenance code, restart, and use your local `/paypal?demo=1` entry to run the reorder check early. This does not advance the clock. Do not expose the code in a URL or recording.
5. The default $72.99 bag should wait for approval because it exceeds $50. Before approval, no capture should exist. Click **Approve $72.99** once only if the order and test scope are correct.
6. Expected successful result: the application validates the returned order and completed capture, marks the order paid/ordered and exposes a capture suffix. Expand it to compare with your Sandbox dashboard's transaction details. A local mock ID is not a PayPal capture.
7. An explicit **Food received** action records simulated receipt and adds one 8kg bag once; there is no real shipment. For a within-budget Sandbox case, authorization plus deliberately higher limits and sufficient remaining monthly budget are also required. That is a separate payment scope, not another automatic step of this test.

Do not repeat approval, reset, delete a vault or change payment method to bypass an unknown result. Use read-only status checking and reconcile the original attempt first.

### Payment-producing diagnostic command

This optional diagnostic is **not** a unit test or read-only credential check. It constructs the PayPal adapter directly and attempts a **$1.00 Sandbox capture**, independently of the product's $72.99 price. It can contact PayPal even if someone expected the general mock selector to protect them. Do not run it without deliberately authorizing that test.

The command is the same in bash and PowerShell, and explicitly loads your ignored `.env`:

```sh
node --env-file=.env --import tsx packages/agent/src/paypal-diagnose.ts
```

Expected success: OAuth scope metadata, a completed diagnostic order/capture, and saved backend vault state. Failure is not permission to repeat a potentially completed transaction. Some CLI introductory retry/fallback wording is legacy; it must not override the actual journal, refusal handling or separate approval requirements. `demo:paypal` is another payment-producing legacy CLI scenario, not a safe default test command. Neither command was run for this documentation.

## Attempts and uncertain results

New attempts have distinct persisted create/capture request IDs. The SQLite journal and order claim protect concurrent approvals. Explicit recovery of an eligible original request requires maintenance authentication, a separate confirmation and current snapshot/pause/budget/source checks. Unknown outcomes keep their budget reservation.

Known orders can be queried. Mismatched, legacy and expired cases require manual reconciliation. The application's five-hour replay policy is not a measured PayPal idempotency-retention guarantee. A card refusal does not automatically switch payment methods; changing method requires a newly approved attempt.

Settled amounts count in the payment's calendar month in the household time zone. Unsettled commitments continue reserving budget across months until resolved; their creation month alone does not release the reservation.

Recovery edge cases have simulated regression coverage. Real lost-response recovery, duplicate-capture recovery and retention measurements remain unverified. No new independent Sandbox account, card vault or capture was exercised by this documentation change.

## Notifications

The owner confirmed the recorded Telegram approval/deep link and post-payment message. Other failure/shortage variants have simulated coverage. Independent notification setup needs your own Bot token, positive private `TELEGRAM_CHAT_ID`, a valid `PUBLIC_APP_URL` origin (or `RENDER_EXTERNAL_URL`) and owner `/start` opt-in. `/test` sends a fixed notification, not an order or payment; it is not proof of a business-event delivery. Messages link to the website and cannot approve payment.

## Source and related guides

- [PayPal adapter](../packages/agent/src/paypal.ts), [provider wrapper](../packages/agent/src/paypal-provider.ts)
- [Household service](../packages/api/src/service.ts), [HTTP routes and vault wiring](../packages/api/src/http.ts)
- [Local usage examples](demo-runbook.md), [environment loading](local-development.md#environment-loading), [security](../SECURITY.md)
