$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider\basehider-v3-integrated'
$f = "$base\src\main\java\dev\audismp\basehider\BaseHiderPlugin.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('import dev.audismp.basehider.packet.PacketGateway;',
                "import dev.audismp.basehider.packet.PacketGateway;`nimport dev.audismp.basehider.player.PlayerShield;")
$c = $c.Replace('    private ItemShield itemShield;
    private BlockShield blockShield;',
@'
    private ItemShield itemShield;
    private BlockShield blockShield;
    private PlayerShield playerShield;
    private OcclusionEngine occlusionEngine;
'@)
$c = $c.Replace('            OcclusionEngine occlusionEngine = new OcclusionEngine(
                    new PaperRayTracer(this::config, metrics));
            itemShield = new ItemShield(this, metrics, sessions, occlusionEngine);
            blockShield = new BlockShield(this, metrics, sessions, hiddenBlockIndex,
                    occlusionEngine, blockVisibility);',
@'
            occlusionEngine = new OcclusionEngine(new PaperRayTracer(this::config, metrics));
            itemShield = new ItemShield(this, metrics, sessions, occlusionEngine);
            blockShield = new BlockShield(this, metrics, sessions, hiddenBlockIndex,
                    occlusionEngine, blockVisibility);
            playerShield = new PlayerShield(this, metrics, occlusionEngine);
'@)
$c = $c.Replace('            itemShield.tick(TimeBudget.ofMillis(budgetMs * 0.45), tickCounter);
            blockShield.tick(TimeBudget.ofMillis(budgetMs * 0.55), tickCounter);',
@'
            itemShield.tick(TimeBudget.ofMillis(budgetMs * 0.45), tickCounter);
            blockShield.tick(TimeBudget.ofMillis(budgetMs * 0.55), tickCounter);
            playerShield.tick(TimeBudget.ofMillis(budgetMs * 0.10));
'@)
$c = $c.Replace('        if (itemShield != null) {
            // Put every entity back to normal visibility so a reload/disable does not
            // leave stuck invisible entities.
            try {
                itemShield.shutdownRestoreVisibility();
            } catch (Throwable throwable) {
                getLogger().log(Level.WARNING, "Failed to restore entity visibility on disable", throwable);
            }
        }',
@'
        if (playerShield != null) {
            try {
                playerShield.shutdownRestoreVisibility();
            } catch (Throwable throwable) {
                getLogger().log(Level.WARNING, "Failed to restore player visibility on disable", throwable);
            }
        }
        if (itemShield != null) {
            // Put every entity back to normal visibility so a reload/disable does not
            // leave stuck invisible entities.
            try {
                itemShield.shutdownRestoreVisibility();
            } catch (Throwable throwable) {
                getLogger().log(Level.WARNING, "Failed to restore entity visibility on disable", throwable);
            }
        }
'@)
$c = $c.Replace('    public ItemShield itemShield() { return itemShield; }',
@'
    public ItemShield itemShield() { return itemShield; }

    public PlayerShield playerShield() { return playerShield; }

    public OcclusionEngine occlusionEngine() { return occlusionEngine; }
'@)
$c = $c.Replace('        itemShield.reconfigure();',
@'
        itemShield.reconfigure();
        if (playerShield != null) {
            playerShield.shutdownRestoreVisibility();
        }
'@)
[IO.File]::WriteAllText($f, $c)
Write-Host 'plugin wired for PlayerShield'
