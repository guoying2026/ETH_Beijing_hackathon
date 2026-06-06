import type { ScheduleEntry } from './types.js';

/**
 * Min-heap of ScheduleEntry keyed by deadline, with a parallel Map for O(1)
 * dedup / removal by orderKey. The heap stores entry pointers; the Map is the
 * source of truth — heap slots may go stale and are skipped on pop.
 *
 * Invariants:
 *   - entries.get(key)?.orderKey === key
 *   - every entry in `entries` is present in `heap` (possibly with a stale twin)
 *   - heap may contain stale references for entries that were removed/updated;
 *     popDue() filters them out by re-checking `entries`
 */
export class Schedule {
  private heap: ScheduleEntry[] = [];
  private entries = new Map<string, ScheduleEntry>();

  /** Number of distinct (non-stale) entries currently tracked. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Add or update an entry. If the orderKey already exists, the new entry
   * replaces the old one — the stale heap slot is left in place and skipped
   * at pop time. Returns true if this was a new key, false on update.
   */
  add(entry: ScheduleEntry): boolean {
    const isNew = !this.entries.has(entry.orderKey);
    this.entries.set(entry.orderKey, entry);
    this.heapPush(entry);
    return isNew;
  }

  /** Remove an entry by key. Returns true if it was present. */
  remove(orderKey: string): boolean {
    return this.entries.delete(orderKey);
  }

  /** Look up an entry without mutating state. */
  get(orderKey: string): ScheduleEntry | undefined {
    return this.entries.get(orderKey);
  }

  /** Snapshot all current (non-stale) entries — heap order NOT preserved. */
  toArray(): ScheduleEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Pop every entry whose `deadline + grace <= nowSeconds`, in min-heap order
   * (earliest deadline first). Stale heap slots are silently dropped.
   */
  popDue(nowSeconds: bigint, graceSeconds: bigint): ScheduleEntry[] {
    const due: ScheduleEntry[] = [];
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      // Skip stale slot (entry was removed or replaced).
      if (this.entries.get(top.orderKey) !== top) {
        this.heapPop();
        continue;
      }
      if (top.deadline + graceSeconds > nowSeconds) {
        break;
      }
      this.heapPop();
      this.entries.delete(top.orderKey);
      due.push(top);
    }
    return due;
  }

  /** Peek the earliest non-stale deadline, or undefined if empty. */
  peekDeadline(): bigint | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      if (this.entries.get(top.orderKey) === top) {
        return top.deadline;
      }
      this.heapPop();
    }
    return undefined;
  }

  // ── Serialization ───────────────────────────────────────────────────────

  /** Plain-JSON snapshot for persistence. BigInts are stringified. */
  serialize(): SerializedEntry[] {
    return this.toArray().map((e) => ({
      orderKey: e.orderKey,
      merchant: e.merchant,
      productId: e.productId.toString(),
      assetType: e.assetType,
      orderId: e.orderId.toString(),
      deadline: e.deadline.toString(),
    }));
  }

  /** Restore from a serialized snapshot, discarding any current state. */
  static fromSerialized(raw: SerializedEntry[]): Schedule {
    const s = new Schedule();
    for (const r of raw) {
      s.add({
        orderKey: r.orderKey,
        merchant: r.merchant as `0x${string}`,
        productId: BigInt(r.productId),
        assetType: r.assetType,
        orderId: BigInt(r.orderId),
        deadline: BigInt(r.deadline),
      });
    }
    return s;
  }

  // ── Heap internals ──────────────────────────────────────────────────────

  private heapPush(e: ScheduleEntry): void {
    this.heap.push(e);
    this.siftUp(this.heap.length - 1);
  }

  private heapPop(): ScheduleEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.deadline <= this.heap[i]!.deadline) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.heap[l]!.deadline < this.heap[smallest]!.deadline) smallest = l;
      if (r < n && this.heap[r]!.deadline < this.heap[smallest]!.deadline) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest]!, this.heap[i]!];
      i = smallest;
    }
  }
}

export interface SerializedEntry {
  orderKey: string;
  merchant: string;
  productId: string;
  assetType: number;
  orderId: string;
  deadline: string;
}
