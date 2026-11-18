package dev.audismp.basehider.index;

import dev.audismp.basehider.BaseHiderPlugin;
import dev.audismp.basehider.config.WorldSettings;
import dev.audismp.basehider.core.WorldKeys;
import dev.audismp.basehider.metrics.Metrics;
import dev.audismp.basehider.util.BlockPosUtil;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import org.bukkit.Chunk;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.BlockState;

import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Deque;

/**
 * Discovers protected blocks from real world data.
 *
 * <p>Natural structures (dungeon spawners, village/stronghold chests, trial chambers, ...)
 * are discovered from the chunk's block entities whenever a chunk is loaded and by a
 * low-rate reconciliation sweep. Player placement/breaking is handled by block events;
 * the sweep exists to catch plugins/commands/mechanics that bypass Bukkit events.
 *
 * <p>All methods are main-thread only. The sweep queue is bounded; overflow drops the
 * enqueue request (the next sweep cycle will enqueue the chunk again), never protection
 * state (state is cleared only by explicit chunk re-discovery).
 */
public final class BlockDiscovery {

    private static final int MAX_PENDING_CHUNKS = 16_384;
    private static final int MAX_CHUNKS_PER_STEP_DEFAULT = 24;

    private final BaseHiderPlugin plugin;
    private final HiddenBlockIndex index;
    private final Metrics metrics;

    private final Deque<ChunkRequest> queue = new ArrayDeque<>();
    private final LongOpenHashSet pending = new LongOpenHashSet();

    /** Receives the before/after protected-block sets of every sweep-processed chunk. */
    @FunctionalInterface
    public interface ChunkSweepListener {
        void onChunkSwept(World world, Chunk chunk, long[] before, long[] after);
    }

    private volatile ChunkSweepListener sweepListener;

    private record ChunkRequest(World world, int chunkX, int chunkZ) {
    }

    public BlockDiscovery(BaseHiderPlugin plugin, HiddenBlockIndex index, Metrics metrics) {
        this.plugin = plugin;
        this.index = index;
        this.metrics = metrics;
    }

    public void setSweepListener(ChunkSweepListener listener) {
        this.sweepListener = listener;
    }

    /**
     * Immediately re-discovers one chunk. Called on ChunkLoadEvent (natural blocks!) and
     * by the reconciliation sweep. Returns the number of protected blocks in the chunk.
     */
    public int discoverChunkNow(World world, int chunkX, int chunkZ) {
        WorldSettings settings = plugin.config().world(world.getName());
        if (!settings.blocksEnabled()) {
            return 0;
        }
        // Note: during ChunkLoadEvent the chunk is in the middle of loading; isChunkLoaded()
        // can still report false there, so this path must not re-check it.
        Chunk chunk = world.getChunkAt(chunkX, chunkZ);
        return discoverChunk(chunk, settings);
    }

    private int discoverChunk(Chunk chunk, WorldSettings settings) {
        World world = chunk.getWorld();
        long worldId = WorldKeys.idOf(world);
        HiddenBlockIndex.ChunkView before = index.chunkView(worldId, chunk.getX(), chunk.getZ());
        LongOpenHashSet found = new LongOpenHashSet(16);
        boolean fillerChanged = false;
        try {
            BlockState[] tileEntities = chunk.getTileEntities();
            boolean contextual = settings.blockProtection().contextualFiller();
            for (BlockState state : tileEntities) {
                if (state == null) {
                    continue;
                }
                if (!settings.blockProtection().isHiddenMaterial(state.getType())) {
                    continue;
                }
                long pos = BlockPosUtil.encode(state.getX(), state.getY(), state.getZ());
                found.add(pos);
                if (contextual) {
                    Material previousFiller = index.filler(worldId, pos, null);
                    Material filler = FillerChooser.choose(world, state.getX(), state.getY(),
                            state.getZ(), settings.blockProtection().hiddenMaterials(),
                            settings.blockProtection().replaceWith());
                    if (previousFiller != filler) {
                        fillerChanged = true;
                    }
                    index.setFiller(worldId, pos, filler);
                }
            }
        } catch (RuntimeException ex) {
            // A broken chunk must not invalidate protection data for it: keep the existing
            // entries and report. Protection state is never cleared on errors.
            metrics.recordInternalError();
            if (plugin.config().debug().verboseErrors()) {
                plugin.getLogger().warning("Block discovery failed for chunk "
                        + chunk.getX() + "," + chunk.getZ() + ": " + ex);
            }
            return 0;
        }
        int changes = index.replaceChunk(worldId, chunk.getX(), chunk.getZ(), found);
        if (changes > 0 || fillerChanged) {
            ChunkSweepListener listener = sweepListener;
            if (listener != null) {
                HiddenBlockIndex.ChunkView after = index.chunkView(worldId, chunk.getX(), chunk.getZ());
                listener.onChunkSwept(world, chunk,
                        before == null ? null : before.positions(),
                        after == null ? null : after.positions());
            }
        }
        return found.size();
    }

