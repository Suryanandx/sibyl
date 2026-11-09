/**
 * In-app budgets → the usage meter. The organization budget lives in the
 * organization settings (Admin → Organization), workspace budgets on each
 * workspace record (Settings → Workspace); this reads both from the store
 * and hands them to the meter, at start and after every change. The meter
 * keeps enforcing them (check(), the 85% economy switch); the env caps
 * stay the upper bound for the organization.
 */
import { cleanSpendCaps, readOrgSettings, type AppBudgets, type Store, type UsageMeter } from "@open-gpt-live/core";

export async function readAppBudgets(store: Store, ownerId: string): Promise<AppBudgets> {
  const [settings, workspaces] = await Promise.all([readOrgSettings(store, ownerId), store.workspaces.list(ownerId)]);
  const perWorkspace: NonNullable<AppBudgets["workspaces"]> = {};
  for (const workspace of workspaces) {
    const caps = cleanSpendCaps(workspace.budget);
    if (caps) perWorkspace[workspace.id] = caps;
  }
  return { ...(settings.budget ? { org: settings.budget } : {}), workspaces: perWorkspace };
}

/** Load the in-app budgets into the meter (meters without budgets ignore it). */
export async function applyAppBudgets(meter: UsageMeter, store: Store, ownerId: string): Promise<void> {
  if (!meter.configureBudgets) return;
  meter.configureBudgets(await readAppBudgets(store, ownerId), ownerId);
}
