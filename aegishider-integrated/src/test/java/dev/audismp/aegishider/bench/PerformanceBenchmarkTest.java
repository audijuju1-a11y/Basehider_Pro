package dev.audismp.aegishider.bench;

import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.chunk.BaseChunk;
import com.github.retrooper.packetevents.protocol.world.chunk.Column;
import com.github.retrooper.packetevents.protocol.world.chunk.TileEntity;
import dev.audismp.aegishider.core.BoundedTaskExecutor;
import dev.audismp.aegishider.index.HiddenBlockIndex;
import dev.audismp.aegishider.metrics.Metrics;
import dev.audismp.aegishider.occlusion.OcclusionEngine;
import dev.audismp.aegishider.occlusion.RayTracer;
import dev.audismp.aegishider.packet.ChunkSanitizer;
import dev.audismp.aegishider.util.BlockPosUtil;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Deterministic micro-benchmarks for the visibility decision primitives.
 *
 * <p>These measure Aegishider's own code paths on the build machine; they are not a
 * substitute for server MSPT benchmarking under real load. Results are printed with a
 * stable {@code BENCH} prefix so the engineering report can quote measured values.
 */
class PerformanceBenchmarkTest {

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
            return false;
        }
    }

    private static void report(String name, double value, String unit) {
        System.out.println("BENCH " + name + " = " + String.format("%.2f", value) + " " + unit);
    }

    @Test
    void runPrimitiveBenchmarks() {
        System.out.println("BENCH environment java=" + System.getProperty("java.version")
                + " os=" + System.getProperty("os.name") + " cpus="
                + Runtime.getRuntime().availableProcessors());

        // ── Block position encode/decode ───────────────────────────────────
        int ops = 5_000_000;
        long sink = 0;
        long start = System.nanoTime();
        for (int i = 0; i < ops; i++) {
            long pos = BlockPosUtil.encode(i, i & 0x3FF, -i);
            sink += BlockPosUtil.decodeX(pos) + BlockPosUtil.decodeY(pos) + BlockPosUtil.decodeZ(pos);
        }
        long encodeNanos = System.nanoTime() - start;
        report("blockpos.encode_decode", (double) encodeNanos / ops, "ns/op (sink=" + (sink & 1) + ")");

        // ── Hidden block index lookup ──────────────────────────────────────
        Metrics metrics = new Metrics();
        HiddenBlockIndex index = new HiddenBlockIndex(metrics);
        for (int chunk = 0; chunk < 200; chunk++) {
            for (int i = 0; i < 50; i++) {
                index.register(1L, BlockPosUtil.encode((chunk & 15) * 16 + (i % 16),
                        60 + (i / 16), (chunk >> 4) * 16 + (i % 16)));
            }
        }
        long[] probes = new long[50];
        for (int i = 0; i < probes.length; i++) {
            probes[i] = BlockPosUtil.encode(i % 16, 60, i / 16);
        }
        int lookups = 2_000_000;
        int hits = 0;
        start = System.nanoTime();
        for (int i = 0; i < lookups; i++) {
            if (index.isHidden(1L, probes[i % probes.length])) {
                hits++;
            }
        }
        report("index.isHidden", (double) (System.nanoTime() - start) / lookups, "ns/op (hits=" + hits + ")");

        HiddenBlockIndex.ChunkView view = index.chunkView(1L, 0, 0);
        int contains = 1_000_000;
        int contained = 0;
        start = System.nanoTime();
        for (int i = 0; i < contains; i++) {
            if (view.contains(probes[i % probes.length])) {
                contained++;
            }
        }
        report("chunkview.contains", (double) (System.nanoTime() - start) / contains,
                "ns/op (hits=" + contained + ")");

        // ── Field of view math ─────────────────────────────────────────────
        int fovOps = 20_000_000;
        int inside = 0;
        double cos = Math.cos(Math.toRadians(65));
        start = System.nanoTime();
        for (int i = 0; i < fovOps; i++) {
            if (OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0,
                    i % 40 - 20, 3, 10, cos)) {
                inside++;
            }
        }
        report("occlusion.insideFov", (double) (System.nanoTime() - start) / fovOps,
                "ns/op (inside=" + inside + ")");

        // ── Ray traced line of sight (fake tracer, measures policy overhead) ─
        RayTracer tracer = (world, ex, ey, ez, tx, ty, tz) -> false;
        OcclusionEngine occlusion = new OcclusionEngine(tracer);
        int rayOps = 5_000_000;
        int visible = 0;
        start = System.nanoTime();
        for (int i = 0; i < rayOps; i++) {
            if (occlusion.hasLineOfSight(null, 0, 0, 0, 10, 2, 4)) {
                visible++;
            }
        }
        report("occlusion.policyCheck", (double) (System.nanoTime() - start) / rayOps,
                "ns/op (visible=" + visible + ")");

        // ── Chunk sanitization (20 protected blocks in one section) ─────────
        ClientVersion version = ClientVersion.V_1_21_4;
        Set<String> hiddenNames = Set.of("minecraft:chest");
        ChunkSanitizer.StateIdMapper mapper = new ChunkSanitizer.StateIdMapper() {
            @Override
            public String typeName(ClientVersion clientVersion, int stateId) {
                return stateId == 100 ? "minecraft:chest" : "minecraft:air";
            }

            @Override
            public int fillerStateId(ClientVersion clientVersion, Material fillerMaterial) {
                return 999;
            }
        };
        HiddenBlockIndex sanitizerIndex = new HiddenBlockIndex(null);
        for (int i = 0; i < 20; i++) {
            sanitizerIndex.register(1L, BlockPosUtil.encode(i, 8, 0));
        }
        HiddenBlockIndex.ChunkView sanitizerView = sanitizerIndex.chunkView(1L, 0, 0);
        FakeSection section = new FakeSection();
        Column column = new Column(0, 0, true, new BaseChunk[]{section}, new TileEntity[0]);
        int iterations = 100_000;
        start = System.nanoTime();
        for (int i = 0; i < iterations; i++) {
            for (int x = 0; x < 20; x++) {
                section.set(x, 8, 0, 100); // restore chest for the next iteration
            }
            ChunkSanitizer.sanitize(column, version, 0, sanitizerView, null, hiddenNames,
                    Material.STONE, mapper);
        }
        report("chunkSanitize.20blocks", (double) (System.nanoTime() - start) / iterations,
                "ns/op (checks=" + 20 + ")");

        // ── Bounded executor submit/dispatch throughput ─────────────────────
        try (BoundedTaskExecutor executor = new BoundedTaskExecutor(4, 4096, "bench", null)) {
            int tasks = 200_000;
            AtomicInteger counter = new AtomicInteger();
            start = System.nanoTime();
            for (int i = 0; i < tasks; i++) {
                if (!executor.submit(counter::incrementAndGet)) {
                    while (!executor.submit(counter::incrementAndGet)) {
                        Thread.onSpinWait();
                    }
                }
            }
            long deadline = System.currentTimeMillis() + 20_000;
            while (counter.get() < tasks && System.currentTimeMillis() < deadline) {
                Thread.onSpinWait();
            }
            long elapsed = System.nanoTime() - start;
            report("boundedExecutor.dispatch", (double) elapsed / tasks, "ns/task (executed="
                    + counter.get() + ", rejected=" + executor.rejected() + ")");
        }

        System.out.println("BENCH done");
    }
}