    /** Schedules a chunk for (re-)discovery on a later tick. Main thread only. */
    public void enqueue(World world, int chunkX, int chunkZ) {
        long worldId = WorldKeys.idOf(world);
        long chunkKey = BlockPosUtil.chunkKey(worldId, chunkX, chunkZ);
        if (pending.size() >= MAX_PENDING_CHUNKS) {
            return;
        }
        if (!pending.add(chunkKey)) {
            return;
        }
        queue.addLast(new ChunkRequest(world, chunkX, chunkZ));
    }

    /** Schedules all currently loaded chunks around a player (bounded). */
    public void enqueueAround(World world, int centerChunkX, int centerChunkZ, int radiusChunks) {
        int radius = Math.max(1, Math.min(16, radiusChunks));
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                int cx = centerChunkX + dx;
                int cz = centerChunkZ + dz;
                if (world.isChunkLoaded(cx, cz)) {
                    enqueue(world, cx, cz);
                }
            }
        }
    }

    /** Startup sweep: spawn area of every enabled world. */
    public void enqueueSpawnAreas(Collection<World> worlds, int radiusChunks) {
        for (World world : worlds) {
            WorldSettings settings = plugin.config().world(world.getName());
            if (!settings.blocksEnabled()) {
                continue;
            }
            enqueueSpawnArea(world, radiusChunks);
        }
    }

    public void enqueueSpawnArea(World world) {
        enqueueSpawnArea(world, 2);
    }

    public void enqueueSpawnArea(World world, int radiusChunks) {
        WorldSettings settings = plugin.config().world(world.getName());
        if (!settings.blocksEnabled()) {
            return;
        }
        int cx = world.getSpawnLocation().getBlockX() >> 4;
        int cz = world.getSpawnLocation().getBlockZ() >> 4;
        enqueueAround(world, cx, cz, radiusChunks);
    }

    /**
     * Enqueues every currently loaded chunk of the given worlds (bounded by the pending
     * queue cap). Used on enable/reload so chunks that were loaded before BaseHider was
     * active are discovered before their packets are sent.
     */
    public int enqueueAllLoaded(Collection<World> worlds) {
        int enqueued = 0;
        for (World world : worlds) {
            WorldSettings settings = plugin.config().world(world.getName());
            if (!settings.blocksEnabled()) {
                continue;
            }
            for (Chunk chunk : world.getLoadedChunks()) {
                if (pending.size() >= MAX_PENDING_CHUNKS) {
                    plugin.getLogger().warning("Discovery queue full (" + MAX_PENDING_CHUNKS
                            + " chunks); remaining loaded chunks will be discovered by the "
                            + "reconciliation sweep.");
                    return enqueued;
                }
                enqueue(world, chunk.getX(), chunk.getZ());
                enqueued++;
            }
        }
        return enqueued;
    }

    /** Processes up to {@code maxChunks} queued chunks. Returns chunks processed. */
    public int processQueue(int maxChunks) {
        int budget = Math.max(1, maxChunks);
        int processed = 0;
        while (processed < budget) {
            ChunkRequest request = queue.pollFirst();
            if (request == null) {
                break;
            }
            long worldId = WorldKeys.idOf(request.world());
            long chunkKey = BlockPosUtil.chunkKey(worldId, request.chunkX(), request.chunkZ());
            pending.remove(chunkKey);
            WorldSettings settings = plugin.config().world(request.world().getName());
            if (!settings.blocksEnabled()) {
                continue;
            }
            if (!request.world().isChunkLoaded(request.chunkX(), request.chunkZ())) {
                continue;
            }
            discoverChunk(request.world().getChunkAt(request.chunkX(), request.chunkZ()), settings);
            processed++;
        }
        return processed;
    }

    public int processQueue() {
        return processQueue(MAX_CHUNKS_PER_STEP_DEFAULT);
    }

    public int pendingCount() {
        return queue.size();
    }

    public void clearQueue() {
        queue.clear();
        pending.clear();
    }
}
