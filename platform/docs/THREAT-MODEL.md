# Threat model

## Assets

- License keys, activation codes and the lease signing private key.
- Customer PII: email, organisation, sessions, hashed IPs.
- Telemetry and server fingerprints.
- Admin capabilities and the audit trail.

## Actors

- Anonymous internet user, customer, organisation owner, staff (support/product/security/admin), Cloudflare operator, email and payment providers, malicious plugin client, compromised customer server.

## Trust boundaries

1. Browser to Worker: untrusted input, authenticated by session and CSRF.
2. Plugin to API: authenticated by Ed25519 over the canonical request; body parsed only after verification.
3. Worker to D1/KV/R2/Queues: trusted platform bindings.
4. Worker to Cloudflare Access: JWKS over TLS, JWT verified.
5. Provider webhook to Worker: HMAC shared secret.
6. Customer server to lease: plugin verifies the signature with pinned or published public keys.

## STRIDE summary

| Threat | Example | Mitigation | Residual |
|---|---|---|---|
| Spoofing | Forged plugin request | Ed25519 signature, nonce, timestamp, body hash | Stolen private key |
| Tampering | Modified lease or body | Signature over exact bytes; body hash in signed string | None known |
| Repudiation | Admin denies action | Immutable audit rows with actor and request id | Database compromise |
| Information disclosure | Tenant A reads B licence | org-scoped queries, 404 for foreign detail | Database compromise |
| Denial of service | Login or registration flood | Rate limits, Turnstile, Cloudflare edge | Large botnets |
| Elevation of privilege | Customer hits /admin | Staff role and Access in production | Misconfigured Access |
| Replay | Re-send signed lease request | Single-use nonce table plus timestamp window | None known |
| Webhook forgery | Fake order paid | HMAC, timestamp, idempotency | Secret leak |
| Fake top-up credit | Claim PromptPay money arrived | Signed bank webhook, exact amount, staff confirmation only | Bank/provider compromise |
| OTP brute force | Guess 6-digit code | 10-minute TTL, 5 attempts, per-IP/email rate limits, hashed codes | Large distributed attack |
| Wallet tampering | Replay debit/top-up | Conditional debit, idempotency ledger, single-use top-up status | Code defect |
| CSRF | Force state change | Double-submit cookie and Origin check | Same-site XSS |
| XSS | Product description HTML | Escaped templating and escaped Markdown | Future rich-text feature |
| SQL injection | Search query | Prepared statements and LIKE escaping | None known |
| SSRF | Fetch attacker URL | No outbound fetch from user input | None known |
| Key leakage | Logs contain private key | Redaction and Worker secrets | Operator error |
| Licence sharing | Copy installation key | Fingerprint uniqueness, revocation, rate limits | Determined attacker |
| Offline revocation | Revoked server keeps running | Short lease TTL plus grace; documented | Up to TTL plus grace |
| Supply chain | Malicious dependency | Small dependency set, lockfile | npm compromise |

## Out of scope

- Anti-cheat or anti-tamper on the customer machine.
- Keeping the Minecraft server itself secure (that is BaseHider's job).
- Payment card data: the platform uses a manual provider; no card data touches it.
- DDoS beyond Cloudflare standard protections.
- Legal compliance beyond the published privacy and terms pages.
