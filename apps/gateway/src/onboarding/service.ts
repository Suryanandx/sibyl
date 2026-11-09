/**
 * Onboarding: the first-run flow (/welcome/<step> in the web app) and the
 * "Getting started" checklist that stays in the sidebar afterwards.
 *
 * State lives in the organization's key-value store, so it resumes on any
 * device:
 * - per organization (`onboarding.org.v1`): when anyone first started, and
 *   the style (model preset) chosen;
 * - per person (`onboarding.person.<user id>.v1`, or "local" / "token" for
 *   the owner without an account): where they are, finished and skipped
 *   steps, when they finished, whether they dismissed the checklist, and when
 *   they first talked (once found, it isn't looked up again).
 *
 * Steps a person can't do are left out (permissions decide), and checklist
 * items tick themselves from real state: model access, a style chosen, a
 * connection, an agent, a knowledge document, a second person or an
 * invitation, and the person's first voice turn (usage records).
 */
import {
  DEFAULT_WORKSPACE_ID,
  PERMISSIONS,
  authorize,
  normalizeAvatar,
  randomAvatar,
  type Permission,
  type Principal,
  type Store
} from "@open-gpt-live/core";
import {
  CHECKLIST_ITEMS,
  ONBOARDING_STEPS,
  type ChecklistItemId,
  type ChecklistItemView,
  type ModelAccessView,
  type OnboardingPatch,
  type OnboardingStepId,
  type OnboardingView
} from "@open-gpt-live/protocol";
import { IdentityError, type IdentityService } from "../identity/service.js";

const ORG_KEY = "onboarding.org.v1";
const personKey = (person: string) => `onboarding.person.${person}.v1`;
/** How far back the first voice turn is looked for. */
const VOICE_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const NAME_MAX = 80;

interface OrgState {
  startedAt?: number;
  presetId?: string;
}

interface PersonState {
  startedAt?: number;
  completedAt?: number;
  current?: OnboardingStepId;
  done: OnboardingStepId[];
  skipped: OnboardingStepId[];
  presetId?: string;
  checklistDismissed?: boolean;
  /** First voice turn (found in usage once, then remembered). */
  voiceAt?: number;
}

/** Who may do which step (and see its checklist item). */
const STEP_PERMISSION: Partial<Record<OnboardingStepId, Permission>> = {
  model: PERMISSIONS.ORG_SETTINGS,
  tools: PERMISSIONS.INTEGRATIONS_CONNECT_PERSONAL,
  agent: PERMISSIONS.AGENTS_CREATE,
  knowledge: PERMISSIONS.KNOWLEDGE_EDIT,
  team: PERMISSIONS.MEMBERS_INVITE
};

const CHECKLIST: Record<ChecklistItemId, { label: string; href: string; step?: OnboardingStepId }> = {
  model: { label: "Connect a model key", href: "/settings/models", step: "model" },
  style: { label: "Pick a style", href: "/settings/models", step: "style" },
  tool: { label: "Connect a tool", href: "/integrations", step: "tools" },
  agent: { label: "Create an agent", href: "/agents", step: "agent" },
  knowledge: { label: "Add knowledge", href: "/knowledge", step: "knowledge" },
  team: { label: "Invite your team", href: "/settings/members", step: "team" },
  voice: { label: "Talk to Sibyl", href: "/" }
};

export interface OnboardingServiceOptions {
  store: Store;
  orgId: string;
  identity: IdentityService;
  /** The organization's model access (tenancy/model-access.ts); absent: only the server key counts. */
  modelAccess?: () => Promise<ModelAccessView>;
  /** The server has OPENROUTER_API_KEY (used when there's no model access service). */
  serverKey: boolean;
  /** Connections this person can use in the workspace (connectors). */
  connections?: (principal: Principal, workspaceId: string) => number;
  now?: () => number;
}

export class OnboardingService {
  private readonly store: Store;
  private readonly orgId: string;
  private readonly now: () => number;

  constructor(private readonly options: OnboardingServiceOptions) {
    this.store = options.store;
    this.orgId = options.orgId;
    this.now = options.now ?? Date.now;
  }

  /** The person's steps, in order. */
  steps(principal: Principal, workspaceId: string): OnboardingStepId[] {
    return ONBOARDING_STEPS.filter((step) => {
      // Name and face belong to an account.
      if (step === "profile") return principal.kind === "user";
      const permission = STEP_PERMISSION[step];
      return !permission || authorize(principal, permission, { workspaceId });
    });
  }

