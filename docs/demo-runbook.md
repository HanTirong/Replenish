# Replenish usage and demo walkthrough

[Hosted demo](https://replenish-ai-eze1.onrender.com) · [final recorded walkthrough](https://www.youtube.com/watch?v=6BOedfIEZoA)

## Current scenario

Qizai is an 8kg cockapoo. The baseline is two 75g meals per day, 1,200g estimated starting stock and **Taste of the Wild Pacific Stream Small Breed, 8kg, $72.99 USD** (`RC-SMALL-8`). The default limits are $50 per order and $120 per calendar month. Dates and stock change with elapsed meals; the store and delivery are simulated.

The website is one shared household. Visitors may change feeding or complete an order. Start with the current displayed values rather than assuming a clean baseline. The video supplies the owner-prepared Sandbox purchase; do not require another payment to judge that recording.

## Feeding change to updated forecast

1. Tap Qizai to inspect stock, per-meal grams and daily use.
2. From 75g per meal, send `Feed him 10g less per meal from now on`.
3. Expect a saved 65g-per-meal / 130g-per-day result and a recalculated forecast. **Okay** closes an already-saved result; **Undo** reverses the displayed feeding revision.
4. From the restored baseline, `Skip Qizai's dinner tomorrow` records an exception. A half-day shift can leave the saved order date unchanged under the normal 24-hour threshold.
5. Use **Replenishment plan** for the three dates and calculation inputs; **Recent activity** shows saved actions. A paid order is not automatically cancelled by a feeding change.

Missing scope or a large permanent change can require clarification. Use an absolute confirmation such as `Confirm: 85g per day` or `Confirm: 85g per meal` only when that is your intended target. Predictions estimate consumption; they do not measure the bowl or detect real delivery.

## Repeatable local mock scenario

Follow [installation](local-development.md#prerequisites-and-installation), copy the template to the ignored root `.env`, and build the UI. Use a fresh shell without service credentials. The setup below deliberately simulates a stored-method reference so the existing authorization gate can be exercised with `MockPaymentProvider`. `MOCK_ONLY_NOT_A_PAYPAL_TOKEN` is a non-secret sentinel, not a valid payment token. Never use it in Sandbox mode.

### Start a fresh isolated household

Bash:

```bash
export PAYMENT_PROVIDER=mock
export API_HOST=127.0.0.1
export API_PORT=4781
unset PORT
export DATA_DIR="$(mktemp -d)"
export REORDER_INTERVAL_MS=0
export PAYPAL_VAULT_ID=MOCK_ONLY_NOT_A_PAYPAL_TOKEN
read -r -s -p 'Choose a local code of at least 32 characters: ' REPLENISH_MAINTENANCE_TOKEN
printf '\n'
export REPLENISH_MAINTENANCE_TOKEN
node --env-file=.env --import tsx packages/api/src/http.ts
```

PowerShell:

```powershell
$env:PAYMENT_PROVIDER = 'mock'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '4781'
Remove-Item Env:PORT -ErrorAction SilentlyContinue
$env:DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$env:REORDER_INTERVAL_MS = '0'
$env:PAYPAL_VAULT_ID = 'MOCK_ONLY_NOT_A_PAYPAL_TOKEN'
$env:REPLENISH_MAINTENANCE_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Choose a local code of at least 32 characters' -AsSecureString)).Password
node --env-file=.env --import tsx packages/api/src/http.ts
```

The temporary directory gives each run fresh household state. The timer is disabled; the manual local check supplies the trigger. The sentinel makes only this simulated setup report a stored method. Ordinary no-key mock startup, without a sentinel or saved method, does not establish real PayPal connection/authorization.

### Branch A: default limits require approval

1. Open http://127.0.0.1:4781. Make the feeding change above and inspect its forecast.
2. Open the PayPal controls. The local simulated method is present; explicitly **Allow automatic payments**, then **Save and continue**. Keep $50 per order / $120 per month.
3. Open http://127.0.0.1:4781/paypal?demo=1, enter your local code and select **Run reorder check now**. This runs an early check, not a clock change.
4. Expect an **unpaid** $72.99 approval because it exceeds $50 by $22.99. No automatic payment should occur at this point.
5. If deliberately completing the simulation, approve once. Expected result: a confirmed mock order, not a real PayPal capture or Sandbox transaction. **View order** shows the result.
6. If deliberately completing simulated receipt, use **Food received** once. It adds 8,000g to the food still remaining and schedules the next cycle. It does not create an immediate second approval.

### Branch B: authorized and inside both limits

Stop the process and start again with a **new temporary DATA_DIR** using the same setup. Do not reuse Branch A's paid order/monthly spend as a clean baseline.

1. Make the feeding change and inspect the updated forecast.
2. Explicitly authorize automatic payment in the simulated PayPal controls. In **Budget details**, deliberately set the order cap to **$100**, keeping the monthly budget at **$120**. With fresh data, the $72.99 purchase fits both rules.
3. Run the local early reorder check with your code.
4. Expected result: the mock provider records the purchase without another approval card. Inspect **View order**. This is a simulated automatic path; it does not validate a PayPal token.
5. Receipt, if deliberately confirmed, adds the bag once. Limits persist; approving a previous order would not have raised them.

The $100 cap is an explicit simulation setting, not the default or a proposed change to the hosted demo. To see the monthly gate independently, a sufficiently low monthly allowance also requires approval. Unknown payment outcomes stay held for review.

### Optional HTTP feeding example

With the local server running, bash:

```bash
curl --fail-with-body http://127.0.0.1:4781/v1/home
curl --fail-with-body -X POST http://127.0.0.1:4781/v1/chat -H 'Content-Type: application/json' --data '{"text":"Feed him 10g less per meal from now on"}'
```

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4781/v1/home
$message = @{ text = 'Feed him 10g less per meal from now on' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:4781/v1/chat -Method Post -ContentType 'application/json' -Body $message
```

Use a fresh 75g baseline once; sending the relative instruction again is a new reduction, not a read-only check. The API's approval endpoint requires the current `expectedTotalCents` **and** `approvalSnapshot`; the UI supplies both. Do not construct approval from a stale amount alone.

Close the server and fresh shell after local testing. Do not reuse the sentinel or temporary mock settings in [Sandbox setup](paypal-integration.md#independent-sandbox-setup).

## Verification boundaries

The hosted video and historical owner feedback demonstrate the recorded successful Sandbox purchase and notification. The local mock branches above describe expected behavior from the implementation and simulated coverage, not new real-payment acceptance.

The payment and receipt steps above describe expected behavior backed by simulated tests; they are not independent Sandbox acceptance. Startup, environment loading, feeding changes and an unpaid approval can be checked without approving or capturing. Independent Sandbox configuration, live recovery and retention behavior require separate validation; do not infer execution merely from this guide being present.
