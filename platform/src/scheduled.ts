import type { Env } from "./env";
import { DAY, now } from "./lib/time";
import { batch, run } from "./lib/db";
import { getSetting } from "./services/audit";
import { log, logError } from "./lib/logger";
import { ensureSigningKey } from "./services/licensing";

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const startedAt = now();
  let status: "ok" | "warn" | "error" = "ok";
  const details: Record<string, number | string> = {};
  try {
    const retentionDays = Math.max(
      1,
      Math.min(3650, Number.parseInt((await getSetting(env, "telemetry.retention_days")) ?? "90", 10) || 90),
    );
    const retentionCutoff = now() - retentionDays * DAY;
    const timestamp = now();

    const results = await batch(env.DB, [
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`).bind(
        timestamp - DAY,
        timestamp - 30 * DAY,
      ),
      env.DB.prepare(`DELETE FROM email_tokens WHERE expires_at < ?`).bind(timestamp - DAY),
      env.DB.prepare(`DELETE FROM activation_nonces WHERE expires_at < ?`).bind(timestamp),
      env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(timestamp - 2 * DAY),
      env.DB.prepare(`UPDATE licenses SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`).bind(
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `UPDATE installations SET status = 'stale', updated_at = ?
          WHERE status = 'active' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`,
      ).bind(timestamp, timestamp - 15 * 60 * 1000),
      env.DB.prepare(
        `DELETE FROM telemetry_events WHERE id IN (
           SELECT id FROM telemetry_events WHERE processed_at IS NOT NULL AND received_at < ? LIMIT 1000
         )`,
      ).bind(retentionCutoff),
    ]);

    details.sessions = results[0]?.meta?.changes ?? 0;
    details.email_tokens = results[1]?.meta?.changes ?? 0;
    details.nonces = results[2]?.meta?.changes ?? 0;
    details.rate_limits = results[3]?.meta?.changes ?? 0;
    details.expired_licenses = results[4]?.meta?.changes ?? 0;
    details.stale_installations = results[5]?.meta?.changes ?? 0;
    details.telemetry_deleted = results[6]?.meta?.changes ?? 0;
    details.retention_days = retentionDays;

    try {
      const signing = await ensureSigningKey(env);
      details.signing_key_id = signing.keyId;
    } catch (error) {
      status = "warn";
      details.signing_key = error instanceof Error ? error.message : "unavailable";
    }

    await run(
      env.DB,
      `INSERT INTO job_runs (id, job, status, detail, started_at, finished_at, duration_ms)
       VALUES (?, 'scheduled.cleanup', ?, ?, ?, ?, ?)`,
      `job_${timestamp}`,
      status,
      JSON.stringify(details),
      startedAt,
      now(),
      now() - startedAt,
    );
    log("info", "scheduled.cleanup", { status, ...details });
  } catch (error) {
    status = "error";
    logError("scheduled.cleanup_failed", error);
    try {
      await run(
        env.DB,
        `INSERT INTO job_runs (id, job, status, detail, started_at, finished_at, duration_ms)
         VALUES (?, 'scheduled.cleanup', 'error', ?, ?, ?, ?)`,
        `job_${startedAt}`,
        error instanceof Error ? error.message.slice(0, 500) : "unknown",
        startedAt,
        now(),
        now() - startedAt,
      );
    } catch {
      /* database may be unavailable */
    }
  }
  ctx.waitUntil(Promise.resolve());
}
