package dev.audismp.aegishider.packet;

import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.chunk.BaseChunk;
import com.github.retrooper.packetevents.protocol.world.chunk.Column;
import com.github.retrooper.packetevents.protocol.world.chunk.TileEntity;
import dev.audismp.aegishider.index.HiddenBlockIndex;
import dev.audismp.aegishider.util.BlockPosUtil;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import org.bukkit.Material;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Removes protected blocks and their block-entity data from an outgoing chunk column
 * BEFORE the packet is written to the client.
 *
 * <p>Two sources of protected positions are combined:
 * <ol>
 *   <li>the {@link HiddenBlockIndex} view of the chunk (event/discovery driven), and</li>
 *   <li>the chunk's own block-entity list: every block entity whose block state resolves to
 *       a configured protected material is replaced and reported back as "detected".</li>
 * </ol>
 *
 * <p>The second source is what makes the chunk path fail-closed with respect to blocks
 * changed by means that do not fire Bukkit events (WorldEdit/commands/plugins): even with a
 * stale index the client never receives the real container data, and the returned detected
 * positions let the main thread repair the index within one tick. Because every supported
 * protected material is tile-entity backed, a chunk without block entities cannot contain a
 * protected block - that chunk can be passed through without parsing.
 *
 * <p>The logic works on PacketEvents' neutral {@link Column}/{@link BaseChunk} model and is
 * covered by unit tests with synthetic chunks; no live server is required.
 */
public final class ChunkSanitizer {

    /** Maps a wire block state id to a material/type name and provides the filler state. */
    public interface StateIdMapper {
        /** @return e.g. {@code minecraft:chest}, or {@code chest}, or null if unknown. */
        String typeName(ClientVersion version, int stateId);

        int fillerStateId(ClientVersion version, Material fillerMaterial);

        /**
         * Maps a wire block-entity type id to its registry name (e.g. {@code chest}).
         * The block-entity list is independent of the block-state palette, so matching
         * on it strips protected containers even when a state id cannot be resolved.
         */
        default String tileEntityTypeName(ClientVersion version, int typeId) {
            return null;
        }
    }

    /** Resolves the per-position contextual filler material (may return the fixed fallback). */
    public interface FillerProvider {
        Material filler(long blockPos);
    }

    public record Result(int changedBlocks, TileEntity[] tileEntities, boolean rewritten,
                         long[] detectedPositions) {
        public static final Result UNCHANGED = new Result(0, null, false, new long[0]);

        public boolean hasDetectedPositions() {
            return detectedPositions.length > 0;
        }
    }

    private static final long[] NO_POSITIONS = new long[0];

    private ChunkSanitizer() {
    }

    public static Result sanitize(Column column, ClientVersion version, int minSectionY,
                                  HiddenBlockIndex.ChunkView currentView,
                                  HiddenBlockIndex.ChunkView previousView,
                                  Set<String> hiddenNames, Material filler, StateIdMapper mapper) {
        return sanitize(column, version, minSectionY, currentView, previousView, hiddenNames,
                filler, mapper, false);
    }

    /**
     * @param column           parsed outgoing chunk column (mutated in place for section data)
     * @param version          client protocol version of the receiver
     * @param minSectionY      first section index of the world (worldMinHeight >> 4)
     * @param currentView      protected blocks of this chunk in the viewer's current world
     * @param previousView     protected blocks of this chunk in the previous world during a
     *                         world transition (may be null); checked as fail-closed fallback
     * @param hiddenNames      bare lowercase material names that must be hidden
     * @param filler           replacement material
     * @param mapper           state-id ↔ name/filler resolver
     * @param scanTileEntities additionally hide any block entity backed protected block found
     *                         in the chunk itself (robust against a stale/empty index)
     */
    public static Result sanitize(Column column, ClientVersion version, int minSectionY,
                                  HiddenBlockIndex.ChunkView currentView,
                                  HiddenBlockIndex.ChunkView previousView,
                                  Set<String> hiddenNames, Material filler, StateIdMapper mapper,
                                  boolean scanTileEntities) {
        return sanitize(column, version, minSectionY, currentView, previousView, hiddenNames,
                filler, null, mapper, scanTileEntities);
    }

    /** Contextual-filler variant: {@code fillerProvider} may return a different material per position. */
    public static Result sanitize(Column column, ClientVersion version, int minSectionY,
                                  HiddenBlockIndex.ChunkView currentView,
                                  HiddenBlockIndex.ChunkView previousView,
                                  Set<String> hiddenNames, Material filler,
                                  FillerProvider fillerProvider, StateIdMapper mapper,
                                  boolean scanTileEntities) {
        return sanitize(column, version, minSectionY, currentView, previousView, hiddenNames,
                filler, fillerProvider, mapper, scanTileEntities, Set.of());
    }

