// ToolStatsCache — in-memory LRU cache for tool reliability stats
// Zero DB I/O in hot path (tool.definition). Async refresh via 30s interval.

const CACHE_TTL = 30_000 // 30 seconds

interface CacheEntry {
  successRate: number
  totalCalls: number
  lastUpdated: number
}

export class ToolStatsCache {
  private cache = new Map<string, CacheEntry>()
  private dirty = new Set<string>()

  /** Read from cache. Returns null on complete miss (cold start only). */
  get(toolName: string): { successRate: number; totalCalls: number } | null {
    const entry = this.cache.get(toolName)
    if (!entry) return null
    // Return stale data if TTL expired — mark for async refresh, don't block
    if (Date.now() - entry.lastUpdated > CACHE_TTL) {
      this.dirty.add(toolName)
    }
    return { successRate: entry.successRate, totalCalls: entry.totalCalls }
  }

  /** Populate or update an entry. Clears dirty flag. */
  set(toolName: string, data: { successRate: number; totalCalls: number }): void {
    this.cache.set(toolName, { ...data, lastUpdated: Date.now() })
    this.dirty.delete(toolName)
  }

  /** Mark tool as needing refresh on next cycle. Called after observe() write. */
  invalidate(toolName: string): void {
    this.dirty.add(toolName)
  }

  /** Get all tools pending refresh. */
  getDirty(): string[] {
    return [...this.dirty]
  }

  /** Evict entries untouched for 2x TTL. Returns number of evictions. */
  cleanup(): number {
    const cutoff = Date.now() - CACHE_TTL * 2
    const keys = Array.from(this.cache.keys())
    let evicted = 0
    for (const key of keys) {
      const entry = this.cache.get(key)
      if (entry && entry.lastUpdated < cutoff && !this.dirty.has(key)) {
        this.cache.delete(key)
        evicted++
      }
    }
    return evicted
  }
}
