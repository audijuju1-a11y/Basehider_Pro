package dev.audismp.aegishider.core;

/**
 * Shared per-tick raycast budget. Block reveal and entity reveal engines draw from the
 * same pool so a storage-cluster scan cannot starve item visibility (and vice versa).
 *
 * <p>When the budget is exhausted the calling engine defers the check and keeps the
 * object in its previous (fail-closed) state; nothing is revealed without a completed
 * positive check.
 */
public final class RaycastBudget {

    private int remaining;
    private int limit;

    public RaycastBudget(int limit) {
        this.limit = Math.max(0, limit);
        this.remaining = this.limit;
    }

    public void reset(int newLimit) {
        this.limit = Math.max(0, newLimit);
        this.remaining = this.limit;
    }

    public boolean tryConsume() {
        if (remaining <= 0) {
            return false;
        }
        remaining--;
        return true;
    }

    public int remaining() {
        return remaining;
    }

    public int limit() {
        return limit;
    }
}
