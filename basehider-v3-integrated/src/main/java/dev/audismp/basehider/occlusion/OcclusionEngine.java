package dev.audismp.basehider.occlusion;

import dev.audismp.basehider.core.ViewerSession;
import org.bukkit.World;

/**
 * Visibility policy primitives shared by block and entity engines:
 * distance, field of view and line of sight.
 *
 * <p>The policy is intentionally positive-evidence-only: an object is VISIBLE only when
 * it is inside the configured distance AND inside the field of view AND a ray trace
 * proves there is no occluding geometry. Anything else is HIDDEN. This is the
 * fail-closed direction for anti-ESP.
 */
public final class OcclusionEngine {

    /** Tolerance so points exactly on the cone boundary are treated as inside (no false hide). */
    private static final double FOV_EPSILON = 1.0e-9;

    private final RayTracer rayTracer;

    public OcclusionEngine(RayTracer rayTracer) {
        this.rayTracer = rayTracer;
    }

    public RayTracer rayTracer() {
        return rayTracer;
    }

    public boolean hasLineOfSight(World world, double eyeX, double eyeY, double eyeZ,
                                  double targetX, double targetY, double targetZ) {
        return !rayTracer.isOccluded(world, eyeX, eyeY, eyeZ, targetX, targetY, targetZ);
    }

    /** Block-target line of sight: reaching the target block itself is not occlusion. */
    public boolean hasLineOfSight(World world, double eyeX, double eyeY, double eyeZ,
                                  double targetX, double targetY, double targetZ,
                                  int targetBlockX, int targetBlockY, int targetBlockZ) {
        return !rayTracer.isOccluded(world, eyeX, eyeY, eyeZ, targetX, targetY, targetZ,
                targetBlockX, targetBlockY, targetBlockZ);
    }

    /** Squared distance helper (no sqrt) used before the more expensive FOV/ray checks. */
    public static double distanceSq(ViewerSession viewer, double x, double y, double z) {
        double dx = x - viewer.eyeX();
        double dy = y - viewer.eyeY();
        double dz = z - viewer.eyeZ();
        return dx * dx + dy * dy + dz * dz;
    }

    public static double distanceSq(double ax, double ay, double az, double bx, double by, double bz) {
        double dx = ax - bx;
        double dy = ay - by;
        double dz = az - bz;
        return dx * dx + dy * dy + dz * dz;
    }

    /**
     * Field-of-view test using the viewer's look vector. Never uses sqrt; computes
     * {@code dot >= cos(halfFov) * |v|}.
     */
    public static boolean insideFov(ViewerSession viewer, double targetX, double targetY, double targetZ,
                                    double fovCosHalf) {
        double dx = targetX - viewer.eyeX();
        double dy = targetY - viewer.eyeY();
        double dz = targetZ - viewer.eyeZ();
        double lengthSq = dx * dx + dy * dy + dz * dz;
        if (lengthSq < 1.0e-6) {
            return true;
        }
        double dot = dx * viewer.lookX() + dy * viewer.lookY() + dz * viewer.lookZ();
        if (dot <= 0.0) {
            return false;
        }
        if (fovCosHalf <= 0.0) {
            return true; // FOV >= 180 degrees: everything in front is inside
        }
        return dot * dot + FOV_EPSILON >= fovCosHalf * fovCosHalf * lengthSq;
    }

    /** Utility for tests/diagnostics: direct FOV check from explicit values. */
    public static boolean insideFov(double eyeX, double eyeY, double eyeZ,
                                    double lookX, double lookY, double lookZ,
                                    double targetX, double targetY, double targetZ,
                                    double fovCosHalf) {
        double dx = targetX - eyeX;
        double dy = targetY - eyeY;
        double dz = targetZ - eyeZ;
        double lengthSq = dx * dx + dy * dy + dz * dz;
        if (lengthSq < 1.0e-6) {
            return true;
        }
        double dot = dx * lookX + dy * lookY + dz * lookZ;
        if (dot <= 0.0) {
            return false;
        }
        if (fovCosHalf <= 0.0) {
            return true;
        }
        return dot * dot + FOV_EPSILON >= fovCosHalf * fovCosHalf * lengthSq;
    }
}
