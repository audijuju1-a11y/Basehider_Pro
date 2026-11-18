$ErrorActionPreference = 'Stop'
$root = 'D:\Basehider\basehider-v3-integrated\src\main\java\dev\audismp\basehider'
$pluginFile = "$root\BaseHiderPlugin.java"
$commandFile = "$root\command\BaseHiderCommand.java"

# ── Plugin: imports ─────────────────────────────────────────────────────────
$c = [System.IO.File]::ReadAllText($pluginFile)
$old = 'import dev.audismp.basehider.metrics.Metrics;'
$new = @'
import dev.audismp.basehider.core.GatewayWatchdog;
import dev.audismp.basehider.maintenance.DiagnosticsExporter;
import dev.audismp.basehider.metrics.Metrics;
'@
$c = $c.Replace($old, $new)

# ── Plugin: fields ─────────────────────────────────────────────────────────
$old = @'
    private MiningAnalytics miningAnalytics;
    private RaidAnalytics raidAnalytics;
'@
$new = @'
    private MiningAnalytics miningAnalytics;
    private RaidAnalytics raidAnalytics;
    private GatewayWatchdog gatewayWatchdog;
    private DiagnosticsExporter diagnosticsExporter;
'@
$c = $c.Replace($old, $new)

# ── Plugin: creation in onEnable ───────────────────────────────────────────
$old = @'
            asyncPool = new BoundedTaskExecutor(asyncThreads, 512, "BaseHider-Async", metrics);
            metrics.setAsyncThreads(asyncThreads);
'@
$new = @'
            asyncPool = new BoundedTaskExecutor(asyncThreads, 512, "BaseHider-Async", metrics);
            metrics.setAsyncThreads(asyncThreads);
            gatewayWatchdog = new GatewayWatchdog(300_000L);
            diagnosticsExporter = new DiagnosticsExporter(this, getDataFolder().toPath());
'@
$c = $c.Replace($old, $new)

$old = @'
            scheduleRuntimeWarmup();
            logStartupSummary();
'@
$new = @'
            scheduleRuntimeWarmup();
            diagnosticsExporter.start();
            logStartupSummary();
'@
$c = $c.Replace($old, $new)

# ── Plugin: stop exporter on disable ───────────────────────────────────────
$old = @'
        if (packetGateway != null) {
            packetGateway.shutdown();
        }
'@
$new = @'
        if (diagnosticsExporter != null) {
            diagnosticsExporter.stop();
        }
        if (packetGateway != null) {
            packetGateway.shutdown();
        }
'@
$c = $c.Replace($old, $new)

# ── Plugin: watchdog check each second ─────────────────────────────────────
$old = @'
            if (tickCounter % 20 == 0) {
                refreshViewerSessions();
                processReconciliation();
            }
'@
$new = @'
            if (tickCounter % 20 == 0) {
                refreshViewerSessions();
                processReconciliation();
                checkGatewayHealth();
            }
'@
$c = $c.Replace($old, $new)

