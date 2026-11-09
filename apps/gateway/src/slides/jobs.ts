/**
 * Deck builds started from the Slides page. A build keeps running when the
 * browser leaves the page (the money is being spent either way), so the
 * library can say "Deck ready · Open" when the user comes back. Only an
 * explicit cancel (Stop) aborts it. In memory: jobs are short-lived and a
 * gateway restart simply forgets them (the deck itself is in the store).
 * Each build belongs to the workspace it was started in.
 */
import { DEFAULT_WORKSPACE_ID } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";

export type SlidesJobStatus = "running" | "done" | "error" | "cancelled";

export interface SlidesJobView {
  id: string;
  title: string;
  status: SlidesJobStatus;
  startedAt: number;
  finishedAt?: number;
  artifact?: ToolArtifactView;
  message?: string;
}

interface SlidesJob extends SlidesJobView {
  workspaceId: string;
  /** The person who started the build (their "deck ready" notice). */
  userId?: string;
  controller: AbortController;
}

const KEEP_FINISHED_MS = 6 * 60 * 60 * 1000;
const MAX_JOBS = 50;

export class SlidesJobs {
  private readonly jobs = new Map<string, SlidesJob>();

  /** Called once when a build finishes (done, error or cancelled). */
  onFinished: ((job: Readonly<SlidesJob>) => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  start(id: string, title: string, workspaceId: string = DEFAULT_WORKSPACE_ID, userId?: string): SlidesJob {
    this.prune();
    const job: SlidesJob = {
      id,
      title,
      workspaceId,
      ...(userId ? { userId } : {}),
      status: "running",
      startedAt: this.now(),
      controller: new AbortController()
    };
    this.jobs.set(id, job);
    return job;
  }

  finish(id: string, outcome: { artifact: ToolArtifactView } | { error: string } | { cancelled: true }): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.finishedAt = this.now();
    if ("artifact" in outcome) {
      job.status = "done";
      job.artifact = outcome.artifact;
      job.title = outcome.artifact.title;
    } else if ("error" in outcome) {
      job.status = "error";
      job.message = outcome.error;
    } else {
      job.status = "cancelled";
    }
    try {
      this.onFinished?.(job);
    } catch {
      // A notice must never break the build's own bookkeeping.
    }
  }

  /** Stop a running build of this workspace (the Stop button). Returns false when there is nothing to stop. */
  cancel(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || job.workspaceId !== workspaceId) return false;
    job.controller.abort();
    this.finish(id, { cancelled: true });
    return true;
  }

  /** Builds of one workspace, newest first. */
  list(workspaceId: string = DEFAULT_WORKSPACE_ID): SlidesJobView[] {
    this.prune();
    return [...this.jobs.values()]
      .filter((job) => job.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ controller: _controller, workspaceId: _workspaceId, ...view }) => view);
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && (job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
    const finished = [...this.jobs.values()].filter((job) => job.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size > MAX_JOBS && finished.length) this.jobs.delete(finished.shift()!.id);
  }
}
