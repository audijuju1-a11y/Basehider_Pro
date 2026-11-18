$ErrorActionPreference = 'Stop'
$f = 'D:\Basehider\docs\05-final-report.md'
$c = [System.IO.File]::ReadAllText($f)

$old = @'
| Tier | Bots spawned/alive | Items tracked | Join p95 | TPS | Server MSPT (5 s avg) med/p95 | BaseHider p99 med | Heap used (of 2 GB) |
|---|---|---|---|---|---|---|---|
| 10 / 200 | 10 / 10 | 200 | 1.49 s | 20.0 | 4.6 / 6.0 ms | 3.2 ms | 566 MB |
| 50 / 1000 | 50 / 50 | 1000 | 5.90 s | 19.1 | 11.3 / 13.6 ms | 2.1 ms | 628 MB |
| 200 / 2000 | 196 spawned, 200 alive | 2000 | 12.9 s | 16.2–17.3 | 64.2 / 106 ms | 3.1 ms | 681 MB |
| soak 10 / 200, 120 s (baseline phase) | 10 / 10 | 200 | 1.51 s | 20.0 | 2.65 / 7.4 ms | 0.8 ms | 520 MB |
'@
$new = @'
| Tier | Bots joined (final alive) | Items tracked | Join median/p95 | TPS | Server MSPT (5 s avg) med/range | BaseHider p50/p95/p99 (µs) | Heap used |
|---|---|---|---|---|---|---|---|
| 10 / 200 | 10/10 | 200 | 1.44 / 1.49 s | 20.0 | 4.6 (2.9–6.4) | 150–200 / 500–1100 / 2650–3200 | 398–762 MB |
| 50 / 1000 | 50/50 | 1000 | 4.81 / 5.90 s | 19.1 | 11.3 (10.6–14.2) | 250–450 / 800–1200 / 1650–2650 | 444–833 MB |
| 200 / 2000 | 196 at 95% cutoff, **200/200 alive**, 0 failures | **2000** | 9.02 / 12.94 s | **16.2–17.3** | 64.2 (58.3–119.9) | 400–500 / 1150–1300 / 3050–3100 | 500–805 MB (WS 1.43–1.46 GB) |
| soak 10 / 200, 120 s, 6 churn cycles | 10/10 | 200 (201 in last 2 samples) | 1.73 / 2.23 s | 20.0 | baseline med 3.4; soak med 3.3 (max 3.9) | 150–250 / 450–900 / 950–3200 | 322–831 MB |
'@
$c = $c.Replace($old, $new)

$old = @'
Honest interpretation:
- 200 bots / 2000 items on this 8-thread desktop CPU **degrades the whole server** to
  16–17 TPS; the server does not crash, all 200 bots stayed alive and 2000 items were
  registered/hidden, but this is not a recommended production capacity for this hardware.
- BaseHider's own security work stayed bounded (p99 2.1–3.2 ms) and is a small fraction of
  the 64 ms server tick at that tier; the dominant cost is 200 bot connections/entity/chunk
  load on a desktop CPU (PacketEvents also processes every packet).
- The soak run above hit a bug in the **test harness** while churning items after the
  baseline phase (`load-bench.js` churn path); baseline samples are valid. A fixed rerun is
  recorded with the load harness report when available; treat the soak as PARTIAL until then.
- These numbers must not be presented as a 200-player production benchmark: the machine is
  a shared desktop, bots are not real clients, and no anti-cheat/client rendering is
  involved. They demonstrate bounded behavior and survival, not capacity.
'@
$new = @'
Honest interpretation:
- 200 bots / 2000 items on this 8-thread desktop CPU **degrades the whole server** to
  16–17 TPS; the server does not crash, all 200 bots stayed alive and 2000 items were
  registered/hidden, but this is not a recommended production capacity for this hardware.
- BaseHider's own security work stayed bounded (p99 3.05–3.1 ms) and is a small fraction of
  the ~64 ms server tick at that tier; the dominant cost is 200 bot connections/entity/chunk
  load on a desktop CPU (PacketEvents also processes every packet).
- The soak tier ran the full 120 s with **6/6 item churns successful** (kill 200 + summon 200
  per cycle, 142–173 ms per function call), TPS stayed 20.0, heap stayed within 831 MB.
  The first soak attempt hit a bug in the test harness churn path; it was fixed and rerun;
  the reported soak JSON is the successful rerun.
- The `itemEvals` diagnostic counter stayed 0 while bots were idle (2 in the last soak
  samples); the spawn-storm lane is observable through `itemStormBatches`/`itemStormMaxDepth`
  (2/512 at 50 bots, 4/512 at 200 bots, 1→9/200 during soak churns). Item protection state
  (tracked count, no spawn leak, gateway ACTIVE, 0 errors) remained correct.
- These numbers must not be presented as a 200-player production benchmark: the machine is
  a shared desktop, bots are not real clients, and no anti-cheat/client rendering is
  involved. They demonstrate bounded behavior and survival, not capacity.
'@
$c = $c.Replace($old, $new)

# final artifact sha / version (new clean build F2CA...)
$old = @'
Final artifact: `D:\Basehider\dist\BaseHider-3.2.0.jar` sha256
`cf3cc53e7529e35b7dbc801773eba3bf8c8d02dc7e0028cf89bbe3aa1191808c`
(6,797,418 bytes). It is the exact jar used for the final packet-level integration run and
for the 3.2.0 benchmark evidence listed above.
'@
$new = @'
Final artifact: `D:\Basehider\dist\BaseHider-3.2.0.jar` sha256
`f2ca7a488d358d5b5db32394b9ebb787af27dd4938dcb3019dee9431e35baf79`
(6,797,780 bytes). It is the jar used for the final packet-level integration run. The load
tests and 3.2.0 benchmark were run on the previous 3.2.0 build (`cf3cc53e…`); comparing
plugin classes shows only 2 of 3466 class files differ (the `/basehider diag` output and a
console color string in `BaseHiderPlugin`), so all security/engine code is identical.
'@
$c = $c.Replace($old, $new)

[System.IO.File]::WriteAllText($f, $c)
Write-Host 'load and artifact sections updated'
