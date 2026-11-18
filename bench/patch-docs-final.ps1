$ErrorActionPreference = 'Stop'
$base = 'D:\Basehider'

# 1) Final run block in report → rebuilt jar + measured latency
$f = "$base\docs\05-final-report.md"
$c = [System.IO.File]::ReadAllText($f)
$c = $c.Replace('### Final run (BaseHider 3.2.0, jar sha256 prefix `cf3cc53e7529`)',
                '### Final run (BaseHider 3.2.0, jar sha256 prefix `f2ca7a488d35`)')
$c = $c.Replace('latency=51ms; followups=8', 'latency=9ms; followups=8')
[System.IO.File]::WriteAllText($f, $c)

# 2) docs/06: final harness + load test section
$f = "$base\docs\06-v3.2-improvements.md"
$c = [System.IO.File]::ReadAllText($f)
$c = $c.Replace(@'
- Integration harness on the 3.2.0 jar: see `docs/evidence/` and the final report.
'@, @'
- Integration harness on the final 3.2.0 jar
  (sha `f2ca7a488d35…`, rebuilt after the diagnostics-line fix): **PASS** —
  A hidden (0 spawn packets), B visible (9 ms reveal), C chest hidden in decoded chunk data.
- Load test (isolated server, ports 25601/25600; delivered build):
  10/200, 50/1000 and 200/2000 bots/items tiers + a 120 s soak with 6/6 item churn cycles.
  The 200-bot tier is feasible on the shared 8-thread desktop but degrades TPS to 16.2–17.3;
  BaseHider's own tick stayed bounded (p99 3.05–3.1 ms). Full table in
  `docs/05-final-report.md` §7 and `bench/README-load-test.md`.
'@)
[System.IO.File]::WriteAllText($f, $c)

# 3) Dist README sha
$readme = @'
BaseHider 3.2.0 - delivery folder
=================================
BaseHider-3.2.0.jar   server plugin (shaded, relocated FastUtil)
sha256                f2ca7a488d358d5b5db32394b9ebb787af27dd4938dcb3019dee9431e35baf79
size                  6,797,780 bytes

Requirements: Paper 1.21.4, Java 21, PacketEvents plugin 2.14.0+ installed separately.
Source:       D:\Basehider\basehider-v3-integrated
Docs:         D:\Basehider\docs (audit, architecture, test plan, dependencies,
              final report, 3.2.0 follow-up improvements)
Evidence:     D:\Basehider\docs\evidence (packet-test reports, benchmarks, load tests,
              jar inspection)
Integration : D:\Basehider\itest (reproducible Paper 1.21.4 + headless-client harness)
Benchmarks  : D:\Basehider\bench (run-bench.js, mspt-bench.js, load-bench.js + JSON evidence;
              load server dir/ports 25601/25600, separate from itest)

Verification:
  mvn -B clean verify                 -> BUILD SUCCESS, 75 tests, 0 failures
  itest (baseline v3 jar)             -> PASS in baseline mode (A/C LEAK detected)
  itest (this jar)                    -> PASS all scenarios (A hidden 0 packets, B visible,
                                         9 ms reveal, C chest absent from decoded chunk data)
  load tiers                          -> 10/200 ok, 50/1000 ok (TPS 19.1),
                                         200/2000 survived (TPS 16.2-17.3 on desktop),
                                         120 s soak 6/6 churn ok
  /basehider export                   -> async diagnostics.json snapshot (non-security work)
'@
Set-Content "$base\dist\README.txt" $readme -Encoding UTF8

# 4) docs/03 final results block update
$f = "$base\docs\03-test-plan.md"
$c = [System.IO.File]::ReadAllText($f)
$c = $c.Replace('- Integration harness, BaseHider 3.1.0: **PASS** —', '- Integration harness, BaseHider 3.2.0: **PASS** —')
$c = $c.Replace('  B VISIBLE (1 spawn per client, reveal latency 22 ms in the latest run),', '  B VISIBLE (1 spawn per client, reveal latency 9 ms in the final run),')
$c = [System.IO.File]::ReadAllText($f)
if ($c -notmatch 'Load-test harness') {
    $c += @'

## 7. Load-test harness (3.2.0)

`bench/load-bench.js` + `bench/load-bot.js` (isolated server dir/ports 25601/25600,
datapack item bursts, capture-free bots). Measured tiers (delivered build):

| Tier | bots | items | TPS | server MSPT 5 s avg med | BaseHider p99 med |
|---|---|---|---|---|---|
| smoke | 10 | 200 | 20.0 | 4.6 ms | 3.2 ms |
| mid | 50 | 1000 | 19.1 | 11.3 ms | 2.1 ms |
| max | 200 | 2000 | 16.2-17.3 | 64.2 ms | 3.1 ms |
| soak | 10 | 200 | 20.0 | 3.3 ms | 3.2 ms |

200 bots / 2000 items is feasible on the shared 8-thread desktop but degrades TPS; this is
evidence of bounded behavior/survival, not a production capacity claim.
'@
    [System.IO.File]::WriteAllText($f, $c)
}
Write-Host 'docs patched'
