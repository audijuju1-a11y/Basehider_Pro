package dev.audismp.basehider.occlusion;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OcclusionEngineTest {

    @Test
    void fovInsideAndOutside() {
        // Viewer at origin looking straight along +X.
        double cos90 = Math.cos(Math.toRadians(45));
        assertTrue(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0,
                10, 0, 0, cos90));
        assertTrue(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0,
                5, 4, 0, cos90), "inside a 90 degree cone");
        assertFalse(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0,
                -5, 0, 0, cos90), "behind the viewer");
        assertFalse(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0,
                2, 10, 0, cos90), "outside the cone");
    }

    @Test
    void fovConeBoundaryIsInclusive() {
        double cos45 = Math.cos(Math.toRadians(45));
        // A point exactly on the 45 degree boundary must be inside.
        assertTrue(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0, 1, 1, 0, cos45));
    }

    @Test
    void zeroDistanceIsVisible() {
        assertTrue(OcclusionEngine.insideFov(0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5));
    }

    @Test
    void rayTracerControlsResult() {
        RayTracer blocked = (world, ex, ey, ez, tx, ty, tz) -> true;
        RayTracer clear = (world, ex, ey, ez, tx, ty, tz) -> false;
        OcclusionEngine engine = new OcclusionEngine(blocked);
        assertFalse(engine.hasLineOfSight(null, 0, 0, 0, 5, 0, 0));
        OcclusionEngine open = new OcclusionEngine(clear);
        assertTrue(open.hasLineOfSight(null, 0, 0, 0, 5, 0, 0));
    }

    @Test
    void distanceSquaredIsCorrect() {
        assertTrue(Math.abs(OcclusionEngine.distanceSq(0, 0, 0, 3, 4, 0) - 25.0) < 1e-9);
    }
}
