# BaseHider Control Platform — status

Updated: 2026-11-17

> Honest verification status. The platform is now **free**: wallet, orders, Stripe, PromptPay,
> slips and top-ups were removed. It is deployed to production (Worker `3579adc4`, D1 migration 0005,
> R2 release jar `e8f8594c…`). Live Access/email credentials remain environment-specific and untested here.

## Verified locally

| Area | State | Evidence |
|---|---|---|
| D1 schema (identity, catalogue, licensing, telemetry, support, audit, activation guard) | Implemented | Migrations 0001–0005 applied by the vitest harness and local Wrangler |
| Free account + licence provisioning | Implemented | Automated test: register server name → 16-char code → claim → free licence created |
| Long random licence keys | Implemented | 240-bit key (`BH-` + 8×6 Crockford groups); only HMAC-SHA256 hash stored; raw key shown once via KV for 7 days |
| Activation brute-force ladder | Implemented | Automated test: 5 failures → 5 min lock, 10 failures → 10 min lock; 20/40/80 escalate further; IP hash + plugin slug + server names recorded |
| Admin graphs and detection analytics | Implemented | 14-day server-rendered SVG charts (activations, telemetry, security, new users), detection breakdown, top servers, live lockout table |
| Free UI (no checkout) | Implemented | Marketing/portal/admin routes compile without wallet/order/payment UI; paid modules and tests deleted |
| Email OTP login and email verification | Implemented | 6-digit code from console outbox, single-use verify, session issued, replay rejected |
| Ed25519 keys, fingerprints, signing, verification | Implemented | 4 crypto tests pass in workerd |
| Passwordless email login, single-use token, sessions, CSRF | Implemented | Integration test: CSRF rejection, email link, session, replay rejection |
| Customer portal (overview, products, licences, servers, activations, support, account, security) | Implemented | All routes return 200 with a real session; tenant isolation test passes |
| Admin console (dashboard, customers, licences, products, releases, servers, support, security, audit, telemetry, settings) | Implemented | All routes return 200 for staff; customer gets 403; product creation audited |
| Licence issuance, activation pairing, signed lease, heartbeat, events | Implemented | Automated tests + `scripts/e2e-license.mjs` against the live dev Worker |
| Replay protection and tampered signature rejection | Implemented | Automated tests (401 tampered, 409 replay) |
| Telemetry queue consumer, idempotency, 5-minute rollups, R2 archive | Implemented | Consumer processed a real heartbeat; archive object listed |
| Security headers, CSP, rate limits, audit trail, structured logs | Implemented | Middleware + tests/manual |
| TypeScript strict typecheck | Passing | `pnpm typecheck` (no errors) |
| Email + password auth | Implemented | PBKDF2-SHA256 (Cloudflare cap: 100,000 iterations), 10-char policy, per-IP/email limits, session cookie; OTP disabled by `AUTH_OTP_ENABLED=false` |
| Production sign-up / sign-in | Verified | browser E2E: register → `/app` with a free licence; logout → password login → `/app` |
| Platform test suite | 21 tests passing | crypto + platform + free licensing + guard ladder + password/auth + content-type guards |
| Java plugin client (3.6.1) | Hardened | HTTPS-only (localhost exempt), redirects disabled, response size/depth limits, 16-char codes, server-name registration, integrity pin, POSIX 0600/0700 key files |
| Java test suite | 123 tests passing on Windows and Linux | Windows `mvn -o test`; WSL Arch Linux JDK 21 `mvn -o test` (includes POSIX permission test) |
| Three-gap packet benchmark | Verified | A–F PASS on Paper 1.21.4; baseline jar leaks all three gaps (`docs/09-three-gap-benchmark.md` in the plugin repo) |
| Local dev | Working | `wrangler dev`; pages, auth, admin and API exercised |
| Production deployment | Live | https://basehider-platform.audijuju1.workers.dev — free pages 200, logo/favicon deployed, admin 503 until Access is configured |
| Production plugin download | Verified | `/release/rel_bh_361/download` returns the uploaded jar; SHA-256 matches `e8f8594c…` |
| Production registration | Verified | disposable installation registered (16-char code, server_name stored), then removed |
| Production Resend OTP | Verified | browser login submitted: OTP page rendered, Turnstile passed, `email_log` shows provider `resend`, status `sent` for audijuju1@gmail.com |
| Documentation set | Complete | `docs/` incl. 8 ADRs |

## Not done / not verified

- **Resend sending domain**: email-link/OTP delivery still uses `onboarding@resend.dev`, which only reaches the
  account owner until a domain is verified. Password sign-up does not need email; email-link recovery does.
- **Existing passwordless accounts**: they can log in with the email link and set a password from `/app/account`.
  If the email cannot be delivered yet, they need the verified sending domain first.
- **Password hashing limit**: Cloudflare Workers rejects PBKDF2 above 100,000 iterations, so the hash uses the
  platform maximum rather than OWASP's higher recommendation. Rate limits and password policy compensate.
- **Production admin Access**: `/admin` returns 503 until Cloudflare Access credentials are configured.
- **Live Turnstile**: widget and server verification are implemented; no live keys were exercised here.
- **Live email**: console mode is used locally; Resend and Gmail API delivery were not exercised here.
- **Browser E2E automation**: pages were smoke-tested via HTTP and screenshots; every form is not covered
  by Playwright.
- **Load testing**: D1 write limits were not load-tested with many installations; rate limits and bounded
  writes are in place.
- **In-memory protection**: a server administrator with a JVM agent can still read or patch process
  memory. The jar pin detects on-disk tampering and reports it; it cannot prove runtime integrity.

## Verified commands

~~~bash
pnpm typecheck
pnpm test                 # 14 platform tests passing
node scripts/e2e-license.mjs   # requires pnpm dev on :8787
cd ../basehider-v3-integrated && mvn test   # 123 plugin tests (Windows and Linux/WSL)
npx wrangler d1 migrations apply bhcp-db --local
npx wrangler d1 execute bhcp-db --local --file=./seed/seed.sql
~~~

## Next steps

1. Configure Cloudflare Access, Turnstile and an email provider, then deploy and run the e2e script.
2. Add Playwright coverage for the portal and admin forms.
3. Load-test activation and telemetry ingestion and document operating thresholds.
