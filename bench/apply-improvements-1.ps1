$ErrorActionPreference = 'Stop'
$root = 'D:\Basehider\basehider-v3-integrated\src\main\java\dev\audismp\basehider'

# 1) PacketGateway interface: add warmupMaterialMappings
$f = "$root\packet\PacketGateway.java"
$c = [System.IO.File]::ReadAllText($f)
$old = @'
    /** Number of protected positions currently detected by the packet layer, not yet indexed. */
'@
$new = @'
    /**
     * Pre-loads PacketEvents block-state mappings and the configured protected materials so
     * the first player/chunk send does not pay lazy mapping/class-load cost.
     * @return number of resolved materials (0 when the gateway is unavailable)
     */
    int warmupMaterialMappings();

    /** Number of protected positions currently detected by the packet layer, not yet indexed. */
'@
$c = $c.Replace($old, $new)
[System.IO.File]::WriteAllText($f, $c)

# 2) Unavailable gateway: implement it
$f = "$root\packet\PacketGatewayFactory.java"
$c = [System.IO.File]::ReadAllText($f)
$old = @'
        @Override
        public int detectedPendingCount() {
'@
$new = @'
        @Override
        public int warmupMaterialMappings() {
            return 0;
        }

        @Override
        public int detectedPendingCount() {
'@
$c = $c.Replace($old, $new)
[System.IO.File]::WriteAllText($f, $c)

# 3) PacketEventsGateway: implement it (before detectedPendingCount)
$f = "$root\packet\PacketEventsGateway.java"
$c = [System.IO.File]::ReadAllText($f)
$old = @'
    @Override
    public int detectedPendingCount() {
'@
$new = @'
    @Override
    public int warmupMaterialMappings() {
        BaseHiderConfig config = plugin.config();
        Set<String> bareNames = new HashSet<>();
        Set<Material> fillers = new HashSet<>();
        for (WorldSettings settings : config.worlds().values()) {
            if (!settings.blocksEnabled()) {
                continue;
            }
            for (Material material : settings.blockProtection().hiddenMaterials()) {
                bareNames.add(material.name().toLowerCase(Locale.ROOT));
            }
            fillers.add(settings.blockProtection().filler());
        }
        if (bareNames.isEmpty()) {
            return 0;
        }
        try {
            return materialCache.warmup(ClientVersion.V_1_21_4, bareNames, fillers);
        } catch (RuntimeException ex) {
            metrics.recordInternalError();
            plugin.getLogger().log(Level.WARNING,
                    "Packet-layer material warmup failed; lazy resolution will be used", ex);
            return 0;
        }
    }

    @Override
    public int detectedPendingCount() {
'@
$c = $c.Replace($old, $new)
[System.IO.File]::WriteAllText($f, $c)

# 4) Plugin: material warmup in warmupRuntimeOnce
$f = "$root\BaseHiderPlugin.java"
$c = [System.IO.File]::ReadAllText($f)
$c = $c.Replace('    private boolean warmedUp;', '    private boolean warmedUp;' + "`n" + '    private boolean packetWarmupDone;')
$old = @'
            for (String name : new String[]{"chest", "barrel", "spawner", "stone", "air"}) {
                dev.audismp.basehider.packet.PacketMaterialCache.normalize(name);
            }
            return true;
'@
$new = @'
            for (String name : new String[]{"chest", "barrel", "spawner", "stone", "air"}) {
                dev.audismp.basehider.packet.PacketMaterialCache.normalize(name);
            }
            if (!packetWarmupDone && packetGateway != null) {
                int resolved = packetGateway.warmupMaterialMappings();
                packetWarmupDone = true;
                if (config.debug().verboseErrors() && resolved > 0) {
                    getLogger().info("Warmed " + resolved + " packet material mappings");
                }
            }
            return true;
'@
$c = $c.Replace($old, $new)
[System.IO.File]::WriteAllText($f, $c)

Write-Host 'material warmup wired'
