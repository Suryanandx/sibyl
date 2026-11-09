import { WelcomeRedirect } from "../../features/onboarding";

export const metadata = { title: "Welcome · Sibyl" };

/** /welcome: continue onboarding where the person left off. */
export default function WelcomePage() {
  return <WelcomeRedirect />;
}
