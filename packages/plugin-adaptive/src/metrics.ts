// Internal metrics counters for the adaptive plugin
// These are in-memory and reset on plugin reload

export const metrics = {
  totalInserted: 0,
  duplicateAttempts: 0,
  duplicateWarnings: 0,
  ttlCleanupRuns: 0,
  ttlRecordsDeleted: 0,
  queryStatsCalls: 0,
  queryRecentCalls: 0,
  queryTrendsCalls: 0,
  queryToolStatsCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheRefreshRuns: 0,
  cacheRefreshed: 0,
  hintsDelivered: 0,
  compactionContextsInjected: 0,
  abandonmentPenalties: 0,
  dbErrors: 0,
  validationQueueDrops: 0,
  iterationGuardTriggers: 0,
  iterationPenalties: 0,
} as const;




export function resetMetrics() {
  metrics.totalInserted = 0
  metrics.duplicateAttempts = 0
  metrics.duplicateWarnings = 0
  metrics.ttlCleanupRuns = 0
  metrics.ttlRecordsDeleted = 0
  metrics.queryStatsCalls = 0
  metrics.queryRecentCalls = 0
  metrics.queryTrendsCalls = 0
  metrics.queryToolStatsCalls = 0
  metrics.cacheHits = 0
  metrics.cacheMisses = 0
  metrics.cacheRefreshRuns = 0
  metrics.cacheRefreshed = 0
  metrics.cacheEvictions = 0
  metrics.hintsDelivered = 0
  metrics.compactionContextsInjected = 0
  metrics.abandonmentPenalties = 0
  metrics.dbErrors = 0
  metrics.iterationGuardTriggers = 0
  metrics.iterationPenalties = 0
}
