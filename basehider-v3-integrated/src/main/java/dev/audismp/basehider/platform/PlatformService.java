package dev.audismp.basehider.platform;

import dev.audismp.basehider.BaseHiderPlugin;
import org.bukkit.Bukkit;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;

/**
 * License and telemetry client lifecycle. All network I/O runs on a dedicated daemon
 * executor; the Minecraft main thread is only used for messages. Failures are logged and
 * surfaced through /basehider license status and never disable the security core.
 */
public final class PlatformService {

    private final BaseHiderPlugin plugin;
    private final Path directory;
    private final Deque<Map<String, Object>> eventBuffer = new ConcurrentLinkedDeque<>();
    private final AtomicInteger droppedEvents = new AtomicInteger();

    private volatile PlatformConfig config;
    private volatile InstallationIdentity identity;
    private volatile PlatformClient client;
    private volatile LeaseVerifier.Lease lease;
    private volatile long leaseExpiresAt;
    private volatile IntegrityGuard.Result integrity;
    private volatile String state = "DISABLED";
    private volatile String lastError;
    private volatile String activationCode;
    private volatile String portalUrl;
    private volatile long lastHeartbeatAt;
    private ScheduledExecutorService executor;

    public PlatformService(BaseHiderPlugin plugin) {
        this.plugin = plugin;
        this.directory = plugin.getDataFolder().toPath().resolve("platform");
    }

