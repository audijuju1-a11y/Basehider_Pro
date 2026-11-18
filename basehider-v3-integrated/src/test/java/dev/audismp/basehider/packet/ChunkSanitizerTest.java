package dev.audismp.basehider.packet;

import com.github.retrooper.packetevents.protocol.nbt.NBTCompound;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.chunk.BaseChunk;
import com.github.retrooper.packetevents.protocol.world.chunk.Column;
import com.github.retrooper.packetevents.protocol.world.chunk.TileEntity;
import dev.audismp.basehider.index.HiddenBlockIndex;
import dev.audismp.basehider.metrics.Metrics;
import dev.audismp.basehider.util.BlockPosUtil;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChunkSanitizerTest {

    private static final long WORLD = 1L;
    private static final ClientVersion VERSION = ClientVersion.V_1_21_4;
    private static final int CHEST_STATE = 100;
    private static final int STONE_STATE = 1;
    private static final int FILLER_STATE = 999;
    private static final int AIR_STATE = 0;

    /** In-memory chunk section: index = (y << 8) | (z << 4) | x. */
    private static final class FakeSection implements BaseChunk {
        final int[] states = new int[4096];

        @Override
        public int getBlockId(int x, int y, int z) {
            return states[(y << 8) | (z << 4) | x];
        }

        @Override
        public void set(int x, int y, int z, int stateId) {
            states[(y << 8) | (z << 4) | x] = stateId;
        }

        @Override
        public boolean isEmpty() {
            for (int state : states) {
                if (state != 0) {
                    return false;
                }
            }
            return true;
        }

        int peek(int x, int y, int z) {
            return states[(y << 8) | (z << 4) | x];
        }
    }

    private static final class FakeMapper implements ChunkSanitizer.StateIdMapper {
        final Map<Integer, String> names = new HashMap<>();
        final Map<Integer, String> tileEntityNames = new HashMap<>();

        FakeMapper() {
            names.put(CHEST_STATE, "minecraft:chest");
            names.put(STONE_STATE, "minecraft:stone");
            names.put(AIR_STATE, "minecraft:air");
            tileEntityNames.put(42, "chest");
            tileEntityNames.put(43, "sign");
        }

        @Override
        public String typeName(ClientVersion version, int stateId) {
            return names.get(stateId);
        }

        @Override
        public int fillerStateId(ClientVersion version, Material fillerMaterial) {
            return FILLER_STATE;
        }

        @Override
        public String tileEntityTypeName(ClientVersion version, int typeId) {
            return tileEntityNames.get(typeId);
        }
    }

    private static final Set<String> HIDDEN_NAMES = Set.of("chest");
    private static final Set<String> HIDDEN_TE_TYPES = Set.of("chest");
    private static final int UNMAPPED_STATE = 200;

    private HiddenBlockIndex.ChunkView viewFor(long... positions) {
        HiddenBlockIndex index = new HiddenBlockIndex(new Metrics());
        for (long position : positions) {
            index.register(WORLD, position);
        }
        return index.chunkView(WORLD, BlockPosUtil.decodeX(positions[0]) >> 4,
                BlockPosUtil.decodeZ(positions[0]) >> 4);
    }

    @Test
    void replacesProtectedBlockWithFiller() {
        FakeSection section = new FakeSection();
        section.set(5, 5, 5, CHEST_STATE);
        section.set(6, 5, 5, STONE_STATE);
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        long protectedPos = BlockPosUtil.encode(5, 5, 5);

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                viewFor(protectedPos), null, HIDDEN_NAMES, Material.STONE, new FakeMapper());

        assertTrue(result.rewritten());
        assertEquals(1, result.changedBlocks());
        assertEquals(FILLER_STATE, section.peek(5, 5, 5), "chest replaced by filler");
        assertEquals(STONE_STATE, section.peek(6, 5, 5), "unprotected block untouched");
    }

    @Test
    void staleIndexEntryWithAirDoesNotBreakChunk() {
        FakeSection section = new FakeSection(); // everything air
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                viewFor(BlockPosUtil.encode(1, 1, 1)), null, HIDDEN_NAMES, Material.STONE,
                new FakeMapper());
        assertFalse(result.rewritten());
        assertEquals(0, result.changedBlocks());
    }

    @Test
    void nonProtectedMaterialAtIndexedPositionIsNotReplaced() {
        FakeSection section = new FakeSection();
        section.set(2, 2, 2, STONE_STATE); // index says hidden, world says stone
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                viewFor(BlockPosUtil.encode(2, 2, 2)), null, HIDDEN_NAMES, Material.STONE,
                new FakeMapper());
        assertFalse(result.rewritten());
        assertEquals(STONE_STATE, section.peek(2, 2, 2));
    }

    @Test
    void blockEntityDataForProtectedPositionIsRemoved() {
        FakeSection section = new FakeSection();
        section.set(9, 3, 9, CHEST_STATE);
        // packed XZ: localX = 9, localZ = 9 -> (9 << 4) | 9 = 153
        TileEntity protectedTile = new TileEntity((byte) ((9 << 4) | 9), (short) 3, 0,
                new NBTCompound());
        TileEntity otherTile = new TileEntity((byte) ((1 << 4) | 1), (short) 3, 0,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{protectedTile, otherTile});

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                viewFor(BlockPosUtil.encode(9, 3, 9)), null, HIDDEN_NAMES, Material.STONE,
                new FakeMapper());

        assertTrue(result.rewritten());
        assertNotNull(result.tileEntities());
        assertEquals(1, result.tileEntities().length);
        int packed = result.tileEntities()[0].getPackedByte() & 0xFF;
        assertEquals(1, (packed >> 4) & 0xF);
        assertEquals(1, packed & 0xF);
    }

    @Test
    void previousWorldViewIsAlsoSanitized() {
        FakeSection section = new FakeSection();
        section.set(4, 4, 4, CHEST_STATE);
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        long pos = BlockPosUtil.encode(4, 4, 4);
        // Current view does not contain the pos, previous world view does (world transition).
        HiddenBlockIndex index = new HiddenBlockIndex(new Metrics());
        index.register(WORLD, pos);
        HiddenBlockIndex.ChunkView previousView = index.chunkView(WORLD, 0, 0);

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, previousView, HIDDEN_NAMES, Material.STONE, new FakeMapper());
        assertTrue(result.rewritten());
        assertEquals(FILLER_STATE, section.peek(4, 4, 4));
    }

    @Test
    void unchangedChunkIsNotRewritten() {
        FakeSection section = new FakeSection();
        section.set(0, 0, 0, STONE_STATE);
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, null, HIDDEN_NAMES, Material.STONE, new FakeMapper());
        assertFalse(result.rewritten());
        assertNull(result.tileEntities());
    }

    @Test
    void tileEntityScanHidesBlockEvenWithoutIndex() {
        // Simulates a container placed/changed by a non-Bukkit path: the index is empty,
        // but the chunk's own block entity still proves the chest exists.
        FakeSection section = new FakeSection();
        section.set(7, 2, 7, CHEST_STATE);
        TileEntity chestTile = new TileEntity((byte) ((7 << 4) | 7), (short) 2, 0,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{chestTile});

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, null, HIDDEN_NAMES, Material.STONE, new FakeMapper(), true);

        assertTrue(result.rewritten());
        assertFalse(result.tileEntities() != null && result.tileEntities().length > 0);
        assertTrue(result.hasDetectedPositions());
        assertEquals(1, result.detectedPositions().length);
        assertEquals(BlockPosUtil.encode(7, 2, 7), result.detectedPositions()[0]);
        assertEquals(FILLER_STATE, section.peek(7, 2, 7));
    }

    @Test
    void tileEntityScanIgnoresBlockEntitiesOfNonProtectedBlocks() {
        FakeSection section = new FakeSection();
        section.set(1, 1, 1, STONE_STATE);
        TileEntity otherTile = new TileEntity((byte) ((1 << 4) | 1), (short) 1, 0,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{otherTile});

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, null, HIDDEN_NAMES, Material.STONE, new FakeMapper(), true);
        assertFalse(result.rewritten());
        assertFalse(result.hasDetectedPositions());
        assertEquals(STONE_STATE, section.peek(1, 1, 1));
    }

    @Test
    void tileEntityScanReportsKnownIndexedPositionOnlyOnce() {
        FakeSection section = new FakeSection();
        section.set(5, 5, 5, CHEST_STATE);
        TileEntity chestTile = new TileEntity((byte) ((5 << 4) | 5), (short) 5, 0,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{chestTile});
        long pos = BlockPosUtil.encode(5, 5, 5);

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                viewFor(pos), null, HIDDEN_NAMES, Material.STONE, new FakeMapper(), true);
        assertTrue(result.rewritten());
        assertFalse(result.hasDetectedPositions(), "indexed positions need no detection bridge");
        assertTrue(result.tileEntities() == null || result.tileEntities().length == 0,
                "block entity of an indexed protected block must be stripped");
    }

    @Test
    void hiddenTileEntityTypeStripsEntityWhenStateIdIsUnresolvable() {
        // The block-state palette cannot be resolved (e.g. mapping failure), but the
        // block-entity registry id still identifies the chest: it must be stripped.
        FakeSection section = new FakeSection();
        section.set(3, 4, 3, UNMAPPED_STATE);
        TileEntity chestTile = new TileEntity((byte) ((3 << 4) | 3), (short) 4, 42,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{chestTile});

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, null, HIDDEN_NAMES, Material.STONE, null, new FakeMapper(), true,
                HIDDEN_TE_TYPES);

        assertTrue(result.rewritten());
        assertEquals(FILLER_STATE, section.peek(3, 4, 3),
                "unresolvable state at a hidden block entity must be replaced via TE type");
        assertFalse(result.tileEntities() != null && result.tileEntities().length > 0);
        assertTrue(result.hasDetectedPositions());
        assertEquals(BlockPosUtil.encode(3, 4, 3), result.detectedPositions()[0]);
    }

    @Test
    void nonHiddenTileEntityTypeIsPreserved() {
        FakeSection section = new FakeSection();
        section.set(1, 1, 1, STONE_STATE);
        TileEntity signTile = new TileEntity((byte) ((1 << 4) | 1), (short) 1, 43,
                new NBTCompound());
        Column column = new Column(0, 0, true, new BaseChunk[]{section},
                new TileEntity[]{signTile});

        ChunkSanitizer.Result result = ChunkSanitizer.sanitize(column, VERSION, 0,
                null, null, HIDDEN_NAMES, Material.STONE, null, new FakeMapper(), true,
                HIDDEN_TE_TYPES);

        assertFalse(result.rewritten(), "signs are not protected and must pass through");
        assertEquals(STONE_STATE, section.peek(1, 1, 1));
        assertFalse(result.hasDetectedPositions());
    }
}
