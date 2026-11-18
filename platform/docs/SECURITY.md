# Security

## Principles

1. Fail closed. Missing configuration, missing session, unknown tenant, invalid signature or queue pressure means deny or keep hidden.
2. Server-side enforcement. Every authorisation decision comes from the database and session; nothing tenant-related is trusted from the browser.
3. Least privilege. Roles map to a fixed permission matrix, enforced in routes and reflected in the UI.
4. No secrets in the client. Ed25519 private keys, HMAC peppers and provider keys live in Worker secrets.

## Authentication

- Passwordless email link: 32 random bytes, stored as SHA-256 hash, single-use, 15 minute TTL, rate-limited per IP and per email hash.
- Sessions: opaque 32-byte tokens, SHA-256 hash in D1, HttpOnly + SameSite=Lax + Secure in production, 14 day TTL, revocable per session or all-other-sessions.
- CSRF: double-submit cookie plus hidden field or header, with Origin/Referer validation, mandatory on cookie-authenticated mutations.
- Admin: Cloudflare Access JWT verified server-side (RS256 against team JWKS, issuer, audience, exp/nbf). A valid assertion is not enough; the email must map to a pre-provisioned staff user.
- Plugin: Ed25519 request signatures with X-BH-Timestamp (+/- 300 seconds), single-use X-BH-Nonce and a SHA-256 body hash in the signed string. Nonces are inserted after signature verification; replay returns 409.

## Authorisation and tenant isolation

- Every portal query includes an organisation membership subquery.
- Resource detail pages return 404 for foreign tenants.
- Admin permissions: customers.*, licenses.*, products.*, releases.write, support.*, servers.read, security.read, audit.read, telemetry.read, settings.*.
- Admins cannot change their own role or status; the action is blocked server-side to prevent lockout.

## Cryptography

- License keys: 100-bit random, HMAC-SHA256 with a secret pepper; plaintext is never stored.
- Activation codes: 8 characters from a 32-symbol alphabet (40 bits), HMAC-hashed, attempt-capped, 24 hour TTL.
- Leases: Ed25519 over canonical JSON (sorted keys, integer numbers, no whitespace). Verification is over the received payload bytes, never a re-serialisation.
- Fingerprints: SHA-256 of the SPKI DER public key, lowercase hex.
- Secret comparisons use constant-time comparison.
- Key rotation: signing_keys supports multiple active keys with key_id; the plugin chooses the key named in the lease payload.

## Input and output

- Zod schemas with strict objects for every JSON API; unknown keys are rejected.
- Body limits: 64 KB JSON, 128 KB signed plugin bodies, 5000-character support messages.
- HTML templating escapes interpolations by default. Markdown is escaped before rendering and link schemes are restricted to http(s) and relative paths.
- SQL is parameterised. LIKE input escapes %, _ and backslash.
- The Worker never fetches a user-supplied URL (no SSRF surface). Release artifact URLs are rendered as links, not fetched.

## Headers

CSP (self plus Turnstile), X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy, COOP, HSTS in production, no-store on portal and admin responses.

## Abuse resistance

- D1 fixed-window rate limits: login (10 per 15 min per IP, 5 per 15 min per email hash), contact (5 per hour per IP), registration (20 per hour per IP), lease/heartbeat/events per installation (60 to 120 per minute).
- Turnstile on login and contact in production; a missing secret fails closed.
- Activation codes are 80-bit, single-use, expire in 24 hours and are guarded by a per-IP escalating lock.
- Plugin requests use signed canonical strings with nonces; leases are Ed25519-signed.

## Authentication

- Email + password sign-up/login: PBKDF2-SHA256, random 16-byte salt, 100,000 iterations (the maximum
  Cloudflare Workers accepts), constant-time comparison. Passwords require at least 10 characters with
  letters and numbers.
- Login is rate-limited per source IP and per email hash. Errors are generic to avoid account enumeration.
- OTP is temporarily disabled (`AUTH_OTP_ENABLED=false`); email-link login and password login remain.
- Existing passwordless accounts can sign in with the email link and set a password at `/app/account`.

## Activation and OTP

- Activation claims are limited to 8-32 input characters, matched against HMAC hashes, single-use and expire
  in 24 hours. Wrong claims are counted per hashed IP; 5 failures lock 5 minutes, 10 lock 10 minutes, then
  20/40/80 minutes. The guard records plugin slugs, installation IDs and server names for admin review.
- Licence keys are 240-bit random values; D1 stores only HMAC-SHA256(pepper, key).
- OTP codes are 6 digits, hashed with HMAC-SHA256 and a pepper, single-use, 10-minute TTL, max 5 attempts,
  and rate-limited per IP/email. Successful OTP/magic-link login marks `email_verified_at`.
- Gmail delivery uses an OAuth refresh token; the platform never accepts or stores a Gmail account password.

## Auditing

- Admin mutations write an immutable admin_audit_events row with actor, action, target, before/after summary, reason, request id and hashed IP.
- Security events record login, logout, registration, activation, invalid signatures, contact and webhook failures.
- Logs are structured JSON; sensitive keys are redacted by the logger.

## Residual risks

- Cloudflare, Cloudflare Access, the email provider and the payment provider are trusted third parties.
- A compromised customer server can copy its licence folder and private key. Fingerprinting detects duplicates but cannot prevent determined tampering.
- Revocation is not instantaneous while a plugin is offline with a still-valid lease.
- DDoS beyond Cloudflare edge protections and our rate limits is out of scope.
- The platform cannot verify that a customer Minecraft server is honest; it only verifies signed requests.

## Reporting

Contact the address configured in SUPPORT_EMAIL with reproduction steps. Do not disclose publicly before coordination. No bounty programme is advertised.