    public void start() {
        try {
            Path configFile = directory.resolve("platform.yml");
            if (!Files.isRegularFile(configFile)) {
                Files.createDirectories(directory);
                try (java.io.InputStream resource = plugin.getResource("platform.yml")) {
                    if (resource != null) {
                        Files.copy(resource, configFile);
                    }
                }
            }
            config = PlatformConfig.load(configFile);
            if (!config.enabled()) {
                state = "DISABLED";
                plugin.getLogger().info("Platform licensing is disabled in platform.yml.");
                return;
            }
            if (!config.usable()) {
                state = "UNCONFIGURED";
                plugin.getLogger().warning("Platform licensing is enabled but api-base-url is not set. "
                        + "Set it in plugins/BaseHider/platform/platform.yml, then run /basehider license link.");
                return;
            }
            executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "BaseHider-Platform");
                thread.setDaemon(true);
                return thread;
            });
            state = "STARTING";
            executor.execute(this::initialize);
            executor.scheduleWithFixedDelay(this::refreshLease, 15, config.leaseRefreshMinutes() * 60L, TimeUnit.SECONDS);
            executor.scheduleWithFixedDelay(this::heartbeat, 30, config.heartbeatMinutes() * 60L, TimeUnit.SECONDS);
            if (config.telemetryEnabled()) {
                executor.scheduleWithFixedDelay(this::flushEvents, 20, config.flushSeconds(), TimeUnit.SECONDS);
            }
        } catch (Throwable throwable) {
            state = "ERROR";
            lastError = throwable.getMessage();
            plugin.getLogger().log(Level.WARNING, "Platform service failed to start: " + throwable.getMessage(), throwable);
        }
    }

    public void stop() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    private void initialize() {
        try {
            identity = InstallationIdentity.loadOrCreate(directory);
            client = new PlatformClient(config.apiBaseUrl(), config.product(),
                    config.requestTimeoutSeconds(), identity);
            state = "IDLE";
            checkIntegrity();
            plugin.getLogger().info("Platform identity ready: " + identity.installationUuid()
                    + " (fingerprint " + identity.fingerprint().substring(0, 12) + "...)");
            refreshLease();
        } catch (Throwable throwable) {
            fail("cannot initialize platform identity", throwable);
        }
    }

    private void checkIntegrity() {
        String configuredPin = config.expectedJarSha256();
        if (!configuredPin.isBlank() && IntegrityGuard.normalizePin(configuredPin).isEmpty()) {
            plugin.getLogger().warning("integrity.jar-sha256 is not a 64-character hex SHA-256; "
                    + "the malformed pin is ignored (status stays UNPINNED).");
        }
        IntegrityGuard.Result result = IntegrityGuard.verify(configuredPin);
        integrity = result;
        if ("TAMPERED".equals(result.status())) {
            plugin.getLogger().warning("Plugin jar SHA-256 does not match integrity.jar-sha256 "
                    + "(actual " + result.actualSha256() + "). Reporting integrity.mismatch; "
                    + "the packet security core stays active.");
            recordEvent("integrity.mismatch", "warning", "plugin jar hash differs from the pinned release",
                    Map.of("actual_sha256", String.valueOf(result.actualSha256()),
                            "expected_sha256", String.valueOf(result.expectedSha256())));
        } else if ("VERIFIED".equals(result.status())) {
            plugin.getLogger().info("Plugin jar integrity verified: " + result.actualSha256());
        }
    }

    public void handle(CommandSender sender, String[] args) {
        String sub = args.length > 1 ? args[1].toLowerCase(java.util.Locale.ROOT) : "status";
        switch (sub) {
            case "link" -> link(sender);
            case "refresh" -> refresh(sender);
            case "verify" -> verify(sender);
            case "status" -> status(sender);
            default -> reply(sender, "§cUsage: /basehider license <status|link|refresh|verify>");
        }
    }

    private void verify(CommandSender sender) {
        IntegrityGuard.Result result = integrity;
        if (result == null) {
            result = IntegrityGuard.verify(config == null ? "" : config.expectedJarSha256());
            integrity = result;
        }
        reply(sender, "§6§lPlugin jar integrity");
        reply(sender, "§7Status: §f" + result.status());
        reply(sender, "§7SHA-256: §f" + (result.actualSha256() == null ? "unavailable" : result.actualSha256()));
        if (result.expectedSha256() != null && !result.expectedSha256().isEmpty()) {
            reply(sender, "§7Pinned: §f" + result.expectedSha256());
        } else {
            reply(sender, "§7Pinned: §e(none)§7 - copy the SHA-256 above into "
                    + "platform.yml integrity.jar-sha256 to detect jar changes.");
        }
        if (result.location() != null) {
            reply(sender, "§7Source: §8" + result.location());
        }
    }

    private void link(CommandSender sender) {
        PlatformConfig current = config;
        if (current == null || !current.enabled()) {
            reply(sender, "§cPlatform licensing is disabled in platform.yml.");
            return;
        }
        if (!current.usable()) {
            reply(sender, "§cSet api-base-url in plugins/BaseHider/platform/platform.yml first.");
            return;
        }
        if (executor == null || executor.isShutdown()) {
            reply(sender, "§cPlatform service is not running. Restart the server after fixing platform.yml.");
            return;
        }
        reply(sender, "§7Contacting the platform…");
        executor.execute(() -> {
            try {
                ensureIdentity();
                PlatformClient.Registration registration = client().register(
                        plugin.getDescription().getVersion(),
                        Bukkit.getMinecraftVersion(),
                        "Paper",
                        reportedServerName(current),
                        System.getProperty("java.version"));
                activationCode = registration.activationCode();
                portalUrl = registration.portalUrl();
                state = "PENDING_ACTIVATION";
                reply(sender, "§6§lBaseHider license pairing");
                reply(sender, "§7Installation: §f" + identity.installationUuid());
                reply(sender, "§7Server name: §f" + reportedServerName(current));
                reply(sender, "§7Activation code: §e§l" + registration.activationCode());
                reply(sender, "§7Open: §b" + registration.portalUrl());
                reply(sender, "§7Enter the code in the portal, then run §f/basehider license refresh§7.");
            } catch (PlatformClient.PlatformApiException exception) {
                if (exception.status() == 429) {
                    fail(sender, "registration is locked for "
                            + Math.max(1, exception.retryAfterSeconds() / 60) + " minute(s)", exception);
                } else {
                    fail(sender, "registration failed (HTTP " + exception.status() + ")", exception);
                }
            } catch (Throwable throwable) {
                fail(sender, "registration failed", throwable);
            }
        });
    }

    private String reportedServerName(PlatformConfig current) {
        if (current != null && !current.serverName().isBlank()) {
            return current.serverName().length() > 64 ? current.serverName().substring(0, 64) : current.serverName();
        }
        String derived = Bukkit.getServer().getName() + ":" + Bukkit.getServer().getPort();
        return derived.length() > 64 ? derived.substring(0, 64) : derived;
    }

    private void refresh(CommandSender sender) {
        if (executor == null || executor.isShutdown()) {
            status(sender);
            return;
        }
        reply(sender, "§7Refreshing license lease…");
        executor.execute(() -> {
            boolean ok = refreshLease();
            if (ok) {
                reply(sender, "§aLicense active. Lease expires " + Instant.ofEpochSecond(leaseExpiresAt) + ".");
            } else {
                reply(sender, "§cLicense refresh failed: " + (lastError == null ? "unknown error" : lastError));
            }
        });
    }

    private void status(CommandSender sender) {
        PlatformConfig current = config;
        reply(sender, "§6§lBaseHider license");
        reply(sender, "§7State: §f" + state + "§7 (enforcement: §f"
                + (current == null ? "n/a" : current.enforcement().name().toLowerCase()) + "§7)");
        if (current != null) {
            reply(sender, "§7Platform: §f" + (current.apiBaseUrl().isBlank() ? "(not configured)" : current.apiBaseUrl()));
        }
        IntegrityGuard.Result checked = integrity;
        if (checked != null) {
            String color = switch (checked.status()) {
                case "VERIFIED" -> "§a";
                case "TAMPERED" -> "§c";
                default -> "§e";
            };
            reply(sender, "§7Jar integrity: " + color + checked.status() + "§7"
                    + (checked.actualSha256() == null ? "" : " §8" + checked.actualSha256().substring(0, 16) + "…"));
        }
        if (identity != null) {
            reply(sender, "§7Installation: §f" + identity.installationUuid());
            reply(sender, "§7Fingerprint: §f" + identity.fingerprint().substring(0, 20) + "…");
        }
        if (lease != null) {
            reply(sender, "§7License: §f" + lease.claims().get("license_id"));
            reply(sender, "§7Lease expires: §f" + Instant.ofEpochSecond(leaseExpiresAt)
                    + " §7(" + remainingMinutes() + " min)");
        } else if (activationCode != null) {
            reply(sender, "§7Activation code: §e§l" + activationCode
                    + " §7→ §b" + (portalUrl == null ? "/app/activations" : portalUrl));
        } else {
            reply(sender, "§7No active lease. Run §f/basehider license link§7 to pair this server.");
        }
        if (config != null && config.telemetryEnabled()) {
            reply(sender, "§7Telemetry: §f" + (lastHeartbeatAt == 0 ? "not sent yet"
                    : "last sent " + Instant.ofEpochSecond(lastHeartbeatAt)) + "§7, buffered events: §f"
                    + eventBuffer.size() + (droppedEvents.get() > 0 ? " §c(dropped " + droppedEvents.get() + ")" : ""));
        }
        if (lastError != null) {
            reply(sender, "§cLast error: §f" + lastError);
        }
    }

    private long remainingMinutes() {
        return Math.max(0, (leaseExpiresAt - CanonicalRequest.nowSeconds()) / 60);
    }

    private boolean refreshLease() {
        try {
            ensureIdentity();
            PlatformClient.LeaseResponse response = client().requestLease(plugin.getDescription().getVersion());
            LeaseVerifier.Lease verified = LeaseVerifier.verify(response.lease(), response.keys(),
                    identity.installationUuid(), config.product(), CanonicalRequest.nowSeconds(), 300);
            lease = verified;
            leaseExpiresAt = verified.expiresAt();
            state = "ACTIVE";
            lastError = null;
            plugin.getLogger().info("Platform license active: " + verified.claims().get("license_id")
                    + " (expires " + Instant.ofEpochSecond(verified.expiresAt()) + ")");
            return true;
        } catch (PlatformClient.PlatformApiException exception) {
            if (exception.status() == 403 || exception.status() == 404) {
                state = activationCode == null ? "UNLICENSED" : "PENDING_ACTIVATION";
                lastError = "license not active (HTTP " + exception.status() + ")";
            } else {
                state = "ERROR";
                lastError = "platform error (HTTP " + exception.status() + ")";
            }
            return false;
        } catch (Throwable throwable) {
            state = lease != null && leaseExpiresAt > CanonicalRequest.nowSeconds() ? "ACTIVE" : "OFFLINE";
            lastError = throwable.getMessage();
            plugin.getLogger().log(Level.FINE, "Platform lease refresh failed: " + throwable.getMessage(), throwable);
            return false;
        }
    }

    private void heartbeat() {
        try {
            if (lease == null || leaseExpiresAt <= CanonicalRequest.nowSeconds()) {
                return;
            }
            PlatformConfig current = config;
            if (current == null || !current.telemetryEnabled()) {
                return;
            }
            Map<String, Object> metrics = new LinkedHashMap<>();
            metrics.put("tps", Bukkit.getTPS()[0]);
            metrics.put("players_online", Bukkit.getOnlinePlayers().size());
            metrics.put("errors", 0);

            List<String> modules = new ArrayList<>();
            if (plugin.blockProtectionActive()) {
                modules.add("block-protection");
            }
            if (plugin.config().anyItemProtectionEnabled()) {
                modules.add("item-protection");
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("schema_version", 1);
            payload.put("plugin_version", plugin.getDescription().getVersion());
            payload.put("minecraft_version", Bukkit.getMinecraftVersion());
            payload.put("platform", "Paper");
            payload.put("java_version", System.getProperty("java.version"));
            payload.put("enabled_modules", modules);
            payload.put("metrics", metrics);
            payload.put("occurred_at", CanonicalRequest.nowSeconds());
            client().heartbeat(payload);
            lastHeartbeatAt = CanonicalRequest.nowSeconds();
        } catch (Throwable throwable) {
            plugin.getLogger().log(Level.FINE, "Platform heartbeat failed: " + throwable.getMessage(), throwable);
        }
    }

    /** Records a bounded operational event for the next telemetry flush. */
    public void recordEvent(String type, String severity, String message, Map<String, Object> attributes) {
        try {
            PlatformConfig current = config;
            if (current == null || !current.telemetryEnabled()) {
                return;
            }
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("event_id", java.util.UUID.randomUUID().toString());
            event.put("type", type);
            event.put("severity", severity);
            event.put("occurred_at", CanonicalRequest.nowSeconds());
            event.put("message", message.length() > 500 ? message.substring(0, 500) : message);
            if (attributes != null && !attributes.isEmpty()) {
                event.put("attributes", attributes);
            }
            eventBuffer.addLast(event);
            while (eventBuffer.size() > current.maxBuffer()) {
                eventBuffer.pollFirst();
                droppedEvents.incrementAndGet();
            }
        } catch (Throwable ignored) {
            // Telemetry must never affect gameplay or security.
        }
    }

    private void flushEvents() {
        try {
            PlatformConfig current = config;
            if (current == null || !current.telemetryEnabled() || eventBuffer.isEmpty()) {
                return;
            }
            List<Map<String, Object>> batch = new ArrayList<>();
            while (batch.size() < current.batchMax() && !eventBuffer.isEmpty()) {
                Map<String, Object> event = eventBuffer.pollFirst();
                if (event != null) {
                    batch.add(event);
                }
            }
            if (batch.isEmpty()) {
                return;
            }
            try {
                client().events(batch);
            } catch (Throwable throwable) {
                // Re-queue at the front (bounded) and retry on the next flush.
                for (int i = batch.size() - 1; i >= 0; i--) {
                    eventBuffer.addFirst(batch.get(i));
                }
                // Same policy as recordEvent: drop the oldest event, never the newest, so a
                // retry backlog keeps the most recent operational context.
                while (eventBuffer.size() > current.maxBuffer()) {
                    eventBuffer.pollFirst();
                    droppedEvents.incrementAndGet();
                }
                throw throwable;
            }
        } catch (Throwable throwable) {
            plugin.getLogger().log(Level.FINE, "Platform telemetry flush failed: " + throwable.getMessage(), throwable);
        }
    }

    private void ensureIdentity() throws IOException, GeneralSecurityException {
        if (identity == null) {
            identity = InstallationIdentity.loadOrCreate(directory);
        }
        if (client == null) {
            client = new PlatformClient(config.apiBaseUrl(), config.product(),
                    config.requestTimeoutSeconds(), identity);
        }
    }

    private PlatformClient client() {
        if (client == null) {
            throw new IllegalStateException("platform client is not initialized");
        }
        return client;
    }

    private void fail(String message, Throwable throwable) {
        state = "ERROR";
        lastError = message + ": " + throwable.getMessage();
        plugin.getLogger().log(Level.WARNING, "BaseHider platform: " + lastError, throwable);
    }

    private void fail(CommandSender sender, String message, Throwable throwable) {
        fail(message, throwable);
        reply(sender, "§c" + lastError);
    }

    private void reply(CommandSender sender, String message) {
        try {
            if (!plugin.isEnabled()) {
                return;
            }
            // RCON and console commands run on the main thread: reply synchronously so
            // command output is captured. Async callbacks are scheduled back on it.
            if (plugin.getServer().isPrimaryThread()) {
                sender.sendMessage(message);
                return;
            }
            if (plugin.getServer().getScheduler() != null) {
                plugin.getServer().getScheduler().runTask(plugin, () -> sender.sendMessage(message));
            } else {
                sender.sendMessage(message);
            }
        } catch (Throwable ignored) {
            // Sender may have disconnected or the server is stopping.
        }
    }

    public String state() {
        return state;
    }

    public LeaseVerifier.Lease lease() {
        return lease;
    }

    public int bufferedEvents() {
        return eventBuffer.size();
    }
}