    /**
     * @param hiddenTileEntityTypes block-entity registry names that must never reach the
     *                              client (derived from the configured hidden materials).
     *                              Checked against the chunk's own block-entity list, so a
     *                              container is stripped even when its block-state id cannot
     *                              be resolved to a material name.
     */
    public static Result sanitize(Column column, ClientVersion version, int minSectionY,
                                  HiddenBlockIndex.ChunkView currentView,
                                  HiddenBlockIndex.ChunkView previousView,
                                  Set<String> hiddenNames, Material filler,
                                  FillerProvider fillerProvider, StateIdMapper mapper,
                                  boolean scanTileEntities, Set<String> hiddenTileEntityTypes) {
        if (column == null) {
            return Result.UNCHANGED;
        }
        int changed = 0;
        changed += scrub(column, version, minSectionY, currentView, hiddenNames, filler,
                fillerProvider, mapper);
        changed += scrub(column, version, minSectionY, previousView, hiddenNames, filler,
                fillerProvider, mapper);

        LongOpenHashSet detected = null;
        LongOpenHashSet tileEntityProtectedPositions = null;
        TileEntity[] original = column.getTileEntities();
        if (scanTileEntities && original != null && original.length > 0) {
            BaseChunk[] sections = column.getChunks();
            if (sections != null) {
                for (TileEntity tileEntity : original) {
                    if (tileEntity == null) {
                        continue;
                    }
                    int packed = tileEntity.getPackedByte() & 0xFF;
                    int localX = (packed >> 4) & 0xF;
                    int localZ = packed & 0xF;
                    int y = tileEntity.getYShort();
                    int worldX = (column.getX() << 4) + localX;
                    int worldZ = (column.getZ() << 4) + localZ;
                    long pos = BlockPosUtil.encode(worldX, y, worldZ);
                    boolean known = (currentView != null && currentView.contains(pos))
                            || (previousView != null && previousView.contains(pos));
                    int sectionIndex = (y >> 4) - minSectionY;
                    if (sectionIndex < 0 || sectionIndex >= sections.length) {
                        continue;
                    }
                    BaseChunk section = sections[sectionIndex];
                    if (section == null) {
                        continue;
                    }
                    int localY = y & 15;
                    int stateId = section.getBlockId(localX, localY, localZ);
                    boolean protectedByType = isHiddenTileEntityType(mapper, version,
                            tileEntity, hiddenTileEntityTypes);
                    boolean protectedByState = false;
                    if (stateId != 0) {
                        String typeName = normalize(mapper.typeName(version, stateId));
                        protectedByState = typeName != null && hiddenNames.contains(typeName);
                    }
                    if (!known && !protectedByState && !protectedByType) {
                        continue;
                    }
                    if (stateId != 0) {
                        Material positionFiller = fillerProvider == null ? filler : fillerProvider.filler(pos);
                        int fillerId = mapper.fillerStateId(version, positionFiller);
                        if (fillerId <= 0) {
                            fillerId = 0;
                        }
                        section.set(localX, localY, localZ, fillerId);
                        changed++;
                    }
                    if (tileEntityProtectedPositions == null) {
                        tileEntityProtectedPositions = new LongOpenHashSet(4);
                    }
                    tileEntityProtectedPositions.add(pos);
                    if (!known) {
                        if (detected == null) {
                            detected = new LongOpenHashSet(8);
                        }
                        detected.add(pos);
                    }
                }
            }
        }

        TileEntity[] filteredTileEntities = null;
        if (original != null && original.length > 0
                && (currentView != null || previousView != null || tileEntityProtectedPositions != null)) {
            List<TileEntity> kept = new ArrayList<>(original.length);
            for (TileEntity tileEntity : original) {
                if (tileEntity == null) {
                    continue;
                }
                int packed = tileEntity.getPackedByte() & 0xFF;
                int worldX = (column.getX() << 4) + ((packed >> 4) & 0xF);
                int worldZ = (column.getZ() << 4) + (packed & 0xF);
                long pos = BlockPosUtil.encode(worldX, tileEntity.getYShort(), worldZ);
                boolean protectedPos = (currentView != null && currentView.contains(pos))
                        || (previousView != null && previousView.contains(pos))
                        || (tileEntityProtectedPositions != null && tileEntityProtectedPositions.contains(pos))
                        || isHiddenTileEntityType(mapper, version, tileEntity, hiddenTileEntityTypes);
                if (!protectedPos) {
                    kept.add(tileEntity);
                }
            }
            if (kept.size() != original.length) {
                filteredTileEntities = kept.toArray(new TileEntity[0]);
            }
        }

        long[] detectedPositions = detected == null ? NO_POSITIONS : detected.toLongArray();
        if (changed == 0 && filteredTileEntities == null) {
            return Result.UNCHANGED;
        }
        return new Result(changed, filteredTileEntities, true, detectedPositions);
    }

