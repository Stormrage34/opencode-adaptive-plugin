// RecentOpsCache — O(1) TTL cache for sliding window deduplication
// Linked list for FIFO eviction, Map for O(1) lookup

export class RecentOpsCache {
  private map = new Map<string, { ts: number; prev?: string; next?: string }>()
  private head: string | null = null
  private tail: string | null = null
  private window: number

  constructor(window: number) {
    this.window = window
  }

  get(key: string): number | undefined {
    const entry = this.map.get(key)
    return entry?.ts
  }

  set(key: string, ts: number) {
    if (this.map.has(key)) {
      // Update timestamp and move to tail
      const node = this.map.get(key)!
      node.ts = ts
      this._removeNode(key)
      this._appendNode(key)
      return
    }
    // New entry
    const node = { ts }
    this.map.set(key, node)
    this._appendNode(key)
  }

  cleanup() {
    const now = Date.now()
    while (this.head) {
      const node = this.map.get(this.head)
      if (!node) {
        this.head = null
        break
      }
      if (now - node.ts <= this.window) break
      // Remove stale head
      const oldKey = this.head
      this._removeNode(oldKey)
      this.map.delete(oldKey)
    }
  }

  private _removeNode(key: string) {
    const node = this.map.get(key)
    if (!node) return
    const prevKey = node.prev
    const nextKey = node.next
    if (prevKey) {
      const prevNode = this.map.get(prevKey)
      if (prevNode) prevNode.next = nextKey
    } else {
      // This was head
      this.head = nextKey ?? null
    }
    if (nextKey) {
      const nextNode = this.map.get(nextKey)
      if (nextNode) nextNode.prev = prevKey
    } else {
      // This was tail
      this.tail = prevKey ?? null
    }
    node.prev = undefined
    node.next = undefined
  }

  private _appendNode(key: string) {
    const node = this.map.get(key)
    if (!node) return
    node.prev = this.tail ?? undefined
    node.next = undefined
    if (this.tail) {
      const tailNode = this.map.get(this.tail)
      if (tailNode) tailNode.next = key
    }
    this.tail = key
    if (!this.head) {
      this.head = key
    }
  }
}