  async view(principal: Principal, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<OnboardingView> {
    const [org, person] = await Promise.all([this.orgState(), this.personState(principal)]);
    const steps = this.steps(principal, workspaceId);
    const finished = new Set([...person.done, ...person.skipped]);
    const current = person.current && steps.includes(person.current) ? person.current : (steps.find((step) => !finished.has(step)) ?? steps[steps.length - 1]!);
    const presetId = person.presetId ?? org.presetId;
    const items = await this.checklist(principal, workspaceId, steps, person, presetId);
    const doneCount = items.filter((item) => item.done).length;
    const complete = doneCount === items.length;
    const dismissed = Boolean(person.checklistDismissed);
    const user = principal.kind === "user" && principal.userId ? await this.store.identity.users.get(this.orgId, principal.userId) : undefined;
    return {
      steps,
      current,
      done: person.done.filter((step) => steps.includes(step)),
      skipped: person.skipped.filter((step) => steps.includes(step)),
      ...(person.startedAt !== undefined ? { startedAt: person.startedAt } : {}),
      ...(person.completedAt !== undefined ? { completedAt: person.completedAt } : {}),
      pending: person.startedAt !== undefined && person.completedAt === undefined,
      fresh: org.startedAt === undefined,
      ...(presetId ? { presetId } : {}),
      profile: {
        name: user?.name ?? principal.name ?? "",
        avatar: user?.avatar ?? randomAvatar(user?.id ?? principal.userId ?? principal.kind)
      },
      checklist: {
        items,
        doneCount,
        total: items.length,
        dismissed,
        complete,
        visible: person.startedAt !== undefined && !dismissed && !complete
      }
    };
  }

  async update(principal: Principal, workspaceId: string, patch: OnboardingPatch): Promise<OnboardingView> {
    const steps = this.steps(principal, workspaceId);
    const step = (value: unknown): OnboardingStepId | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !steps.includes(value as OnboardingStepId)) throw new IdentityError(400, "invalid_step", "That step isn't part of your setup.");
      return value as OnboardingStepId;
    };
    const current = step(patch.current);
    const done = step(patch.done);
    const skipped = step(patch.skipped);
    const now = this.now();
    const person = await this.personState(principal);
    const next: PersonState = { ...person, done: [...person.done], skipped: [...person.skipped] };
    if (patch.start || current || done || skipped || patch.complete) next.startedAt ??= now;
    if (current) next.current = current;
    if (done) {
      next.done = unique([...next.done, done]);
      next.skipped = next.skipped.filter((id) => id !== done);
    }
    if (skipped && !next.done.includes(skipped)) next.skipped = unique([...next.skipped, skipped]);
    if (patch.complete) next.completedAt ??= now;
    if (typeof patch.checklistDismissed === "boolean") next.checklistDismissed = patch.checklistDismissed;
    if (patch.presetId !== undefined) {
      if (typeof patch.presetId !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(patch.presetId)) throw new IdentityError(400, "invalid_preset", "Choose one of the styles.");
      next.presetId = patch.presetId;
    }
    await this.store.kv.set(this.orgId, personKey(this.personId(principal)), next);
    const org = await this.orgState();
    if ((next.startedAt !== undefined && org.startedAt === undefined) || (next.presetId && !org.presetId)) {
      await this.store.kv.set(this.orgId, ORG_KEY, { ...org, startedAt: org.startedAt ?? next.startedAt, ...(org.presetId || next.presetId ? { presetId: org.presetId ?? next.presetId } : {}) });
    }
    return this.view(principal, workspaceId);
  }

  /** Name and face (the Welcome step; people without an account have neither). */
  async setProfile(principal: Principal, workspaceId: string, input: { name?: unknown; avatar?: unknown }): Promise<OnboardingView> {
    if (principal.kind !== "user" || !principal.userId) throw new IdentityError(400, "not_a_user", "Create an account first.");
    const user = await this.store.identity.users.get(this.orgId, principal.userId);
    if (!user) throw new IdentityError(404, "not_found", "Account not found.");
    const next = { ...user };
    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
      if (!name) throw new IdentityError(400, "invalid_name", "Enter your name.");
      next.name = name;
    }
    if (input.avatar !== undefined) next.avatar = normalizeAvatar(input.avatar, user.id);
    await this.store.identity.users.upsert(next);
    // Open connections (the rail, Members lists) pick up the new name and face.
    this.options.identity.notifyChange({ kind: "user", userId: user.id });
    return this.view(principal, workspaceId);
  }

  /* ───────────── checklist ───────────── */

  private async checklist(principal: Principal, workspaceId: string, steps: OnboardingStepId[], person: PersonState, presetId: string | undefined): Promise<ChecklistItemView[]> {
    const ids = CHECKLIST_ITEMS.filter((id) => {
      const step = CHECKLIST[id].step;
      // Steps left out (no permission) leave out their item; the profile isn't an item.
      return !step || steps.includes(step);
    });
    const done = await Promise.all(ids.map((id) => this.isDone(id, principal, workspaceId, person, presetId)));
    return ids.map((id, index) => ({ id, label: CHECKLIST[id].label, href: CHECKLIST[id].href, done: done[index]! }));
  }

  private async isDone(id: ChecklistItemId, principal: Principal, workspaceId: string, person: PersonState, presetId: string | undefined): Promise<boolean> {
    switch (id) {
      case "model":
        return this.modelReady();
      case "style":
        return Boolean(presetId);
      case "tool":
        return (this.options.connections?.(principal, workspaceId) ?? 0) > 0;
      case "agent":
        return (await this.store.agents.list(this.orgId, { workspaceId, ...(principal.userId ? { visibleTo: principal.userId } : {}) })).length > 0;
      case "knowledge":
        for (const base of await this.store.knowledge.listBases(this.orgId, { workspaceId })) {
          if ((await this.store.knowledge.listDocs(this.orgId, base.id)).length > 0) return true;
        }
        return false;
      case "team":
        return (await this.store.identity.users.count(this.orgId)) > 1 || (await this.store.identity.invites.list(this.orgId)).length > 0;
      case "voice":
        return this.talked(principal, person);
    }
  }

  private async modelReady(): Promise<boolean> {
    if (!this.options.modelAccess) return this.options.serverKey;
    try {
      const access = await this.options.modelAccess();
      if (access.key) return true;
      if (access.mode === "credits") return (access.credits?.balanceUsd ?? 0) > 0;
      return access.mode === "server" && access.serverKey;
    } catch {
      return this.options.serverKey;
    }
  }

  /** The person's first voice turn (voice brain or transcription usage), remembered once found. */
  private async talked(principal: Principal, person: PersonState): Promise<boolean> {
    if (person.voiceAt !== undefined) return true;
    const now = this.now();
    const who = this.personId(principal);
    const events = await this.store.usage.list(this.orgId, now - VOICE_LOOKBACK_MS, now + 1);
    const first = events.find((event) => (event.feature === "voice" || event.feature === "stt") && (event.userId ?? "local") === who);
    if (!first) return false;
    await this.store.kv.set(this.orgId, personKey(who), { ...person, voiceAt: first.at });
    return true;
  }

  /* ───────────── state ───────────── */

  private personId(principal: Principal): string {
    return principal.userId ?? principal.kind;
  }

  private async orgState(): Promise<OrgState> {
    return (await this.store.kv.get<OrgState>(this.orgId, ORG_KEY)) ?? {};
  }

  private async personState(principal: Principal): Promise<PersonState> {
    const stored = await this.store.kv.get<Partial<PersonState>>(this.orgId, personKey(this.personId(principal)));
    const steps = (value: unknown): OnboardingStepId[] =>
      Array.isArray(value) ? value.filter((step): step is OnboardingStepId => (ONBOARDING_STEPS as readonly string[]).includes(step)) : [];
    return {
      ...(typeof stored?.startedAt === "number" ? { startedAt: stored.startedAt } : {}),
      ...(typeof stored?.completedAt === "number" ? { completedAt: stored.completedAt } : {}),
      ...(typeof stored?.current === "string" && (ONBOARDING_STEPS as readonly string[]).includes(stored.current) ? { current: stored.current } : {}),
      done: steps(stored?.done),
      skipped: steps(stored?.skipped),
      ...(typeof stored?.presetId === "string" ? { presetId: stored.presetId } : {}),
      ...(stored?.checklistDismissed ? { checklistDismissed: true } : {}),
      ...(typeof stored?.voiceAt === "number" ? { voiceAt: stored.voiceAt } : {})
    };
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
