/**
 * A lightweight session timeline per run: each browser action with a small
 * thumbnail, kept on disk so people can watch what an agent did afterwards
 * ($SIBYL_DATA_DIR/computers/<agentId>/runs/<runId>/). Full video recordings
 * are a Sibyl Enterprise feature and are not made here.
 */
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerActionView, ComputerRunView } from "@open-gpt-live/protocol";

/** Runs kept per agent (oldest are deleted). */
export const RUNS_KEPT = 30;
/** Actions recorded per run (later ones are dropped). */
export const ACTIONS_PER_RUN = 300;

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export class Timeline {
  constructor(private readonly root: string) {}

  private runsDir(agentId: string): string {
    return join(this.root, agentId, "runs");
  }

  /** Append an action (with an optional JPEG thumbnail). Returns false when the run is full. */
  async add(action: ComputerActionView, thumb?: Buffer): Promise<boolean> {
    if (!SAFE_ID.test(action.runId) || !SAFE_ID.test(action.agentId)) return false;
    const dir = join(this.runsDir(action.agentId), action.runId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "actions.jsonl");
    const existing = await readFile(file, "utf8").catch(() => "");
    if (existing.split("\n").filter(Boolean).length >= ACTIONS_PER_RUN) return false;
    if (!existing) await this.prune(action.agentId);
    const { thumb: _thumb, ...stored } = action;
    if (thumb) await writeFile(join(dir, `${action.id}.jpg`), thumb);
    await appendFile(file, `${JSON.stringify({ ...stored, ...(thumb ? { hasThumb: true } : {}) })}\n`);
    return true;
  }

  /** Runs, newest first. */
  async runs(agentId: string): Promise<ComputerRunView[]> {
    if (!SAFE_ID.test(agentId)) return [];
    const names = await readdir(this.runsDir(agentId)).catch(() => [] as string[]);
    const runs: ComputerRunView[] = [];
    for (const runId of names) {
      if (!SAFE_ID.test(runId)) continue;
      const actions = await this.read(agentId, runId);
      if (!actions.length) continue;
      runs.push({ runId, startedAt: actions[0]!.at, endedAt: actions.at(-1)!.at, actions: actions.length });
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** A run's actions in order, with thumbnails as base64. */
  async actions(agentId: string, runId: string): Promise<ComputerActionView[]> {
    if (!SAFE_ID.test(agentId) || !SAFE_ID.test(runId)) return [];
    const dir = join(this.runsDir(agentId), runId);
    const out: ComputerActionView[] = [];
    for (const { hasThumb, ...action } of await this.read(agentId, runId)) {
      const thumb = hasThumb ? await readFile(join(dir, `${action.id}.jpg`)).catch(() => undefined) : undefined;
      out.push({ ...action, ...(thumb ? { thumb: thumb.toString("base64") } : {}) });
    }
    return out;
  }

  private async read(agentId: string, runId: string): Promise<Array<ComputerActionView & { hasThumb?: boolean }>> {
    const text = await readFile(join(this.runsDir(agentId), runId, "actions.jsonl"), "utf8").catch(() => "");
    const out: Array<ComputerActionView & { hasThumb?: boolean }> = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ComputerActionView & { hasThumb?: boolean });
      } catch {
        // A torn last line after a crash.
      }
    }
    return out;
  }

  /** Keep the newest RUNS_KEPT - 1 runs (a new one is about to start). */
  private async prune(agentId: string): Promise<void> {
    const dir = this.runsDir(agentId);
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.length < RUNS_KEPT) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.at - a.at);
    for (const old of dated.slice(RUNS_KEPT - 1)) await rm(join(dir, old.name), { recursive: true, force: true });
  }
}
