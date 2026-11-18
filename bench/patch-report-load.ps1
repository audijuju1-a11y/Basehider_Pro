$ErrorActionPreference = 'Stop'
$f = 'D:\Basehider\docs\05-final-report.md'
$c = [System.IO.File]::ReadAllText($f)

$anchor = @'
### BaseHider's own tick cost (`/basehider diag`, steady window after warm-up)
'@
$load = @'
### 3.2.0 load test (separate load server, ports 25601/25600)

Hardware: Intel Core i3-10105F (4 cores / 8 threads), 16 GB RAM, Windows 11; same JVM/Paper
as above. Harness `bench/load-bench.js` + `bench/load-bot.js` (capture-free headless bots),
items summoned in one `datapack` function call so the storm lane is exercised. All runs are
on the delivered 3.2.0 jar (sha `cf3cc53e…`).

| Tier | Bots spawned/alive | Items tracked | Join p95 | TPS | Server MSPT (5 s avg) med/p95 | BaseHider p99 med | Heap used (of 2 GB) |
|---|---|---|---|---|---|---|---|
| 10 / 200 | 10 / 10 | 200 | 1.49 s | 20.0 | 4.6 / 6.0 ms | 3.2 ms | 566 MB |
| 50 / 1000 | 50 / 50 | 1000 | 5.90 s | 19.1 | 11.3 / 13.6 ms | 2.1 ms | 628 MB |
| 200 / 2000 | 196 spawned, 200 alive | 2000 | 12.9 s | 16.2–17.3 | 64.2 / 106 ms | 3.1 ms | 681 MB |
| soak 10 / 200, 120 s (baseline phase) | 10 / 10 | 200 | 1.51 s | 20.0 | 2.65 / 7.4 ms | 0.8 ms | 520 MB |

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

Raw: `bench/load-*.json`, `bench/README-load-test.md`.

### BaseHider's own tick cost (`/basehider diag`, steady window after warm-up)
'@
$c = $c.Replace($anchor, $load)

# Add load test evidence files to reproduce section
$old = @'
# load-test harness (separate server dir/ports; see bench/README-load-test.md)
node D:\Basehider\bench\load-bench.js --bots 100 --items 2000 --label tier100-2000
'@
$new = @'
# load-test harness (separate server dir/ports 25601/25600; see bench/README-load-test.md)
node D:\Basehider\bench\load-bench.js --bots 200 --items 2000 --label max200-2000
node D:\Basehider\bench\load-bench.js --bots 10 --items 200 --label soak10-200 --soak-seconds 120
'@
$c = $c.Replace($old, $new)

[System.IO.File]::WriteAllText($f, $c)
Write-Host 'load section added'
