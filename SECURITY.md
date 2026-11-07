# Security and payment boundaries

## Current scope

Replenish is a single shared-household demonstration. It has no per-user app authentication or production multi-tenant isolation. Ordinary household controls are shared; forced checks, demo resets (including vault-clearing full resets) and payment recovery require a maintenance code. Do not connect real funds or treat this as a production payment service.

The supported external payment scenario is PayPal Sandbox. `PAYPAL_ENV` and `PAYPAL_API_BASE` can change endpoints; do not assume a global code guard prevents every live configuration. Use Sandbox credentials and test cards only. Mock payment and Sandbox are different modes, and a mock receipt is not a transaction record.

## Secrets and state

- Keep API keys, client secrets, actual vault IDs, Bot tokens, private chat IDs and access codes out of source, commits, PRs, screenshots and logs. Use the ignored root `.env` or a secret store. Do not place secrets in `VITE_` variables.
- The application does not automatically load root `.env`; use the [documented loading method](docs/local-development.md#environment-loading). Exported variables can override it. Do not print an environment dump to diagnose configuration.
- Treat `paypal-vault.json`, SQLite state, payment-attempt journals and backups as sensitive. Tokenization does not make a reusable payment token safe to publish.
- The repository ignores `data/` and `.env`, but that is not encryption or access control, and it does not ignore every `.env.*` filename. Keep alternate secret files outside the checkout.
- Use separate data directories and a fresh shell for mock and Sandbox. A mock server can still read existing token configuration; a mock sentinel must never be used with PayPal.

## Payment handling

One-time approval binds the displayed order snapshot; it does not increase future limits. Unknown results retain reservations and require status checking/reconciliation. Do not blindly retry, clear state, delete a vault or switch methods after an uncertain result. Recovery is a separate authenticated and confirmed action, not normal refresh behavior.

`paypal:diagnose` can create a $1.00 Sandbox capture, and `demo:paypal` can execute other test purchases. They are not part of the unit/browser verification aggregate. Read their [payment scope](docs/paypal-integration.md#payment-producing-diagnostic-command) before deliberately authorizing use. No payment is authorized by reading this documentation.

## Reporting a concern

Use the repository's private **Report a vulnerability** option if the owner has enabled it, or an existing private contact with the owner. Do not publish an exploitable report, credential or database in a public issue. No dedicated security inbox, response SLA or guaranteed private-reporting feature is configured by this document; if no private channel is available, ask the owner for one without posting sensitive details.

Include the affected revision, non-sensitive reproduction steps and expected/actual behavior. Use synthetic data. If a credential is exposed, the account owner should revoke/rotate it and reconcile affected payment state; merely deleting a file or rewriting a commit does not revoke a credential. Never post the replacement value.
