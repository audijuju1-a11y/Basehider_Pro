# Operations

## What to watch

| Signal | Where | Healthy |
|---|---|---|
| API availability | external monitor on /api/v1/health | 200 in under a second |
| Database latency | /status component detail | single-digit ms locally; investigate sustained >200 ms |
| Telemetry backlog | /admin/telemetry, telemetry_events.processed_at IS NULL | 0 or draining |
| Last telemetry processing | /admin/telemetry | within a few minutes when servers are online |
| Stale installations | installations.status = stale | expected only for offline servers |
| Failed logins | /admin/security | no sustained spikes |
| Invalid signatures | security_events event_type = request.invalid_signature | investigate immediately |
| Queue DLQ | Cloudflare dashboard | empty |
| Cron executions | job_runs table | hourly, status ok |

## Logs

Structured JSON lines with level, event, ts, request id and route. Important events:
request, email.failed, audit.write_failed, queue.processing_failed, scheduled.cleanup, webhook.failed,
telemetry.archive_failed, security_event.write_failed.

Sensitive keys (token, secret, password, authorization, api key, private, signature, cookie) are redacted.

## Runbooks

### Telemetry backlog growing / not draining
1. Check the consumer is attached: npx wrangler queues consumer list bhcp-telemetry.
2. Check Workers logs for queue.processing_failed and R2 errors.
3. Inspect the DLQ. If messages are poisoned, fix the payload and replay from DLQ after deploying.
4. Confirm R2 bucket exists and the binding name matches ARCHIVE.
5. Telemetry failure does not affect licence verification; communicate scope accordingly.

### Login emails not delivered
1. /status shows the email component state.
2. Check the provider dashboard for bounces or domain verification failures.
3. Verify MAIL_FROM domain and RESEND_API_KEY.
4. In development, EMAIL_PROVIDER=console logs the link and stores the outbox in KV.
5. Never switch production to console to "fix" delivery; it will fail closed.

### Admin console returns 403 or 503
1. 503 means Access env vars are missing in production; fix ACCESS_TEAM_DOMAIN and ACCESS_AUD.
2. 403 means the Access assertion is valid but the email is not a staff user, or the assertion is invalid.
3. Confirm the Access application protects /admin* and the audience tag matches.
4. Provision or promote the user in D1, then re-authenticate.

### Licence issuance fails
1. Check /admin/licenses and the audit log for the attempted action.
2. Confirm LICENSE_SIGNING_KEY and LICENSE_PUBLIC_KEY are present and match; ensureSigningKey throws on mismatch.
3. Check signing_keys for the configured key id and status.
4. Verify D1 write capacity and recent errors.

### Invalid signature spike
1. Confirm the plugin uses the exact request bytes and the canonical string from the docs.
2. Check the installation public_key in D1.
3. Check clock skew on the customer server (timestamp window is 300 seconds).
4. Treat repeated failures as a possible credential/compromise signal and review the installation.

### Activation lockout / suspected code guessing

1. Open /admin/security; the top table lists every hashed IP with failure count, lock level, lock expiry,
   plugin slugs and the server names seen from that IP.
2. Locks expire automatically (5/10/20/40/80 minutes based on accumulated failures) and reset after a
   successful claim or 24 hours without failures.
3. If a legitimate owner is caught behind a shared NAT, wait for the lock to expire or verify the server
   in a support ticket; there is no manual unlock button yet (database-only operation if urgent).
4. Look for repeated failures across many server names from one IP: that is the "other server names"
   signal the guard records.

### Scheduled job failure
1. Read job_runs status=error and the detail column.
2. Re-run manually by invoking the scheduled handler in a local/dev environment if needed.
3. Cleanup failures are safe to retry; they delete only expired rows and old processed telemetry.

## Change management

- Migrations: back up D1, review SQL, apply to staging first, then production.
- Secrets: rotate signing keys with overlap; retire old keys only after all leases expire.
- Deploys: use wrangler versions/deployments for rollback; keep .dev.vars out of source control.
- Every admin action that changes state is audited; use the reason field meaningfully.

## Escalation

Severity 1: leaked signing key, cross-tenant data exposure, auth bypass, production admin unavailable.
Severity 2: licence issuance/verification failing, telemetry outage, payment webhooks failing.
Severity 3: cosmetic bugs, documentation issues.

For severity 1, rotate secrets, invalidate sessions, review audit/security events, and notify affected customers
according to the privacy policy.
