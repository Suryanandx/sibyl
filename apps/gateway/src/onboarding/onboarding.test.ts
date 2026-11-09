import { DEFAULT_WORKSPACE_ID, createMemoryStore, ownerPrincipal, randomAvatar, type Principal } from "@open-gpt-live/core";
import { describe, expect, test } from "vitest";
import { IdentityService } from "../identity/service.js";
import { OnboardingService } from "./service.js";

const PASSWORD = "correct horse battery";

async function setup(options: { serverKey?: boolean; connections?: number } = {}) {
  const store = createMemoryStore();
  let now = 1_000_000;
  const identity = new IdentityService({ store, orgId: "owner", now: () => now });
  const owner = await identity.setup({ email: "olive@example.com", name: "Olive", password: PASSWORD }, { ownerTokenOk: false });
  const ownerAuth = (await identity.resolveSession(owner.token))!;
  const onboarding = new OnboardingService({
    store,
    orgId: "owner",
    identity,
    serverKey: options.serverKey ?? false,
    connections: () => options.connections ?? 0,
    now: () => now
  });
  const { url } = await identity.createInvite(ownerAuth.principal, { workspaceId: DEFAULT_WORKSPACE_ID, role: "viewer" }, "http://app");
  const joined = await identity.acceptInvite(url.split("/invite/")[1]!, { name: "Vic", email: "vic@example.com", password: PASSWORD }, undefined);
  const viewer = (await identity.resolveSession(joined.token!))!.principal;
  return { store, identity, onboarding, owner: ownerAuth.principal, viewer, tick: (ms: number) => (now += ms) };
}

describe("onboarding", () => {
  test("steps follow permissions: viewers only get what they can do", async () => {
    const { onboarding, owner, viewer } = await setup();
    expect(onboarding.steps(owner, DEFAULT_WORKSPACE_ID)).toEqual(["profile", "model", "style", "tools", "agent", "knowledge", "team", "start"]);
    expect(onboarding.steps(viewer, DEFAULT_WORKSPACE_ID)).toEqual(["profile", "style", "start"]);
    // The owner without an account (local mode) has no profile to fill in.
    expect(onboarding.steps(ownerPrincipal("owner", "local"), DEFAULT_WORKSPACE_ID)[0]).toBe("model");
  });

  test("resumes where the person left off, per person, and finishes", async () => {
    const { onboarding, owner, viewer } = await setup();
    let view = await onboarding.view(owner);
    expect(view).toMatchObject({ current: "profile", pending: false, fresh: true, checklist: { visible: false } });
    view = await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { start: true, current: "profile" });
    expect(view).toMatchObject({ pending: true, fresh: false, startedAt: expect.any(Number) });
    await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { done: "profile", current: "model" });
    view = await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { skipped: "model", current: "style" });
    expect(view).toMatchObject({ current: "style", done: ["profile"], skipped: ["model"] });
    // Someone else's state is their own; the organization isn't fresh any more.
    expect(await onboarding.view(viewer)).toMatchObject({ current: "profile", pending: false, fresh: false });
    // A step outside your steps is refused.
    await expect(onboarding.update(viewer, DEFAULT_WORKSPACE_ID, { current: "team" })).rejects.toMatchObject({ code: "invalid_step" });
    view = await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { presetId: "balanced", done: "style", complete: true });
    expect(view).toMatchObject({ pending: false, completedAt: expect.any(Number), presetId: "balanced" });
    // The organization's chosen style is everyone's default until they choose.
    expect((await onboarding.view(viewer)).presetId).toBe("balanced");
  });

  test("the checklist ticks itself from real state, and can be dismissed", async () => {
    const { store, onboarding, owner, identity } = await setup({ serverKey: true, connections: 1 });
    await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { start: true });
    let checklist = (await onboarding.view(owner)).checklist;
    const done = (id: string) => checklist.items.find((item) => item.id === id)?.done;
    // Server key, a connection, and a second person (the invited viewer).
    expect(done("model")).toBe(true);
    expect(done("tool")).toBe(true);
    expect(done("team")).toBe(true);
    expect(done("agent")).toBe(false);
    expect(done("knowledge")).toBe(false);
    expect(done("voice")).toBe(false);
    expect(checklist).toMatchObject({ visible: true, complete: false, total: 7 });
    expect(checklist.items.every((item) => item.href.startsWith("/"))).toBe(true);

    await store.agents.upsert({
      id: "ag1",
      ownerId: "owner",
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: "Research",
      avatar: randomAvatar("r"),
      instructions: "",
      createdBy: owner.userId!,
      visibility: "workspace",
      createdAt: 1,
      updatedAt: 1
    } as never);
    await store.knowledge.upsertBase({ id: "kb1", ownerId: "owner", workspaceId: DEFAULT_WORKSPACE_ID, name: "Team", createdAt: 1, updatedAt: 1 });
    await store.knowledge.upsertDoc({ id: "d1", ownerId: "owner", knowledgeBaseId: "kb1", title: "Handbook", source: { kind: "text" }, status: "ready", createdAt: 1, updatedAt: 1 } as never);
    await store.usage.insert({ id: "u1", at: 999_000, ownerId: "owner", feature: "voice", model: "m", costUsd: 0.01, estimated: false, userId: owner.userId! });
    checklist = (await onboarding.update(owner, DEFAULT_WORKSPACE_ID, { presetId: "fastest" })).checklist;
    expect(checklist).toMatchObject({ complete: true, visible: false, doneCount: 7 });

    // Dismissed: hidden even when not complete.
    const viewer = (await identity.resolveSession((await identity.login({ email: "vic@example.com", password: PASSWORD }, "ip") as { token: string }).token))!.principal as Principal;
    await onboarding.update(viewer, DEFAULT_WORKSPACE_ID, { start: true, checklistDismissed: true });
    expect((await onboarding.view(viewer)).checklist).toMatchObject({ dismissed: true, visible: false });
  });

  test("the profile sets the person's name and face", async () => {
    const { onboarding, owner, identity, store } = await setup();
    const avatar = randomAvatar("olive-2");
    const view = await onboarding.setProfile(owner, DEFAULT_WORKSPACE_ID, { name: "  Olive   Oak ", avatar });
    expect(view.profile).toEqual({ name: "Olive Oak", avatar });
    const user = await store.identity.users.get("owner", owner.userId!);
    expect(user).toMatchObject({ name: "Olive Oak", avatar });
    expect((await identity.me(await identity.refresh({ principal: owner, user }))).user).toMatchObject({ name: "Olive Oak", avatar });
    await expect(onboarding.setProfile(owner, DEFAULT_WORKSPACE_ID, { name: " " })).rejects.toMatchObject({ code: "invalid_name" });
    await expect(onboarding.setProfile(ownerPrincipal("owner", "local"), DEFAULT_WORKSPACE_ID, { name: "X" })).rejects.toMatchObject({ code: "not_a_user" });
  });
});
