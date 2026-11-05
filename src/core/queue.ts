export const Priority = {
  Background: 0,
  Visible: 1,
  Active: 2,
  User: 3,
} as const;

interface Job {
  priority: number;
  seq: number;
  run: () => Promise<void>;
}

/**
 * Runs keyed jobs with a concurrency limit, highest priority first.
 * Enqueuing a key that is already waiting only raises its priority.
 * Enqueuing a key that is running schedules one more run after it finishes,
 * so the last request always wins without piling up duplicate work.
 */
export class TaskQueue {
  private readonly waiting = new Map<string, Job>();
  private readonly running = new Set<string>();
  private readonly rerun = new Map<string, Job>();
  private seq = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private concurrency: number) {}

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.pump();
  }

  enqueue(key: string, priority: number, run: () => Promise<void>): void {
    if (this.running.has(key)) {
      const prev = this.rerun.get(key);
      this.rerun.set(key, { priority: Math.max(priority, prev?.priority ?? priority), seq: this.seq++, run });
      return;
    }
    const prev = this.waiting.get(key);
    if (prev) {
      prev.priority = Math.max(prev.priority, priority);
      prev.run = run;
    } else {
      this.waiting.set(key, { priority, seq: this.seq++, run });
    }
    this.pump();
  }

  has(key: string): boolean {
    return this.waiting.has(key) || this.running.has(key);
  }

  /** Jobs waiting or running. */
  get size(): number {
    return this.waiting.size + this.running.size;
  }

  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  clear(): void {
    this.waiting.clear();
    this.rerun.clear();
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.waiting.size > 0) {
      const [key, job] = this.pickNext();
      this.waiting.delete(key);
      this.running.add(key);
      job
        .run()
        .catch(() => undefined)
        .finally(() => this.finish(key));
    }
  }

  private pickNext(): [string, Job] {
    let best: [string, Job] | undefined;
    for (const entry of this.waiting) {
      const job = entry[1];
      if (!best || job.priority > best[1].priority || (job.priority === best[1].priority && job.seq < best[1].seq)) {
        best = entry;
      }
    }
    return best!;
  }

  private finish(key: string): void {
    this.running.delete(key);
    const again = this.rerun.get(key);
    if (again) {
      this.rerun.delete(key);
      this.waiting.set(key, again);
    }
    this.pump();
    if (this.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach(resolve => resolve());
    }
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}
