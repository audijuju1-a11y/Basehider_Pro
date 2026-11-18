$ErrorActionPreference = 'Stop'
Copy-Item D:\Basehider\bench\mspt-plugin-items300-warmup.json D:\Basehider\docs\evidence\ -Force

$f = "D:\Basehider\docs\05-final-report.md"
$c = [System.IO.File]::ReadAllText($f)

$old = @'
| F. plugin 300 items, with startup pre-warm | ***TBD*** | ***TBD*** | ***TBD*** | ***TBD*** | same 300-item burst |
'@
$new = @'
| F. plugin 300 items, with startup pre-warm | 200 µs | 1.0 ms | 3.0 ms | 38 ms cumulative first-join/JIT (was 235 ms one-time item evaluation) | same 300-item burst; server `/mspt` 3.5 / 1.3 / 8.6 ms (5 s) |
'@
$c = $c.Replace($old, $new)

$old = @'
Measured overhead of the whole BaseHider+PacketEvents stack is roughly **0.5–1.4 ms
avg** in this single-client setting
'@
$new = @'
With the startup pre-warm, the 300-item run returned to baseline-like server tick time
(**3.5 / 1.3 / 8.6 ms**, 5 s window), confirming that the 235 ms item-engine outlier was
one-time class-load/JIT and is now paid during server start instead of under player load.
Measured overhead of the whole BaseHider+PacketEvents stack is roughly **0.5–1.4 ms avg**
in this single-client setting
'@
$c = $c.Replace($old, $new)

$old = @'
Reports: `docs/evidence/itest-final-report.json`, `docs/evidence/itest-baseline-report.json`.
'@
$new = @'
Reports: `docs/evidence/itest-final-warmup-report.json` (latest PASS),
`docs/evidence/itest-final-hardened-report.json`, `docs/evidence/itest-baseline-report.json`.
'@
$c = $c.Replace($old, $new)

$old = @'
`jar tf` inspection (full output `docs/evidence/jar-inspection.txt`):
'@
$new = @'
Final artifact: `D:\Basehider\dist\BaseHider-3.1.0.jar` sha256
`59e1391cc2151459340b7c0daf372caf0c4ae258ef7116588bd93f8da51f9a0d`.
A clean-verify rebuild and the harness-tested build (`a938754a…`) contain **byte-identical
plugin classes** (3461/3461 class files equal); the jar hash differs only due to archive
metadata/timestamps. The packet evidence and benchmarks therefore apply to the delivered
classes.

`jar tf` inspection (full output `docs/evidence/jar-inspection.txt`):
'@
$c = $c.Replace($old, $new)

$old = @'
Final jar: `D:\Basehider\dist\BaseHider-3.1.0.jar`
(sha256 in `docs/evidence/jar-inspection.txt`).
'@
$new = @'
Final jar: `D:\Basehider\dist\BaseHider-3.1.0.jar`
sha256 `59e1391cc2151459340b7c0daf372caf0c4ae258ef7116588bd93f8da51f9a0d`
'@
$c = $c.Replace($old, $new)

$old = @'
5. **Mass item spawn bursts** can cause a large single tick (observed 138 ms while 300
   entities were force-summoned in one burst); steady state is bounded (~0.3–0.9 ms
   BaseHider work). A production server normally cannot create 3000+ spawn events per tick
   without other bottlenecks.
'@
$new = @'
5. **Mass item spawn bursts**: before the pre-warm patch, the first dense item evaluation paid
   a one-time ~235 ms class-load/JIT spike. A bounded startup warm-up now pays this during
   server start; the repeat 300-item run showed p99 3.0 ms and server `/mspt` back to
   baseline (3.5 / 1.3 / 8.6 ms). Sustained thousands-of-entities-per-tick bursts remain
   bounded by the evaluation/raycast caps but were not benchmarked at 2,000+ entities.
'@
$c = $c.Replace($old, $new)

$old = @'
| B: dropped item ~3 blocks in front | visible (~4 ms) | visible, reveal latency **63 ms** (~3 ticks) |
'@
$new = @'
| B: dropped item ~3 blocks in front | visible (~4 ms) | visible, reveal latency **22–63 ms** (1–3 ticks across runs) |
'@
$c = $c.Replace($old, $new)

[System.IO.File]::WriteAllText($f, $c)
Write-Host "report finalized"
