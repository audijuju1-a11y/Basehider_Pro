$ErrorActionPreference = 'Stop'
$f = 'D:\Basehider\docs\05-final-report.md'
$c = [System.IO.File]::ReadAllText($f)

# Title
$c = [regex]::Replace($c, '(?m)^# BaseHider 3\.1\.0', '# BaseHider 3.2.0', 1)

# Exec summary: tests count
$c = $c.Replace('Unit tests: **60 tests, 0 failures**', 'Unit tests: **75 tests, 0 failures**')

# Exec summary: add 3.2.0 bullet before the evidence table intro
$old = @'
- **Bounded async / budgeted main thread**: security decisions are main-thread and
  time-sliced; the only async pool is bounded and used solely for non-security diagnostics.
  There is no unbounded queue and no silent drop of security work.
- Real-server packet evidence (two headless clients, decoded chunk palettes):
'@
$new = @'
- **Bounded async / budgeted main thread**: security decisions are main-thread and
  time-sliced; the bounded async pool now runs real non-security maintenance work
  (periodic atomic diagnostics snapshots), never visibility work. There is no unbounded
  queue and no silent drop of security work.
- **3.2.0 follow-up hardening** (details: `docs/06-v3.2-improvements.md`): extended startup
  warm-up (first-join block spike ~38 ms -> ~11 ms), item spawn-storm priority lane, gateway
  stale-activity + detected-overflow alarms, and an on-demand `/basehider export`
  diagnostics snapshot written asynchronously.
- Real-server packet evidence (two headless clients, decoded chunk palettes):
'@
$c = $c.Replace($old, $new)

# Module matrix rows
$old = @'
| Bounded Async Scheduler | yes | saturation/rejection tests | `/basehider deep` path only | security path intentionally not async |
'@
$new = @'
| Bounded Async Scheduler | yes | saturation/rejection tests + maintenance exporter tests | live server: `/basehider export` wrote diagnostics.json off-thread | now does real non-security work (periodic diagnostics snapshots); security path intentionally not async |
'@
$c = $c.Replace($old, $new)
$old = @'
| Metrics / Diagnostics | yes | counters exercised by tests/bench | `/basehider diag` on live server | includes tick p50/p95/p99 histogram |
'@
$new = @'
| Metrics / Diagnostics | yes | counters exercised by tests/bench | `/basehider diag` on live server, diagnostics.json validated | tick p50/p95/p99 histogram, item-storm counters, watchdog state, async snapshot state |
'@
$c = $c.Replace($old, $new)

# Final run block (3.2.0 evidence)
$old = @'
### Final run (BaseHider 3.1.0, jar sha256 prefix `a938754a7689`)
'@
$new = @'
### Final run (BaseHider 3.2.0, jar sha256 prefix `cf3cc53e7529`)
'@
$c = $c.Replace($old, $new)
$c = $c.Replace('latency=22ms; followups=8', 'latency=51ms; followups=8')
$c = $c.Replace('OVERALL: PASS (128 s)', 'OVERALL: PASS (71 s)')

# Benchmark: add 3.2.0 rows after row F
$old = @'
| F. plugin 300 items, with startup pre-warm | 200 µs | 1.0 ms | 3.0 ms | 38 ms cumulative first-join/JIT (was 235 ms one-time item evaluation) | same 300-item burst; server `/mspt` 3.5 / 1.3 / 8.6 ms (5 s) |
'@
$new = @'
| F. plugin 300 items, with startup pre-warm | 200 µs | 1.0 ms | 3.0 ms | 38 ms cumulative first-join/JIT (was 235 ms one-time item evaluation) | same 300-item burst; server `/mspt` 3.5 / 1.3 / 8.6 ms (5 s) |
| G. 3.2.0, 300 items, extended warm-up + join ramp | 200 µs | 0.90 ms | 3.2 ms | block-engine first-join max ~11 ms (was ~38 ms); item first-eval residual ~31 ms | server `/mspt` **3.1 / 1.2 / 8.0 ms** (5 s) — back to baseline; raw `docs/evidence/mspt-plugin-items300-v32improved.json` |
'@
$c = $c.Replace($old, $new)

# Final artifact section
$old = @'
Final artifact: `D:\Basehider\dist\BaseHider-3.1.0.jar` sha256
`59e1391cc2151459340b7c0daf372caf0c4ae258ef7116588bd93f8da51f9a0d`.
A clean-verify rebuild and the harness-tested build (`a938754a…`) contain **byte-identical
plugin classes** (3461/3461 class files equal); the jar hash differs only due to archive
metadata/timestamps. The packet evidence and benchmarks therefore apply to the delivered
classes.
'@
$new = @'
Final artifact: `D:\Basehider\dist\BaseHider-3.2.0.jar` sha256
`cf3cc53e7529e35b7dbc801773eba3bf8c8d02dc7e0028cf89bbe3aa1191808c`
(6,797,418 bytes). It is the exact jar used for the final packet-level integration run and
for the 3.2.0 benchmark evidence listed above.
'@
$c = $c.Replace($old, $new)

# Reproduce commands: add export + load harness
$old = @'
# real-server benchmark (requires itest server assets; see bench/run-bench.js)
node D:\Basehider\bench\run-bench.js
```
'@
$new = @'
# real-server benchmark (requires itest server assets; see bench/run-bench.js)
node D:\Basehider\bench\run-bench.js

# on-demand maintenance snapshot (async, non-security work)
#   /basehider export   -> plugins/BaseHider/diagnostics.json

# load-test harness (separate server dir/ports; see bench/README-load-test.md)
node D:\Basehider\bench\load-bench.js --bots 100 --items 2000 --label tier100-2000
```
'@
$c = $c.Replace($old, $new)

[System.IO.File]::WriteAllText($f, $c)
Write-Host 'report patched for 3.2.0'
