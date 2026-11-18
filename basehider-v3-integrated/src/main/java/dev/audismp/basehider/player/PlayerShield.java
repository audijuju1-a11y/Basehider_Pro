package dev.audismp.basehider.player;

import dev.audismp.basehider.BaseHiderPlugin;
import dev.audismp.basehider.config.WorldSettings;
import dev.audismp.basehider.core.TimeBudget;
import dev.audismp.basehider.metrics.Metrics;
import dev.audismp.basehider.occlusion.OcclusionEngine;
import org.bukkit.entity.Player;
import org.bukkit.scoreboard.Team;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Level;

/**
 * Anti player-ESP engine. Uses Paper's per-player visibility API (hideEntity/showEntity) so
 * a cheat client never receives the spawn/metadata packets for a player it is not allowed
 * to see. Server-side gameplay (combat, teams, tab list, commands) is untouched.
 *
 * <p>Policy (see {@link PlayerVisibilityPolicy}): close players are always visible, same
 * team and combat pairs are always visible, and the 24..48 block band is hidden unless the
 * target is inside the FOV with a clear line of sight. This removes through-wall player ESP
 * while avoiding invisible close-range fights.
 */
public final class PlayerShield {

    private static final long COMBAT_PAIR_TTL_MS = 30_000L;

    private final BaseHiderPlugin plugin;
    private final Metrics metrics;
    private final OcclusionEngine occlusion;
    private final Map<UUID, Set<UUID>> hiddenByViewer = new HashMap<>();
    private final Map<Long, Long> combatUntilMs = new HashMap<>();
    private int viewerCursor;

    public PlayerShield(BaseHiderPlugin plugin, Metrics metrics, OcclusionEngine occlusion) {
        this.plugin = plugin;
        this.metrics = metrics;
        this.occlusion = occlusion;
    }

    /** Called by the damage listener for a player-vs-player hit. */
    public void markCombat(Player first, Player second) {
        if (first == null || second == null || first.getUniqueId().equals(second.getUniqueId())) {
            return;
        }
        long key = pairKey(first.getUniqueId(), second.getUniqueId());
        WorldSettings settings = plugin.config().world(first.getWorld().getName());
        int grace = settings.playerProtection().combatGraceSeconds();
        if (grace <= 0) {
            return;
        }
        combatUntilMs.put(key, System.currentTimeMillis() + grace * 1000L);
    }

    public void onViewerQuit(UUID viewerId) {
        hiddenByViewer.remove(viewerId);
    }

    /** Main thread, budgeted. Processes one viewer per call in round-robin order. */
    public void tick(TimeBudget budget) {
        List<Player> online = new ArrayList<>(plugin.getServer().getOnlinePlayers());
        if (online.size() < 2) {
            return;
        }
        int processed = 0;
        int attempts = 0;
        while (attempts < online.size() && processed < 2) {
            Player viewer = online.get(viewerCursor % online.size());
            viewerCursor++;
            attempts++;
            if (viewer == null || !viewer.isOnline()) {
                continue;
            }
            WorldSettings settings = plugin.config().world(viewer.getWorld().getName());
            WorldSettings.PlayerProtection policy = settings.playerProtection();
            if (!policy.enabled()) {
                restoreViewer(viewer);
                processed++;
                continue;
            }
            evaluateViewer(viewer, settings, policy, online);
            processed++;
            if (budget.expired()) {
                break;
            }
        }
    }

