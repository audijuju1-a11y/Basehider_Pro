$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider\basehider-v3-integrated'

# Metrics counters
$f = "$base\src\main\java\dev\audismp\basehider\metrics\Metrics.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('    private final LongAdder packetsObserved = new LongAdder();',
@'
    private final LongAdder packetsObserved = new LongAdder();
    private final LongAdder playersHidden = new LongAdder();
    private final LongAdder playersShown = new LongAdder();
'@)
$c = $c.Replace('    public void recordPacketObserved() { packetsObserved.increment(); }',
@'
    public void recordPacketObserved() { packetsObserved.increment(); }
    public void recordPlayerHidden() { playersHidden.increment(); }
    public void recordPlayerShown() { playersShown.increment(); }
'@)
$c = $c.Replace('    public long packetsObserved() { return packetsObserved.sum(); }',
@'
    public long packetsObserved() { return packetsObserved.sum(); }
    public long playersHidden() { return playersHidden.sum(); }
    public long playersShown() { return playersShown.sum(); }
'@)
[IO.File]::WriteAllText($f, $c)

# PlayerListener combat + quit cleanup
$f = "$base\src\main\java\dev\audismp\basehider\listener\PlayerListener.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('import org.bukkit.event.player.PlayerTeleportEvent;',
                "import org.bukkit.event.player.PlayerTeleportEvent;`nimport org.bukkit.event.entity.EntityDamageByEntityEvent;")
$c = $c.Replace('        plugin.sessions().remove(player.getUniqueId());',
@'
        plugin.playerShield().onViewerQuit(player.getUniqueId());
        plugin.sessions().remove(player.getUniqueId());
'@)
$c = $c.Replace('    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {',
@'
    /** Player-vs-player combat keeps both parties visible for the configured grace period. */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerDamage(EntityDamageByEntityEvent event) {
        if (event.getEntity() instanceof Player victim && event.getDamager() instanceof Player attacker) {
            plugin.playerShield().markCombat(attacker, victim);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
'@)
[IO.File]::WriteAllText($f, $c)

# status line + diag
$f = "$base\src\main\java\dev\audismp\basehider\command\BaseHiderCommand.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('        sender.sendMessage("§7Protected blocks: §f" + plugin.hiddenBlockIndex().totalBlockCount()',
@'
        sender.sendMessage("§7Player protection: §f"
                + (plugin.playerShield() == null ? "n/a" : plugin.playerShield().diagnostics())
                + " §7| hidden total: §f" + (plugin.metrics() == null ? 0 : plugin.metrics().playersHidden()));
        sender.sendMessage("§7Protected blocks: §f" + plugin.hiddenBlockIndex().totalBlockCount()
'@)
[IO.File]::WriteAllText($f, $c)
Write-Host 'listener/metrics/status wired'
