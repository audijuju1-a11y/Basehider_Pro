import type { Env, TelemetryQueueMessage } from "./env";
import { processTelemetryMessage } from "./services/telemetry";
import { logError } from "./lib/logger";

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as TelemetryQueueMessage | undefined;
    if (!body || typeof body.id !== "string" || typeof body.installationId !== "string") {
      logError("queue.invalid_message", new Error("invalid queue payload"));
      message.ack();
      continue;
    }
    try {
      await processTelemetryMessage(env, body);
      message.ack();
    } catch (error) {
      logError("queue.processing_failed", error, {
        eventId: body.id,
        installationId: body.installationId,
      });
      message.retry();
    }
  }
}
