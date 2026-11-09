/**
 * Onboarding: the first-run flow's state and the Getting started checklist
 * (docs/getting-started.md, docs/plans/hosted.md §5).
 */
export { OnboardingService, type OnboardingServiceOptions } from "./service.js";
export { handleOnboardingHttp, isOnboardingPath, type OnboardingHttpOptions } from "./http.js";
