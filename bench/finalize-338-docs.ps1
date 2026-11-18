$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider'
$ev = "$base\docs\evidence"
New-Item -ItemType Directory -Force $ev | Out-Null
Copy-Item "$base\bench\reveal-v338.log" "$ev\reveal-3.3.8-native.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\hidden-materials.log" "$ev\hidden-block-coverage-test.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-test-hidden-materials.ndjson" "$ev\hidden-block-coverage-client.ndjson" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-test-reveal-v338.ndjson" "$ev\reveal-3.3.8-client.ndjson" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\docs\08-cave-y-shield-design.md" "$ev\cave-y-shield-design.md" -Force -ErrorAction SilentlyContinue

# dist README 3.3.8
$readme = @'
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
'@
Set-Content "$base\dist\README.txt" $readme -Encoding UTF8

# report hotfix section extension
$f = "$base\docs\05-final-report.md"
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('Final artifact: `D:\Basehider\dist\BaseHider-3.3.5.jar` sha256', 'Final artifact: `D:\Basehider\dist\BaseHider-3.3.8.jar` sha256')
$c = $c.Replace('`8dda88461c8504b68840d096f6db5288e1e2e244153cce9d093b23628298977f`', '`f761d095e3e24c1417a4c632ebe2b69e88825e9d1df0c7358b782cad59c664ac`')
$c = $c.Replace('(6,806,017 bytes)', '(6,806,712 bytes)')
$c = $c.Replace(@'
The BaseHider test server was moved to port **25566** because another test server occupies
25565; reconnect there to test.
'@, @'
### 13.1 Reveal regression fixed in 3.3.8

After the ViaVersion fix, chests were hidden correctly but **stayed stone when the player
walked close**. Three independent bugs were found by a live diagnostic and fixed:

1. `PaperRayTracer` treated a hit on the target chest's own hitbox as occlusion. The
   block-target ray now treats reaching the target block as visible.
2. Reveal markers were not cleared when a chunk was (re)sent, so a marker from before the
   chunk send blocked every later reveal. The gateway now clears the marker + requests a
   resync for every sent chunk.
3. `Player#isChunkSent` returned false for the candidate chunks in the test (527/527 skips),
   so the reveal loop never raycast. The unreliable guard was removed; chunk-send resync
   makes late reveals safe.

Verified with a headless native 1.21.4 client: after the fix the server reported
`revealed=1, Raycasts=1` and the client received `BLOCK_CHANGE` at the chest position with
state id **3010 (chest)**, i.e. the stone became a real chest again when approached.
A coverage test placing all **31** configured hidden block types in one chunk plus two
control block entities showed the client chunk contained only the two controls (all hidden
block entities/state were stripped).

The BaseHider test server was moved to port **25566** because another test server occupies
25565; reconnect there to test.
'@)
$c = [regex]::Replace($c, '(?m)^# BaseHider 3\.3\.5', '# BaseHider 3.3.8', 1)
[IO.File]::WriteAllText($f, $c)
Write-Host 'docs/artifact updated for 3.3.8'
