package dev.audismp.aegishider.config;

import org.bukkit.Material;
import org.bukkit.configuration.file.YamlConfiguration;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigLoaderTest {

    private static AegishiderConfig load(String yaml, @TempDir Path tempDir) throws IOException {
        Path file = tempDir.resolve("config.yml");
        Files.writeString(file, yaml);
        YamlConfiguration configuration = YamlConfiguration.loadConfiguration(file.toFile());
        return ConfigLoader.load(configuration, 1L);
    }

    @Test
    void emptyConfigUsesSecureBuiltinDefaults() {
        AegishiderConfig config = ConfigLoader.load(new YamlConfiguration(), 1L);
        WorldSettings defaults = config.world("any_world");
        assertTrue(defaults.isEnabled());
        assertTrue(defaults.blocksEnabled());
        assertTrue(defaults.hiddenMaterials().contains(Material.CHEST));
        assertTrue(defaults.hiddenMaterials().contains(Material.SPAWNER));
        assertTrue(defaults.hiddenEntityTypes().contains(org.bukkit.entity.EntityType.ITEM));
        assertTrue(config.failClosed());
        assertTrue(config.raycastBudgetPerTick() > 0);
    }

    @Test
    void blocksAndItemsCanBeDisabledPerWorld(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    enabled: true
                    block-protection:
                      enabled: false
                    item-protection:
                      enabled: false
                  world:
                    enabled: false
                """, tempDir);
        WorldSettings defaultWorld = config.world("other");
        assertFalse(defaultWorld.blocksEnabled());
        assertFalse(defaultWorld.itemsEnabled());
        assertFalse(config.world("world").isEnabled());
    }

    @Test
    void invalidValuesAreClampedWithWarnings(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                security:
                  fail-closed: false
                  main-thread-budget-ms: 999
                  raycast-budget-per-tick: 100000
                worlds:
                  default:
                    block-protection:
                      reveal:
                        max-distance: 0.1
                        fov-degrees: 500
                """, tempDir);
        assertTrue(config.mainThreadBudgetMs() <= 20.0);
        assertTrue(config.raycastBudgetPerTick() <= 5000);
        assertFalse(config.warnings().isEmpty());
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("fail-closed")));
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("max-distance")));
    }

    @Test
    void unsupportedHiddenBlocksAreRejected(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    block-protection:
                      hidden-blocks: [CHEST, DIAMOND_ORE, MADNESS]
                """, tempDir);
        WorldSettings settings = config.world("test");
        assertTrue(settings.hiddenMaterials().contains(Material.CHEST));
        assertFalse(settings.hiddenMaterials().contains(Material.DIAMOND_ORE));
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("DIAMOND_ORE")));
    }

    @Test
    void playerEntityHidingIsRejected(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    item-protection:
                      hidden-entity-types: [ITEM, PLAYER]
                """, tempDir);
        WorldSettings settings = config.world("test");
        assertTrue(settings.hiddenEntityTypes().contains(org.bukkit.entity.EntityType.ITEM));
        assertFalse(settings.hiddenEntityTypes().contains(org.bukkit.entity.EntityType.PLAYER));
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("PLAYER")));
    }

    @Test
    void legacyHiddenBlocksFormatIsMigrated(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  world:
                    enabled: true
                    mode: SMART
                    hidden-blocks: [CHEST, BARREL]
                """, tempDir);
        WorldSettings settings = config.world("world");
        assertTrue(settings.blocksEnabled());
        assertTrue(settings.hiddenMaterials().contains(Material.CHEST));
        assertTrue(settings.hiddenMaterials().contains(Material.BARREL));
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("legacy")));
    }

    @Test
    void separateWorldSectionOverridesDefault(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    block-protection:
                      reveal:
                        max-distance: 8.0
                  creative:
                    block-protection:
                      enabled: false
                """, tempDir);
        assertEquals(8.0, config.world("survival").blockProtection().revealDistance(), 1e-9);
        assertFalse(config.world("creative").blocksEnabled());
    }

    @Test
    void packetGatewayMinimumVersionIsParsed(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                security:
                  packet-gateway:
                    minimum-version: "2.14.0"
                """, tempDir);
        assertEquals("2.14.0", config.packetGateway().minimumVersion());
    }

    @Test
    void fovAndRevealDefaultsAreSane() {
        AegishiderConfig config = ConfigLoader.load(new YamlConfiguration(), 1L);
        WorldSettings settings = config.world("world");
        assertNotNull(settings.blockProtection());
        assertTrue(settings.blockProtection().fovDegrees() > 0
                && settings.blockProtection().fovDegrees() <= 360);
        assertTrue(settings.blockProtection().revealDistance() > 0);
        assertTrue(settings.itemProtection().revealDistance() > 0);
        assertTrue(settings.blockProtection().fovCosHalf() >= -1.0);
    }

    @Test
    void analyticsDefaultOff() {
        AegishiderConfig config = ConfigLoader.load(new YamlConfiguration(), 1L);
        assertFalse(config.mining().enabled());
        assertFalse(config.raid().enabled());
        assertFalse(config.debug().logBlockedPackets());
    }

    @Test
    void tileEntityFillerIsReplacedWithStone(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    block-protection:
                      hidden-blocks: [CHEST]
                      replace-with: OAK_SIGN
                """, tempDir);
        WorldSettings settings = config.world("test");
        assertEquals(Material.STONE, settings.blockProtection().replaceWith());
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("block entity")));
    }

    @Test
    void yShieldTileEntityFillerIsReplacedWithStone(@TempDir Path tempDir) throws IOException {
        AegishiderConfig config = load("""
                worlds:
                  default:
                    y-shield:
                      enabled: true
                      filler: CHEST
                """, tempDir);
        WorldSettings settings = config.world("test");
        assertEquals(Material.STONE, settings.yShield().filler());
        assertTrue(config.warnings().stream().anyMatch(w -> w.contains("y-shield.filler")));
    }

    @Test
    void shippedConfigKeysAreLiveAndSafeDefaults() throws IOException {
        try (var stream = getClass().getResourceAsStream("/config.yml")) {
            assertNotNull(stream, "bundled config.yml is missing");
            YamlConfiguration configuration = YamlConfiguration.loadConfiguration(
                    new InputStreamReader(stream, StandardCharsets.UTF_8));
            AegishiderConfig config = ConfigLoader.load(configuration, 1L);
            assertEquals(180, config.raycastBudgetPerTick());
            WorldSettings settings = config.world("world");
            assertFalse(settings.playerProtection().enabled());
            assertFalse(settings.yShield().enabled());
            assertFalse(settings.tunnelShield().enabled());
            assertTrue(settings.hiddenMaterials().contains(Material.CRAFTER));
            assertTrue(settings.hiddenMaterials().contains(Material.DECORATED_POT));
            assertTrue(settings.hiddenMaterials().contains(Material.CHISELED_BOOKSHELF));
            assertTrue(settings.hiddenMaterials().contains(Material.LECTERN));
            assertTrue(settings.hiddenMaterials().contains(Material.JUKEBOX));
            assertTrue(settings.hiddenMaterials().contains(Material.NOTE_BLOCK));
        }
    }

    @Test
    void warningsListIsImmutable() {
        AegishiderConfig config = ConfigLoader.load(new YamlConfiguration(), 1L);
        List<String> warnings = config.warnings();
        try {
            warnings.add("x");
            throw new AssertionError("warnings list should be immutable");
        } catch (UnsupportedOperationException expected) {
            // ok
        }
    }
}
