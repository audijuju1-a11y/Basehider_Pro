package dev.audismp.basehider.config;

import org.bukkit.Material;
import org.bukkit.entity.EntityType;

import java.util.Collections;
import java.util.EnumSet;
import java.util.Set;

/**
 * Immutable per-world visibility policy. Built by {@link ConfigLoader} and replaced
 * atomically on {@code /basehider reload}.
 */
public final class WorldSettings {

    public record BlockProtection(
            boolean enabled,
            Set<Material> hiddenMaterials,
            Material replaceWith,
            boolean contextualFiller,
            double revealDistance,
            double fovDegrees,
            double keepDistanceFactor,
            int recheckMoveBlocks,
            boolean reconcileEnabled,
            int reconcileChunksPerSecond,
            int reconcilePlayerRadiusChunks
    ) {
        public boolean isHiddenMaterial(Material material) {
            return enabled && hiddenMaterials.contains(material);
        }

        /** Cosine of the half field-of-view angle; 1.0 when FOV >= 360. */
        public double fovCosHalf() {
            double half = Math.min(180.0, fovDegrees) / 2.0;
            return Math.cos(Math.toRadians(half));
        }
    }

    public record ItemProtection(
            boolean enabled,
            Set<EntityType> hiddenEntityTypes,
            double revealDistance,
            double fovDegrees,
            boolean ownerGrace,
            int updateIntervalTicks
    ) {
        public boolean isHiddenType(EntityType type) {
            return enabled && hiddenEntityTypes.contains(type);
        }

        public double fovCosHalf() {
            double half = Math.min(180.0, fovDegrees) / 2.0;
            return Math.cos(Math.toRadians(half));
        }
    }

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
            boolean enabled,
            double hideDistance,
            double alwaysVisibleDistance,
            double fovDegrees,
            boolean requireLineOfSight,
            boolean teamAware,
            int combatGraceSeconds,
            int updateIntervalTicks
    ) {
        public double fovCosHalf() {
            double half = Math.min(180.0, fovDegrees) / 2.0;
            return Math.cos(Math.toRadians(half));
        }

        public static PlayerProtection disabled() {
            return new PlayerProtection(false, 48.0, 24.0, 120.0, true, true, 8, 4);
        }
    }

    /**
     * Tunnel/dug-hole shield: blocks mined by players are remembered with their original
     * material. A viewer farther than {@code hideRadius} blocks receives the original block
     * instead of the new air, so a distant cheat client cannot see player-dug tunnels. When
     * the viewer approaches, the real air is revealed.
     */
    public record TunnelShield(boolean enabled, double hideRadius, int maxTrackedBreaks) {
        public static TunnelShield disabled() {
            return new TunnelShield(false, 28.0, 50_000);
        }
    }

    private final boolean enabled;
    private final String bypassPermission;
    private final BlockProtection blockProtection;
    private final ItemProtection itemProtection;
    private final PlayerProtection playerProtection;
    private final YShield yShield;
    private final TunnelShield tunnelShield;

    public WorldSettings(boolean enabled, String bypassPermission,
                         BlockProtection blockProtection, ItemProtection itemProtection,
                         PlayerProtection playerProtection, YShield yShield,
                         TunnelShield tunnelShield) {
        this.enabled = enabled;
        this.bypassPermission = bypassPermission;
        this.blockProtection = blockProtection;
        this.itemProtection = itemProtection;
        this.playerProtection = playerProtection;
        this.yShield = yShield;
        this.tunnelShield = tunnelShield;
    }

    public static WorldSettings disabled(String bypassPermission) {
        return new WorldSettings(false, bypassPermission,
                new BlockProtection(false, Collections.emptySet(), Material.STONE, false,
                        12.0, 120.0, 1.6, 4, false, 40, 8),
                new ItemProtection(false, Collections.<EntityType>emptySet(), 32.0, 130.0, true, 2),
                PlayerProtection.disabled(), YShield.disabled(), TunnelShield.disabled());
    }

    public boolean isEnabled() {
        return enabled;
    }

    public String bypassPermission() {
        return bypassPermission;
    }

    public BlockProtection blockProtection() {
        return blockProtection;
    }

    public ItemProtection itemProtection() {
        return itemProtection;
    }

    public PlayerProtection playerProtection() {
        return playerProtection;
    }

    public YShield yShield() {
        return yShield;
    }

    public TunnelShield tunnelShield() {
        return tunnelShield;
    }

    /** Convenience: set of materials hidden in this world (empty when disabled). */
    public Set<Material> hiddenMaterials() {
        return blockProtection.enabled() ? blockProtection.hiddenMaterials() : Collections.emptySet();
    }

    public Set<EntityType> hiddenEntityTypes() {
        return itemProtection.enabled() ? itemProtection.hiddenEntityTypes() : Collections.<EntityType>emptySet();
    }

    public boolean blocksEnabled() {
        return enabled && blockProtection.enabled() && !blockProtection.hiddenMaterials().isEmpty();
    }

    public boolean itemsEnabled() {
        return enabled && itemProtection.enabled() && !itemProtection.hiddenEntityTypes().isEmpty();
    }

    public static Set<Material> copyMaterials(Set<Material> source) {
        return source.isEmpty() ? Collections.emptySet() : Collections.unmodifiableSet(EnumSet.copyOf(source));
    }

    public static Set<EntityType> copyEntityTypes(Set<EntityType> source) {
        return source.isEmpty() ? Collections.emptySet() : Collections.unmodifiableSet(EnumSet.copyOf(source));
    }
}
