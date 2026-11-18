package dev.audismp.basehider.platform;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IntegrityGuardTest {

    @Test
    void hashesFilesWithSha256(@TempDir Path tempDir) throws Exception {
        Path file = tempDir.resolve("artifact.bin");
        Files.writeString(file, "basehider");
        assertEquals("22374e8d281df8b3cbf592bb250b4aff4c6517ce84c646991a445362a6b0ab28",
                IntegrityGuard.sha256(file));
    }

    @Test
    void reportsUnpinnedJarWithoutFailing() {
        IntegrityGuard.Result result = IntegrityGuard.verify("");
        assertNotNull(result);
        assertEquals("", result.expectedSha256());
        assertTrue(java.util.List.of("UNPINNED", "UNPACKED", "UNKNOWN", "ERROR").contains(result.status()));
    }

    @Test
    void pinComparisonDetectsTampering() {
        String actual = "6f8ea0b2f3f3fb747fa7a58b8c08f34fa105c394e4d76abd47e26ed010ef4aa9";
        assertEquals("UNPINNED", IntegrityGuard.statusFor(actual, ""));
        assertEquals("VERIFIED", IntegrityGuard.statusFor(actual, actual.toUpperCase()));
        assertEquals("TAMPERED", IntegrityGuard.statusFor(actual, "0".repeat(64)));
        assertEquals("TAMPERED", IntegrityGuard.statusFor(null, actual));
    }

    @Test
    void malformedPinIsIgnoredInsteadOfFalseTamper() {
        assertEquals("", IntegrityGuard.normalizePin(null));
        assertEquals("", IntegrityGuard.normalizePin(""));
        assertEquals("", IntegrityGuard.normalizePin("not-a-hash"));
        assertEquals("", IntegrityGuard.normalizePin("abc123"));
        String valid = "6F8EA0B2F3F3FB747FA7A58B8C08F34FA105C394E4D76ABD47E26ED010EF4AA9";
        assertEquals(valid.toLowerCase(), IntegrityGuard.normalizePin(valid));
    }
}
