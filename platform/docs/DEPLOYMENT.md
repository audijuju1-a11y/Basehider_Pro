# Deployment

## Prerequisites

- Cloudflare account with Workers, D1, KV, R2 and Queues enabled.
- Node 24 and pnpm 11 (or use the bundled runtimes in this workspace).
- Wrangler authenticated: npx wrangler login.
- A domain on Cloudflare for the Worker route and Access.
- An email provider account (Resend is implemented) or accept console mode for staging only.

## 1. Create resources

~~~bash
npx wrangler d1 create bhcp-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create bhcp-archive
npx wrangler queues create bhcp-telemetry
npx wrangler queues create bhcp-telemetry-dlq
~~~

Copy the D1 database_id and KV namespace id into wrangler.jsonc, replacing the placeholder zeros.

## 2. Configure vars and secrets

Non-secret vars in wrangler.jsonc:

- ENVIRONMENT=production
- APP_URL=https://your-domain.example
- SESSION_TTL_DAYS=14, LEASE_TTL_HOURS=24, OFFLINE_GRACE_HOURS=72
- TURNSTILE_SITE_KEY, ACCESS_TEAM_DOMAIN, ACCESS_AUD
- EMAIL_PROVIDER=resend or gmail, MAIL_FROM, SUPPORT_EMAIL
- PROMPTPAY_PHONE=0925789459, PROMPTPAY_NAME=BaseHider, EMAIL_OTP_TTL_MINUTES=10
- ADMIN_EMAILS may be left empty in production (Access is the admin path)

Secrets:

~~~bash
npx wrangler secret put LICENSE_KEY_PEPPER
npx wrangler secret put LICENSE_SIGNING_KEY
npx wrangler secret put LICENSE_PUBLIC_KEY
npx wrangler secret put LICENSE_SIGNING_KEY_ID
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put RESEND_API_KEY
# only when EMAIL_PROVIDER=gmail (OAuth, not an account password)
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
~~~

Generate the signing key with: node scripts/generate-signing-key.mjs. Keep the private key in a password manager
as well as the Worker secret. Never commit .dev.vars.

## 3. Database

~~~bash
npx wrangler d1 migrations apply bhcp-db --remote
npx wrangler d1 execute bhcp-db --remote --file=./seed/seed.sql
~~~

Seeding is idempotent for the BaseHider row. The seed publishes the 3.6.1 release with its SHA-256 and the
3.2.0 history; the jar is served from `/download/BaseHider-3.6.1.jar`. Set the real price and plans in the admin
console after the first login. If you do not want to seed the BaseHider product, skip the seed and create products
in the admin UI.

## 4. Admin access

1. Create a Cloudflare Access application for the path /admin* on the Worker domain.
2. Policy: allow only the developer emails; require MFA.
3. Copy the Application Audience (AUD) tag to ACCESS_AUD and the team domain to ACCESS_TEAM_DOMAIN.
4. Provision staff users by signing in once through the customer login, then promote the user:
   npx wrangler d1 execute bhcp-db --remote --command "UPDATE users SET role='super_admin' WHERE email='you@example.com'"
5. Verify /admin returns 403 without Access and 200 with it.

If Access is missing in production the admin routes return a configuration error (fail closed). There is no
password fallback.

## 5. Turnstile

Create a Turnstile widget for the domain, set TURNSTILE_SITE_KEY and TURNSTILE_SECRET. In production a missing
secret blocks login and contact submissions with a clear configuration message.

## 6. Transactional email and OTP

OTP login uses the same provider adapter as the magic link. Supported providers: console (development
only), Resend, MailChannels and Gmail API.

Resend:
1. Verify the sending domain in Resend.
2. Set EMAIL_PROVIDER=resend, MAIL_FROM and RESEND_API_KEY.
3. Send a test login and confirm delivery, SPF/DKIM and the link host (APP_URL).

Gmail API (OAuth refresh token, not an account password):
1. Google Cloud console: enable Gmail API and create an OAuth client.
2. Authorize scope https://www.googleapis.com/auth/gmail.send for the sender account.
3. Exchange the authorization code once and store the refresh token as GMAIL_REFRESH_TOKEN.
4. Set EMAIL_PROVIDER=gmail, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_SENDER.
5. Rotate the refresh token when the account changes. A raw Gmail password/SMTP is intentionally not accepted.

Console mode is for development only; production refuses to send with EMAIL_PROVIDER=console.

## 6b. Free platform

There is no payment configuration. Wallet, PromptPay, Stripe, top-ups, slips and orders were removed;
activation codes and licence keys are the only customer-facing secrets. Configure `LICENSE_KEY_PEPPER`,
`LICENSE_SIGNING_KEY`, `LICENSE_PUBLIC_KEY` and `LICENSE_SIGNING_KEY_ID`.
## 7. Queues and cron

wrangler.jsonc already defines the producer/consumer binding, DLQ and an hourly cron (17 * * * *).
After deploy check that the consumer is connected:

~~~bash
npx wrangler queues consumer list bhcp-telemetry
~~~

The scheduled job cleans expired sessions, tokens, nonces and rate windows, expires licences, marks stale
installations and deletes telemetry beyond retention. It records each run in job_runs and logs a JSON line.

## 8. Deploy

~~~bash
npx wrangler deploy
~~~

Set the custom domain in the Worker settings. Then smoke test:

1. GET / and /plugins return 200.
2. GET /api/v1/health returns { data: { status: "ok" } }.
3. GET /auth/login renders and sends a real email.
4. /admin is protected by Access and renders the dashboard.
5. GET /api/v1/license/keys returns the production key id and SPKI.
6. Registration + activation + lease + heartbeat from a test installation (scripts/e2e-license.mjs can be
   adapted to the production URL, but creates test data).

## 9. Rollback

- Workers: deploy the previous version from the Cloudflare dashboard or re-deploy the previous git commit.
- D1: migrations are additive. Restore from a pre-deploy export if a migration is destructive (none are, currently).
- Secrets: rotated keys keep old public keys in signing_keys as retired until leases expire.

## 10. CI outline

~~~text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
npx wrangler deploy --dry-run
~~~

Do not run production migrations automatically before backups and review.