    private static boolean isHiddenTileEntityType(StateIdMapper mapper, ClientVersion version,
                                                  TileEntity tileEntity,
                                                  Set<String> hiddenTileEntityTypes) {
        if (hiddenTileEntityTypes == null || hiddenTileEntityTypes.isEmpty()) {
            return false;
        }
        try {
            String typeName = normalize(mapper.tileEntityTypeName(version, tileEntity.getType()));
            return typeName != null && hiddenTileEntityTypes.contains(typeName);
        } catch (RuntimeException ex) {
            return false;
        }
    }

    static String normalize(String typeName) {
        if (typeName == null) {
            return null;
        }
        if (typeName.startsWith("minecraft:")) {
            return typeName.substring("minecraft:".length());
        }
        int colon = typeName.indexOf(':');
        return colon >= 0 ? typeName.substring(colon + 1) : typeName;
    }

    private static int scrub(Column column, ClientVersion version, int minSectionY,
                             HiddenBlockIndex.ChunkView view, Set<String> hiddenNames,
                             Material filler, FillerProvider fillerProvider, StateIdMapper mapper) {
        if (view == null || view.size() == 0) {
            return 0;
        }
        BaseChunk[] sections = column.getChunks();
        if (sections == null) {
            return 0;
        }
        int changed = 0;
        for (long pos : view.positions()) {
            int y = BlockPosUtil.decodeY(pos);
            int sectionIndex = (y >> 4) - minSectionY;
            if (sectionIndex < 0 || sectionIndex >= sections.length) {
                continue;
            }
            BaseChunk section = sections[sectionIndex];
            if (section == null || section.isEmpty()) {
                continue;
            }
            int localX = BlockPosUtil.decodeX(pos) & 15;
            int localY = y & 15;
            int localZ = BlockPosUtil.decodeZ(pos) & 15;
            int stateId = section.getBlockId(localX, localY, localZ);
            if (stateId == 0) {
                continue; // air: index is stale, nothing to hide
            }
            String typeName = normalize(mapper.typeName(version, stateId));
            if (typeName == null || !hiddenNames.contains(typeName)) {
                continue; // block was replaced: index will be reconciled by the main thread
            }
            Material positionFiller = fillerProvider == null ? filler : fillerProvider.filler(pos);
            int fillerId = mapper.fillerStateId(version, positionFiller);
            if (fillerId <= 0) {
                // Cannot produce a safe filler: fail closed by keeping the real block
                // out of the packet the only way we can - replace with air.
                fillerId = 0;
            }
            section.set(localX, localY, localZ, fillerId);
            changed++;
        }
        return changed;
    }

    /** Utility for the gateway: count of protected positions a TE scan would report. */
    public static int detectTileEntityPositions(Column column, ClientVersion version, int minSectionY,
                                                Set<String> hiddenNames, StateIdMapper mapper,
                                                LongArrayList sink) {
        LongOpenHashSet detected = new LongOpenHashSet(8);
        TileEntity[] tileEntities = column.getTileEntities();
        BaseChunk[] sections = column.getChunks();
        if (tileEntities == null || sections == null) {
            return 0;
        }
        for (TileEntity tileEntity : tileEntities) {
            if (tileEntity == null) {
                continue;
            }
            int packed = tileEntity.getPackedByte() & 0xFF;
            int localX = (packed >> 4) & 0xF;
            int localZ = packed & 0xF;
            int y = tileEntity.getYShort();
            int sectionIndex = (y >> 4) - minSectionY;
            if (sectionIndex < 0 || sectionIndex >= sections.length) {
                continue;
            }
            BaseChunk section = sections[sectionIndex];
            if (section == null) {
                continue;
            }
            int stateId = section.getBlockId(localX, y & 15, localZ);
            if (stateId == 0) {
                continue;
            }
            String typeName = normalize(mapper.typeName(version, stateId));
            if (typeName != null && hiddenNames.contains(typeName)) {
                detected.add(BlockPosUtil.encode((column.getX() << 4) + localX, y,
                        (column.getZ() << 4) + localZ));
            }
        }
        if (sink != null) {
            sink.addAll(detected);
        }
        return detected.size();
    }
}
