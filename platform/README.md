# BaseHider Control Platform (BHCP)

Free multi-product platform for Minecraft plugins: public storefront, owner portal with email+password or email-link login,
developer admin console, Ed25519 license leases, activation pairing, telemetry, admin graphs/alerts and
abuse protection — all on Cloudflare Workers + D1 + KV + R2 + Queues.

**There is no paid system.** Wallet, PromptPay, Stripe, orders, slips and top-ups were removed.
Every account receives a free licence with a 240-bit random key; the platform stores only an HMAC hash.

> **Status:** live on Cloudflare at **https://basehider-platform.audijuju1.workers.dev** (Worker, D1, KV, R2,
> Queues, cron). Public pages and API are verified. Customer login still needs a real email provider, and
> \`/admin\` needs Cloudflare Access; those two provider credentials are the remaining production steps.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (single Worker + Static Assets) |
| Router / SSR | Hono 4 + typed HTML template functions (no SPA framework) |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` |
| Sessions / cache | Cloudflare KV (`CACHE`) plus D1-backed sessions |
| Archives | Cloudflare R2 (`ARCHIVE`) for raw telemetry JSON |
| Async | Cloudflare Queues (`bhcp-telemetry` + DLQ) |
| Crypto | WebCrypto Ed25519 (SPKI/PKCS#8), HMAC-SHA256, SHA-256 |
| Admin auth | Cloudflare Access JWT (RS256) in production; dev bootstrap route locally |
| Customer auth | Email+password (PBKDF2-SHA256) plus optional email link; opaque HttpOnly session cookie, CSRF double-submit |
| Tests | Vitest 4 with `@cloudflare/vitest-plugin` (workerd, real D1/KV/R2/Queue bindings) |

## Layout

```
src/
  index.ts             Worker entry (fetch / queue / scheduled)
  app.ts               Hono app, error handling, 404
  middleware.ts        request id, security headers, CSP, session, CSRF, lang, IP hash
  auth/                sessions, email tokens, Turnstile, Access JWT, RBAC guards
  services/            licensing, telemetry, catalog, orders, support, portal, admin, status
  routes/              marketing, auth, portal, admin, plugin/public API
  views/               server-rendered UI (layout, marketing, portal, admin, auth)
  content/docs.ts      in-app documentation
migrations/0001_init.sql
seed/                  BaseHider product + plan + release, copy refresh script
public/                CSS, JS, fonts, favicon, jar download, robots.txt
tests/                 workerd integration tests + helpers
scripts/               key generation, e2e licence smoke test, shots/QA helpers
docs/                  architecture, security, DB, API, protocol, ops, ADRs
```

## Quick start (local)

Requirements: Node 24 + pnpm 11 (or use the bundled runtimes), and Windows/macOS/Linux.

```bash
cd platform
pnpm install            # single-package pnpm workspace (`packages: ["."]`)

# local D1 (same local state used by wrangler dev)
pnpm db:migrate:local
pnpm db:seed:local

# optional: generate your own dev signing key and derive the public key
pnpm keygen
node scripts/dev-public-key.mjs

pnpm dev          # http://127.0.0.1:8787
```

Local admin bootstrap: set `DEV_BOOTSTRAP=1` and `DEV_ADMIN_TOKEN=<16+ characters>` in `.dev.vars`, then
open `http://127.0.0.1:8787/auth/dev-admin?token=<token>` (or send the `x-dev-admin-token` header). It signs in
the first address in `ADMIN_EMAILS` and grants `super_admin`. The route answers 404 unless both variables are
set and `ENVIRONMENT !== production`.

Customer sign-up is email-only: confirm the address from the link, then set a password in `/app/account`.
Password sign-in is refused until the address is verified; verifying also clears any password that was stored
before verification (the account-squatting defence).

Customer login: use any email on `/auth/login`; with `EMAIL_PROVIDER=console` the one-time link is
rendered on the check-email page and logged (development only).

## Environment

Copy `.dev.vars.example` → `.dev.vars` and fill the values. Secrets required for production:

| Name | Purpose |
|---|---|
| `LICENSE_KEY_PEPPER` | HMAC pepper for license keys and activation codes |
| `LICENSE_SIGNING_KEY` | Ed25519 private key, PKCS#8 DER base64 |
| `LICENSE_PUBLIC_KEY` | matching SPKI DER base64 |
| `LICENSE_SIGNING_KEY_ID` | key id published to plugins (rotation support) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Cloudflare Access protection for `/admin` |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | bot protection on login/contact |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM` | transactional email (`console`, `resend`, `mailchannels`, `gmail`); production uses Resend with `onboarding@resend.dev` until a domain is verified |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER` | optional Gmail API OTP delivery (OAuth, never an account password) |
| `OTP_PEPPER` | optional dedicated pepper for OTP hashes; falls back to `LICENSE_KEY_PEPPER` |
| `IP_HASH_PEPPER` | optional dedicated pepper for hashed IPs in rate limits/analytics; falls back to `LICENSE_KEY_PEPPER` and fails closed in production |

Non-secret vars: `APP_URL`, `ENVIRONMENT`, session/lease TTLs, `EMAIL_OTP_TTL_MINUTES`, `ADMIN_EMAILS` (development only).

## Email OTP

Email OTP is a real 6-digit single-use code (10 min, attempt-limited) delivered by the configured
provider. Gmail is supported through the **Gmail API with an OAuth refresh token**. A raw Gmail
account password/SMTP is deliberately not accepted: Workers cannot do authenticated SMTP reliably and
storing an account password would be unsafe. Use a Google OAuth client (`gmail.send`) or Resend.

Gmail API setup:
1. Create a Google Cloud OAuth client (Desktop) and enable the Gmail API.
2. Authorize with scope `https://www.googleapis.com/auth/gmail.send` for the sender account.
3. Exchange the authorization code once and store the refresh token as `GMAIL_REFRESH_TOKEN`; set
   `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_SENDER`, and `EMAIL_PROVIDER=gmail`.
4. Rotate the refresh token if the account changes; never put the account password in `.dev.vars`.

## Verification (run locally)

```bash
pnpm typecheck          # strict TypeScript, no errors
pnpm test               # 21 tests: crypto, auth, licensing, tenancy, admin, telemetry, free licence issuance, lockout ladder
node scripts/e2e-license.mjs

# plugin client (Java 21 / Maven)
cd ../basehider-v3-integrated
mvn test                # 102 tests, including 17 platform-client tests
```

The e2e script exercises the real HTTP surface: dev admin login → issue licence → plugin registration →
portal activation claim → signed lease (verified locally with the published key) → heartbeat → events →
replay rejection → portal visibility. It expects the dev server on port 8787.

## License protocol (short)

1. Plugin creates an installation UUID + Ed25519 keypair and registers it (`/api/v1/installations/register`).
2. Backend returns a 16-character (80-bit) activation code; the owner claims it in the portal and a free licence is provisioned automatically.
3. Plugin requests a signed lease with a signed request:

   ```
   METHOD\npathname\ninstallation_uuid\ntimestamp\nnonce\nsha256hex(rawBody)
   ```

   Headers: `X-BH-Installation`, `X-BH-Timestamp`, `X-BH-Nonce`, `X-BH-Signature`.
4. The lease is `payloadB64url.signatureB64url`; the payload is canonical JSON and the signature covers
   the exact payload bytes. Plugins verify with the published SPKI keys.
5. Leases default to 24 h TTL with 72 h offline grace. Revocation takes effect on the next renewal.

Full contract: `docs/API-SPECIFICATION.md`, `docs/LICENSE-PROTOCOL.md`.

## Deployment (summary)

Cloudflare account required. Create D1/KV/R2/Queues, replace the placeholder IDs in `wrangler.jsonc`,
set secrets, apply migrations remotely, seed the catalogue once, then deploy:

```bash
npx wrangler d1 create bhcp-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create bhcp-archive
npx wrangler queues create bhcp-telemetry
npx wrangler queues create bhcp-telemetry-dlq

npx wrangler d1 migrations apply bhcp-db --remote
npx wrangler d1 execute bhcp-db --remote --file=./seed/seed.sql
npx wrangler secret put LICENSE_SIGNING_KEY
# ... other secrets
npx wrangler deploy
```

Then configure Cloudflare Access for `/admin*`, Turnstile keys, and an email provider. See
`docs/DEPLOYMENT.md` for the full checklist and rollback steps.

## Known gaps

- No Cloudflare deployment was performed in this environment.
- Turnstile, Access and Resend/Gmail are implemented but unverified against live services.
- Turnstile/Access provider credentials remain the production gate; licensing itself is fully free.
- Multi-user organisations, file attachments and invoice PDFs are not implemented (invoices are no longer relevant: the platform has no payments).
- Light theme exists; marketing copy is Thai-first with English UI strings partially available.

## Local free-licence test

1. Boot `pnpm dev` (or use the automated tests: `pnpm test`).
2. Sign in through the dev route, open `/app`, and the account receives a free BaseHider licence.
3. Open `/app/licenses`, copy the long key shown for 7 days, and claim the plugin's 16-character
   activation code at `/app/activations`.
4. Wrong activation codes from one IP raise the lockout ladder; watch it in `/admin/security`.
