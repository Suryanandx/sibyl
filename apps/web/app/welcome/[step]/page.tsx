import { notFound } from "next/navigation";
import { ONBOARDING_STEPS } from "@open-gpt-live/protocol";
import { OnboardingFlow, STEP_LABELS, isStep } from "../../../features/onboarding";

export function generateStaticParams() {
  return ONBOARDING_STEPS.map((step) => ({ step }));
}

export function generateMetadata({ params }: { params: { step: string } }) {
  return { title: isStep(params.step) ? `${STEP_LABELS[params.step]} · Sibyl` : "Welcome · Sibyl" };
}

/** /welcome/<step>: one onboarding screen. */
export default function WelcomeStepPage({ params }: { params: { step: string } }) {
  if (!isStep(params.step)) notFound();
  return <OnboardingFlow step={params.step} />;
}
