$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider\basehider-v3-integrated'

# ── WorldSettings: YShield record + field ─────────────────────────────────
$f = "$base\src\main\java\dev\audismp\basehider\config\WorldSettings.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('    public record PlayerProtection(', @'
    /**
     * Distance-only Y-level shield: when the viewer is above {@code hideBelowY}, chunks
     * farther than {@code realChunkRadius} chunks have every section below {@code hideBelowY}
     * replaced by a solid filler, hiding caves and underground bases from the surface view.
     */
    public record YShield(boolean enabled, int hideBelowY, int realChunkRadius, Material filler) {
        public static YShield disabled() {
            return new YShield(false, 40, 4, Material.STONE);
        }
    }

    public record PlayerProtection(
'@)
$c = $c.Replace('    private final PlayerProtection playerProtection;',
@'
    private final PlayerProtection playerProtection;
    private final YShield yShield;
'@)
$c = $c.Replace('                         BlockProtection blockProtection, ItemProtection itemProtection,
                         PlayerProtection playerProtection) {
        this.enabled = enabled;
        this.bypassPermission = bypassPermission;
        this.blockProtection = blockProtection;
        this.itemProtection = itemProtection;
        this.playerProtection = playerProtection;
    }',
@'
                         BlockProtection blockProtection, ItemProtection itemProtection,
                         PlayerProtection playerProtection, YShield yShield) {
        this.enabled = enabled;
        this.bypassPermission = bypassPermission;
        this.blockProtection = blockProtection;
        this.itemProtection = itemProtection;
        this.playerProtection = playerProtection;
        this.yShield = yShield;
    }'
@)
$c = $c.Replace('                new ItemProtection(false, Collections.<EntityType>emptySet(), 32.0, 130.0, true, 2),
                PlayerProtection.disabled());',
@'
                new ItemProtection(false, Collections.<EntityType>emptySet(), 32.0, 130.0, true, 2),
                PlayerProtection.disabled(), YShield.disabled());'
@)
$c = $c.Replace('    public PlayerProtection playerProtection() {
        return playerProtection;
    }',
@'
    public PlayerProtection playerProtection() {
        return playerProtection;
    }

    public YShield yShield() {
        return yShield;
    }
'@)
[IO.File]::WriteAllText($f, $c)

# ── ConfigLoader: parse y-shield + constructor args ──────────────────────
$f = "$base\src\main\java\dev\audismp\basehider\config\ConfigLoader.java"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('        return new WorldSettings(enabled, bypassPermission, blockProtection, itemProtection,
                playerProtection);',
@'
        ConfigurationSection ySection = section.getConfigurationSection("y-shield");
        boolean yEnabled = ySection != null && ySection.getBoolean("enabled", false);
        int yBelow = ySection != null
                ? clampInt(ySection.getInt("hide-below-y", 40), -256, 512,
                warnings, worldName, "y-shield.hide-below-y")
                : 40;
        int yRadius = ySection != null
                ? clampInt(ySection.getInt("real-chunk-radius", 4), 0, 16,
                warnings, worldName, "y-shield.real-chunk-radius")
                : 4;
        String rawYFiller = ySection != null ? ySection.getString("filler", "STONE") : "STONE";
        Material yFiller = parseMaterial(rawYFiller, Material.STONE, warnings, worldName,
                "y-shield.filler");
        WorldSettings.YShield yShield = new WorldSettings.YShield(yEnabled, yBelow, yRadius, yFiller);

        return new WorldSettings(enabled, bypassPermission, blockProtection, itemProtection,
                playerProtection, yShield);
'@)
$c = $c.Replace('builtinItemProtection(warnings, worldName), WorldSettings.PlayerProtection.disabled())',
                'builtinItemProtection(warnings, worldName), WorldSettings.PlayerProtection.disabled(), WorldSettings.YShield.disabled())')
[IO.File]::WriteAllText($f, $c)
Write-Host 'Y shield config records updated'
