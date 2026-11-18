package dev.audismp.basehider.core;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

class WorldKeysTest {

    @AfterEach
    void cleanup() {
        WorldKeys.resetForTests();
    }

    @Test
    void internsWorldUuidToStableUniqueId() {
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        long firstId = WorldKeys.idOf(first);
        long secondId = WorldKeys.idOf(second);
        assertNotEquals(WorldKeys.UNKNOWN, firstId);
        assertNotEquals(WorldKeys.UNKNOWN, secondId);
        assertNotEquals(firstId, secondId);
        assertEquals(firstId, WorldKeys.idOf(first));
        assertEquals(secondId, WorldKeys.idOf(second));
        assertEquals(first, WorldKeys.uuidOf(firstId));
        assertSame(second, WorldKeys.uuidOf(secondId));
    }
}
