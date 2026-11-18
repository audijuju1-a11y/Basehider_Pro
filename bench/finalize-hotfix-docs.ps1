$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider'
$ev = "$base\docs\evidence"
New-Item -ItemType Directory -Force $ev | Out-Null

# Evidence copies (ViaVersion before/after captures)
Copy-Item "$base\bench\via-server-v332.log" "$ev\via-3.3.2-server-before.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-v332-client26.log" "$ev\via-3.3.2-client26-before.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-server-v333.log" "$ev\via-3.3.3-server-after.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-v333-client26.log" "$ev\via-3.3.3-client26-after.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-server-v334.log" "$ev\via-3.3.4-server.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-v334-client26.log" "$ev\via-3.3.4-client26.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-server-v335.log" "$ev\via-3.3.5-server.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\bench\via-v335-client26.log" "$ev\via-3.3.5-client26.log" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\itest\out\report-20261115-123255-923.json" "$ev\itest-3.3.5-report.json" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\docs\07-viaversion-hotfix.md" "$ev\hotfix-viaversion.md" -Force -ErrorAction SilentlyContinue

# dist README 3.3.5
$readme = @'
BaseHider 3.3.5 - delivery folder
=================================
BaseHider-3.3.5.jar   server plugin (shaded, relocated FastUtil)
sha256                8dda88461c8504b68840d096f6db5288e1e2e244153cce9d093b23628298977f
size                  6,806,017 bytes
                      (mvn -B clean verify: 75 tests, 0 failures)

IMPORTANT (2026-11-15 hotfix): 3.3.3+ fixes packet state-id resolution for ViaVersion
clients (ghost blocks/chest ESP) and adds the monster/vehicle/frame hidden-entity list +
early-spawn fail-closed filter. See docs/07-viaversion-hotfix.md.

Requirements: Paper 1.21.4, Java 21, PacketEvents plugin 2.14.0+ installed separately.
Source:       D:\Basehider\basehider-v3-integrated
Docs:         D:\Basehider\docs (audit, architecture, test plan, dependencies,
              final report, 3.2/3.3 improvements, ViaVersion hotfix)
Evidence:     D:\Basehider\docs\evidence (packet harness, ViaVersion before/after,
              benchmarks, load tests, crash/inspection data)
Integration : D:\Basehider\itest (Paper 1.21.4 + headless-client harness)
Benchmarks  : D:\Basehider\bench (+ load harness; separate load-server dir)

Real server port note: the BaseHider test server was moved from 25565 to 25566 because
another test server (AegisAC testrig) occupies 25565. Reconnect on port 25566.
'@
Set-Content "$base\dist\README.txt" $readme -Encoding UTF8

# Report patch: version/tests/artifact/hotfix pointer
$f = "$base\docs\05-final-report.md"
$c = [IO.File]::ReadAllText($f)
$c = [regex]::Replace($c, '(?m)^# BaseHider 3\.2\.0', '# BaseHider 3.3.5', 1)
$c = $c.Replace('Unit tests: **75 tests, 0 failures**', 'Unit tests: **75 tests, 0 failures**')
$c = $c.Replace(@'
- **3.2.0 follow-up hardening** (details: `docs/06-v3.2-improvements.md`): extended startup
'@, @'
- **3.3.3â€“3.3.5 emergency hotfix (2026-11-15)**: real-server testing with a ViaVersion
  client (26.x â†’ 1.21.4) proved that chunk/block state ids were resolved against the
  *client* protocol version instead of the server packet format. That leaked container
  block entities/states to storage ESP and produced ghost/disappearing blocks. All state
  resolution now uses the server protocol version; monster/vehicle/frame entity types are
  hidden by default; entity-spawn race is fail-closed; owner grace is bounded. Full details
  and before/after packets: `docs/07-viaversion-hotfix.md`.
- **3.2.0 follow-up hardening** (details: `docs/06-v3.2-improvements.md`): extended startup
'@)
$c = $c.Replace('Final artifact: `D:\Basehider\dist\BaseHider-3.2.0.jar` sha256', 'Final artifact: `D:\Basehider\dist\BaseHider-3.3.5.jar` sha256')
$c = $c.Replace('`cf3cc53e7529e35b7dbc801773eba3bf8c8d02dc7e0028cf89bbe3aa1191808c`', '`8dda88461c8504b68840d096f6db5288e1e2e244153cce9d093b23628298977f`')
$c = $c.Replace('(6,797,418 bytes)', '(6,806,017 bytes)')
$c += @'

---

## 13. Emergency hotfix 2026-11-15 (ViaVersion client)

After the 3.2.0 delivery a real cheat-client test against Paper 1.21.4 + PacketEvents
2.14.0 + ViaVersion 5.12.2 (client protocol 26.x) showed that storage ESP still found
containers and that filler blocks could ghost/disappear. Root cause: state-id â†” material
resolution used the client protocol version (26.x) on packets that are encoded in the
server format (1.21.4), so protected containers were not recognised and filler ids were
wrong. Fixed in 3.3.3 (server-format state mapping), 3.3.4 (early-spawn fail-closed for
untracked hidden entities: armour stands/chest mine carts/monsters) and 3.3.5 (verification
build). Additional real-server changes: expanded hidden-entity list (monsters, item frames,
armour stands, storage minecarts), bounded owner grace (8 blocks / 2 s), reduced raycast and
reconciliation defaults.

Verified locally with an isolated Paper 1.21.4 + ViaVersion server and a protocol-26.1
headless client: before the fix the client received a chunk with three protected containers'
block entities; after the fix `blockEntities=0` and the server logged
`changed=3 detected=3 tileEntitiesRemoved=true`. A chest-minecart spawn race was observed
and correctly cancelled (`hiddenSpawn=true cancelled=true`). Native 1.21.4 E2E harness on
3.3.5: PASS (A HIDDEN, B VISIBLE, C HIDDEN). Details: `docs/07-viaversion-hotfix.md`.

The BaseHider test server was moved to port **25566** because another test server occupies
25565; reconnect there to test.
'@
[IO.File]::WriteAllText($f, $c)
Write-Host 'docs/artifact updated'

