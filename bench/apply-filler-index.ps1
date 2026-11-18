$ErrorActionPreference = 'Stop'
$f = 'D:\Basehider\basehider-v3-integrated\src\main\java\dev\audismp\basehider\index\HiddenBlockIndex.java'
$c = [IO.File]::ReadAllText($f)
$c = $c.Replace('import it.unimi.dsi.fastutil.longs.LongOpenHashSet;',
                "import it.unimi.dsi.fastutil.longs.LongOpenHashSet;`nimport org.bukkit.Material;")
$c = $c.Replace('    private final ConcurrentHashMap<Long, WorldIndex> worlds = new ConcurrentHashMap<>();',
@'
    private final ConcurrentHashMap<Long, WorldIndex> worlds = new ConcurrentHashMap<>();
    /** Per-world per-position client filler material (contextual filler mode). */
    private final ConcurrentHashMap<Long, ConcurrentHashMap<Long, Material>> fillers = new ConcurrentHashMap<>();
'@)
$c = $c.Replace('    /** Unregisters a single protected block. Returns true when the view changed. */',
@'
    /** Stores the client-side filler material chosen for one protected block. */
    public void setFiller(long worldId, long blockPos, Material material) {
        if (worldId == 0L || material == null) {
            return;
        }
        fillers.computeIfAbsent(worldId, id -> new ConcurrentHashMap<>()).put(blockPos, material);
    }

    /** Client-side filler for a protected block, or {@code fallback} when not chosen yet. */
    public Material filler(long worldId, long blockPos, Material fallback) {
        ConcurrentHashMap<Long, Material> worldFillers = fillers.get(worldId);
        if (worldFillers == null) {
            return fallback;
        }
        Material material = worldFillers.get(blockPos);
        return material == null ? fallback : material;
    }

    /** Unregisters a single protected block. Returns true when the view changed. */
'@)
$c = $c.Replace('    public boolean unregister(long worldId, long blockPos) {',
@'
    public boolean unregister(long worldId, long blockPos) {
        ConcurrentHashMap<Long, Material> worldFillers = fillers.get(worldId);
        if (worldFillers != null) {
            worldFillers.remove(blockPos);
        }
'@)
$c = $c.Replace('    public void evictWorld(long worldId) {
        worlds.remove(worldId);',
@'
    public void evictWorld(long worldId) {
        fillers.remove(worldId);
        worlds.remove(worldId);
'@)
$c = $c.Replace('    public void clear() {
        worlds.clear();',
@'
    public void clear() {
        fillers.clear();
        worlds.clear();
'@)
[IO.File]::WriteAllText($f, $c)
Write-Host 'index fillers added'
