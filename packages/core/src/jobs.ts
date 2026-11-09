/**
 * Scheduled job types: units of work that run on the gateway's one scheduler
 * (the routine scheduler's tick, lease and heartbeat machinery). Monitors use
 * it; enterprise modules (e.g. data retention) plug in the same way.
 */

export interface ScheduledJob {
  id: string;
}

/** A second (third, …) job type run on the routine scheduler's tick and lease machinery. */
export interface ScheduledJobType<J extends ScheduledJob = ScheduledJob> {
  readonly kind: string;
  /** Concurrent jobs of this type (default 2). */
  readonly maxConcurrency?: number;
  /** Jobs due now (the scheduler skips ones it is already running). */
  due(now: number): Promise<J[]>;
  /** Take the job: set its lease and move its next time. undefined: someone else holds it, or it is gone. */
  claim(job: J, now: number, leaseUntil: number): Promise<J | undefined>;
  /** Extend the lease (heartbeat while the job runs). */
  renew(job: J, leaseUntil: number): Promise<void>;
  run(job: J, signal: AbortSignal): Promise<void>;
  /** Clear the lease (always called after run). */
  release(job: J): Promise<void>;
  /** Clear leases that expired without a worker (crash, restart); called every tick. */
  recover?(now: number, active: ReadonlySet<string>): Promise<void>;
  /** Run ids with approvals that are still live (their pending approvals are not orphans). */
  liveRunIds?(): ReadonlySet<string>;
  /** Load a job for "run now". */
  get?(id: string): Promise<J | undefined>;
}
