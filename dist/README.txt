BaseHider 3.3.8 - delivery folder
=================================
BaseHider-3.3.8.jar   server plugin (shaded, relocated FastUtil)
sha256                f761d095e3e24c1417a4c632ebe2b69e88825e9d1df0c7358b782cad59c664ac
size                  6,806,712 bytes
                      (mvn -B clean verify: 75 tests, 0 failures)

Critical fixes in 3.3.8:
- Block reveal actually works: raycast no longer treats the target chest's own hitbox as an
  occluder; stale reveal markers are cleared when a chunk is (re)sent; the unreliable
  isChunkSent guard that skipped every candidate is removed.
- Verified: nearby chest is sent as chest state id 3010 after being shown as stone; all 31
  configured hidden block types were stripped from a test chunk (only non-hidden control
  block entities remained).
- ViaVersion client (26.x) chunk/block state mapping fixed in 3.3.3.
- Monster/vehicle/frame entity hiding + early-spawn fail-closed (3.3.4).

Requirements: Paper 1.21.4, Java 21, PacketEvents plugin 2.14.0+ installed separately.
Real server: port 25566 (another test server occupies 25565). Source/docs as before.
Design proposal for contextual filler / Y shield / cave & tunnel hiding:
docs/08-cave-y-shield-design.md (not implemented yet - product decisions needed).