    private void evaluateViewer(Player viewer, WorldSettings settings,
                                WorldSettings.PlayerProtection policy, List<Player> online) {
        boolean bypass = viewer.hasPermission(settings.bypassPermission());
        Set<UUID> hidden = hiddenByViewer.computeIfAbsent(viewer.getUniqueId(), id -> new HashSet<>());
        var eye = viewer.getEyeLocation();
        double lookX = eye.getDirection().getX();
        double lookY = eye.getDirection().getY();
        double lookZ = eye.getDirection().getZ();
        double fovCos = policy.fovCosHalf();
        for (Player target : online) {
            if (target == null || !target.isOnline() || target.getUniqueId().equals(viewer.getUniqueId())) {
                continue;
            }
            if (!target.getWorld().equals(viewer.getWorld())) {
                // Different worlds are not tracked; make sure no stale hide remains.
                if (hidden.remove(target.getUniqueId())) {
                    viewer.showEntity(plugin, target);
                }
                continue;
            }
            double centerX = target.getX();
            double centerY = target.getY() + target.getHeight() * 0.5;
            double centerZ = target.getZ();
            double dx = centerX - eye.getX();
            double dy = centerY - eye.getY();
            double dz = centerZ - eye.getZ();
            double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

            boolean sameTeam = policy.teamAware() && sameTeam(viewer, target);
            boolean combatGrace = isCombatGrace(viewer.getUniqueId(), target.getUniqueId());
            boolean inFov = OcclusionEngine.insideFov(eye.getX(), eye.getY(), eye.getZ(),
                    lookX, lookY, lookZ, centerX, centerY, centerZ, fovCos);
            boolean lineOfSight = true;
            if (!bypass && !sameTeam && !combatGrace
                    && distance > policy.alwaysVisibleDistance()
                    && distance <= policy.hideDistance() && inFov) {
                lineOfSight = occlusion.hasLineOfSight(viewer.getWorld(), eye.getX(), eye.getY(),
                        eye.getZ(), centerX, centerY, centerZ);
            }
            PlayerVisibilityPolicy.Action action = PlayerVisibilityPolicy.decide(bypass, sameTeam,
                    combatGrace, distance, policy.alwaysVisibleDistance(), policy.hideDistance(),
                    inFov, lineOfSight, policy.requireLineOfSight());
            if (action == PlayerVisibilityPolicy.Action.HIDE) {
                if (hidden.add(target.getUniqueId())) {
                    metrics.recordPlayerHidden();
                    try {
                        viewer.hideEntity(plugin, target);
                    } catch (RuntimeException ex) {
                        hidden.remove(target.getUniqueId());
                        metrics.recordInternalError();
                        if (plugin.config().debug().verboseErrors()) {
                            plugin.getLogger().log(Level.WARNING,
                                    "Failed to hide player entity; fail-closed", ex);
                        }
                    }
                }
            } else if (hidden.remove(target.getUniqueId())) {
                metrics.recordPlayerShown();
                try {
                    viewer.showEntity(plugin, target);
                } catch (RuntimeException ex) {
                    metrics.recordInternalError();
                    if (plugin.config().debug().verboseErrors()) {
                        plugin.getLogger().log(Level.WARNING, "Failed to show player entity", ex);
                    }
                }
            }
        }
    }

    private boolean sameTeam(Player first, Player second) {
        Team firstTeam = first.getScoreboard().getEntryTeam(first.getName());
        if (firstTeam == null) {
            return false;
        }
        Team secondTeam = second.getScoreboard().getEntryTeam(second.getName());
        return secondTeam != null && firstTeam.getName().equals(secondTeam.getName());
    }

    private boolean isCombatGrace(UUID first, UUID second) {
        Long until = combatUntilMs.get(pairKey(first, second));
        if (until == null) {
            return false;
        }
        if (until < System.currentTimeMillis()) {
            combatUntilMs.remove(pairKey(first, second));
            return false;
        }
        return true;
    }

    private static long pairKey(UUID first, UUID second) {
        long high = first.getMostSignificantBits() ^ second.getMostSignificantBits();
        long low = first.getLeastSignificantBits() ^ second.getLeastSignificantBits();
        return high * 31L + low;
    }

    private void restoreViewer(Player viewer) {
        Set<UUID> hidden = hiddenByViewer.remove(viewer.getUniqueId());
        if (hidden == null || hidden.isEmpty()) {
            return;
        }
        for (UUID targetId : hidden) {
            Player target = plugin.getServer().getPlayer(targetId);
            if (target != null && target.isOnline()) {
                try {
                    viewer.showEntity(plugin, target);
                } catch (RuntimeException ex) {
                    metrics.recordInternalError();
                }
            }
        }
    }

    /** Plugin disable/reload: restore vanilla visibility for every hidden pair. */
    public void shutdownRestoreVisibility() {
        for (Map.Entry<UUID, Set<UUID>> entry : hiddenByViewer.entrySet()) {
            Player viewer = plugin.getServer().getPlayer(entry.getKey());
            if (viewer == null) {
                continue;
            }
            for (UUID targetId : new ArrayList<>(entry.getValue())) {
                Player target = plugin.getServer().getPlayer(targetId);
                if (target != null && target.isOnline()) {
                    try {
                        viewer.showEntity(plugin, target);
                    } catch (RuntimeException ex) {
                        metrics.recordInternalError();
                    }
                }
            }
        }
        hiddenByViewer.clear();
        combatUntilMs.clear();
    }

    public int hiddenPairCount() {
        int count = 0;
        for (Set<UUID> hidden : hiddenByViewer.values()) {
            count += hidden.size();
        }
        return count;
    }

    public String diagnostics() {
        return "hiddenPairs=" + hiddenPairCount() + " combatPairs=" + combatUntilMs.size();
    }
}