# ── Plugin: checkGatewayHealth method after refreshViewerSessions ──────────
$old = @'
    private void processReconciliation() {
'@
$new = @'
    /**
     * Operational watchdog: warns (once per episode) when block protection is active and
     * viewers are online but the gateway has seen no chunk/block packet for 5 minutes, or
     * when the packet-detected position bridge overflows its bound. Both indicate a
     * configuration/version problem rather than a normal idle server; neither changes the
     * fail-closed packet behaviour.
     */
    private void checkGatewayHealth() {
        if (gatewayWatchdog == null || packetGateway == null) {
            return;
        }
        long signature = metrics.chunkPacketsSanitized()
                + metrics.chunkPacketsPassed()
                + metrics.chunkPacketsBlockedFailClosed()
                + metrics.blockChangesFaked()
                + metrics.blockEntityPacketsBlocked()
                + metrics.blockActionPacketsBlocked()
                + metrics.itemSpawnPacketsBlocked();
        GatewayWatchdog.Event event = gatewayWatchdog.update(System.currentTimeMillis(), signature,
                sessions.size(), blockProtectionActive, packetGateway.detectedOverflowCount());
        if (event == GatewayWatchdog.Event.STALE_ACTIVITY) {
            getLogger().severe("Packet gateway has processed no chunk/block packets for "
                    + (gatewayWatchdog.silentForMs(System.currentTimeMillis()) / 1000)
                    + "s while block protection is active and players are online. Check that "
                    + "PacketEvents " + "is installed/enabled and listeners are registered; block "
                    + "protection may be ineffective (fail-closed chunk/block data is still not "
                    + "sent, but verify in /basehider diag).");
            alertAdmins("§c[BaseHider] §ePacket gateway appears inactive while players are online - "
                    + "check PacketEvents (see console).");
        } else if (event == GatewayWatchdog.Event.DETECTED_OVERFLOW) {
            getLogger().severe("Packet-detected protected-block bridge overflowed ("
                    + packetGateway.detectedOverflowCount() + " dropped entries). Chunk data is "
                    + "still sanitized; block updates for the dropped positions may be delayed "
                    + "until reconciliation runs.");
            alertAdmins("§c[BaseHider] §eDetected-block bridge overflow - see console.");
        }
    }

    private void processReconciliation() {
'@
$c = $c.Replace($old, $new)

# ── Plugin: getters ────────────────────────────────────────────────────────
$old = @'
    public BoundedTaskExecutor asyncPool() { return asyncPool; }
'@
$new = @'
    public BoundedTaskExecutor asyncPool() { return asyncPool; }

    public GatewayWatchdog gatewayWatchdog() { return gatewayWatchdog; }

    public DiagnosticsExporter diagnosticsExporter() { return diagnosticsExporter; }
'@
$c = $c.Replace($old, $new)

[System.IO.File]::WriteAllText($pluginFile, $c)
Write-Host 'plugin wiring done'

# ── Command: export subcommand + diag lines ────────────────────────────────
$c = [System.IO.File]::ReadAllText($commandFile)
$old = @'
            case "diag" -> diag(sender);
'@
$new = @'
            case "diag" -> diag(sender);
            case "export" -> export(sender);
'@
$c = $c.Replace($old, $new)

$old = @'
        sender.sendMessage("§7Gateway: §f" + plugin.packetGateway().diagnostics());
'@
$new = @'
        sender.sendMessage("§7Gateway: §f" + plugin.packetGateway().diagnostics());
        sender.sendMessage("§7Maintenance: §f"
                + (plugin.diagnosticsExporter() == null ? "n/a" : plugin.diagnosticsExporter().diagnostics())
                + " §7| item storms: §f" + metrics.itemStormBatches()
                + " maxDepth=" + metrics.itemStormMaxDepth());
        sender.sendMessage("§7Gateway watchdog: silent="
                + (plugin.gatewayWatchdog() == null ? "n/a"
                : plugin.gatewayWatchdog().silentForMs(System.currentTimeMillis()) + "ms")
                + " §7| detected pending/overflow: §f" + plugin.packetGateway().detectedPendingCount()
                + "/" + plugin.packetGateway().detectedOverflowCount());
'@
$c = $c.Replace($old, $new)

$old = @'
    private void deep(CommandSender sender) {
'@
$new = @'
    private void export(CommandSender sender) {
        var exporter = plugin.diagnosticsExporter();
        if (exporter == null) {
            sender.sendMessage("§cMaintenance exporter is not available.");
            return;
        }
        exporter.collectAndSubmit();
        sender.sendMessage("§7Diagnostics snapshot scheduled asynchronously: §f" + exporter.outputFile());
    }

    private void deep(CommandSender sender) {
'@
$c = $c.Replace($old, $new)
[System.IO.File]::WriteAllText($commandFile, $c)
Write-Host 'command wiring done'

# plugin.yml usage/tab completion mention export (usage string only if present)
$yml = 'D:\Basehider\basehider-v3-integrated\src\main\resources\plugin.yml'
$y = [System.IO.File]::ReadAllText($yml)
$y = $y.Replace('status|diag|deep|stats|verify|rescan|reload|help', 'status|diag|export|deep|stats|verify|rescan|reload|help')
[System.IO.File]::WriteAllText($yml, $y)
Write-Host 'plugin.yml usage updated'
