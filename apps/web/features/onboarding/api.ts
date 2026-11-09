"use client";

/**
 * Browser side of onboarding: /api/onboarding (steps, profile, checklist),
 * /api/model-access (the organization's model key or credits) and
 * /api/signup/options (hosted or self-hosted). See the "Sign-up and
 * onboarding" block in @open-gpt-live/protocol.
 */
import type { AgentAvatarView, ModelAccessView, OnboardingPatch, OnboardingView, SignupOptionsView } from "@open-gpt-live/protocol";
import { GatewayError, gatewayRequest } from "../../lib/gateway-http";

export function fetchOnboarding(): Promise<OnboardingView> {
  return gatewayRequest<OnboardingView>("/api/onboarding");
}

export function patchOnboarding(patch: OnboardingPatch): Promise<OnboardingView> {
  return gatewayRequest<OnboardingView>("/api/onboarding", { method: "PATCH", body: patch });
}

export function saveProfile(profile: { name?: string; avatar?: AgentAvatarView }): Promise<OnboardingView> {
  return gatewayRequest<OnboardingView>("/api/onboarding/profile", { method: "PUT", body: profile });
}

/** The organization's model access; null when this server can't tell (no /api/model-access). */
export async function fetchModelAccess(): Promise<ModelAccessView | null> {
  try {
    return await gatewayRequest<ModelAccessView>("/api/model-access");
  } catch (error) {
    if (error instanceof GatewayError && (error.status === 404 || error.status === 405)) return null;
    throw error;
  }
}

/** Save and check an OpenRouter key (throws GatewayError "invalid_key" with a message). */
export function saveModelKey(key: string): Promise<ModelAccessView> {
  return gatewayRequest<ModelAccessView>("/api/model-access/key", { method: "PUT", body: { key } });
}

export function removeModelKey(): Promise<ModelAccessView> {
  return gatewayRequest<ModelAccessView>("/api/model-access/key", { method: "DELETE" });
}

let signupOptions: Promise<SignupOptionsView | null> | null = null;

/** Hosted or self-hosted, and which sign-in methods exist (null: the gateway predates sign-up). Cached per page. */
export function fetchSignupOptions(): Promise<SignupOptionsView | null> {
  signupOptions ??= gatewayRequest<SignupOptionsView>("/api/signup/options", { workspaceId: null, ownerToken: null }).catch(() => {
    signupOptions = null;
    return null;
  });
  return signupOptions;
}
