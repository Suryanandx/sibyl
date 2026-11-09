/**
 * Onboarding (hosted sign-up and self-hosted first run): the /welcome/<step>
 * screens, the Getting started checklist in the rail, and the app shell's
 * redirect into them. State lives on the gateway (/api/onboarding), per
 * person and per organization, so it resumes on any device.
 *
 *   app/welcome/page.tsx         → <WelcomeRedirect />
 *   app/welcome/[step]/page.tsx  → <OnboardingFlow step=… />
 *   components/AppRail.tsx       → <GettingStarted />
 *   components/AppFrame.tsx      → useOnboardingGate(…)
 */
export { OnboardingFlow, WelcomeRedirect } from "./OnboardingFlow";
export { GettingStarted } from "./GettingStarted";
export { useOnboardingGate } from "./useOnboardingGate";
export { refreshOnboarding, useOnboarding } from "./useOnboarding";
export { fetchSignupOptions } from "./api";
export { isStep, STEP_LABELS } from "./flow";
