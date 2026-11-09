"use client";

/**
 * The onboarding screens (/welcome/<step>): one decision per screen, a
 * progress bar, Back, Skip on optional steps and Continue. Every step is its
 * own address, so the browser's Back and Forward work, and the person's
 * place is saved on the gateway (it resumes on any device).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { OnboardingStepId, OnboardingView } from "@open-gpt-live/protocol";
import { Mark } from "../../components/Brand";
import { SibylLoader } from "../../components/SibylLoader";
import { Button, Notice } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { STEP_LABELS, isOptional, nextStep, previousStep, resumeStep, stepPosition, welcomePath } from "./flow";
import { updateOnboarding, useOnboarding } from "./useOnboarding";
import { markOnboardingVisited } from "./useOnboardingGate";
import { StepAgent } from "./steps/StepAgent";
import { StepKnowledge } from "./steps/StepKnowledge";
import { StepModel } from "./steps/StepModel";
import { StepProfile } from "./steps/StepProfile";
import { StepStart } from "./steps/StepStart";
import { StepStyle } from "./steps/StepStyle";
import { StepTeam } from "./steps/StepTeam";
import { StepTools } from "./steps/StepTools";
import styles from "./onboarding.module.css";

interface FlowApi {
  step: OnboardingStepId;
  view: OnboardingView;
  /** Mark this step done (or skipped) and go to the next one. */
  advance(kind?: "done" | "skipped"): Promise<void>;
  /** Finish onboarding and open `path` in the app. */
  finish(path: string): Promise<void>;
}

const FlowContext = createContext<FlowApi | null>(null);

export function useFlow(): FlowApi {
  const flow = useContext(FlowContext);
  if (!flow) throw new Error("useFlow() needs <OnboardingFlow>.");
  return flow;
}

const STEPS: Record<OnboardingStepId, () => ReactNode> = {
  profile: () => <StepProfile />,
  model: () => <StepModel />,
  style: () => <StepStyle />,
  tools: () => <StepTools />,
  agent: () => <StepAgent />,
  knowledge: () => <StepKnowledge />,
  team: () => <StepTeam />,
  start: () => <StepStart />
};

/** /welcome: send the person to where they left off. */
export function WelcomeRedirect() {
  const router = useRouter();
  const { status, view } = useOnboarding();
  useEffect(() => {
    if (view) router.replace(welcomePath(resumeStep(view.steps, view.current, view.done)));
  }, [view, router]);
  if (status === "error") return <SignedOut />;
  return <Loading />;
}

export function OnboardingFlow({ step }: { step: OnboardingStepId }) {
  const router = useRouter();
  const { status, view } = useOnboarding();
  const entered = useRef<string | null>(null);

  useEffect(() => {
    markOnboardingVisited();
  }, []);

  // A step that isn't theirs (no permission, old link): go to where they are.
  const allowed = view ? view.steps.includes(step) : true;
  useEffect(() => {
    if (view && !allowed) router.replace(welcomePath(resumeStep(view.steps, view.current, view.done)));
  }, [view, allowed, router]);

  // Entering a step: remember it (and when onboarding started).
  useEffect(() => {
    if (!view || !allowed || entered.current === step) return;
    entered.current = step;
    if (view.current !== step || !view.startedAt) void updateOnboarding({ ...(view.startedAt ? {} : { start: true }), current: step }).catch(() => undefined);
  }, [view, step, allowed]);

  const advance = useCallback(
    async (kind: "done" | "skipped" = "done") => {
      if (!view) return;
      const next = nextStep(view.steps, step);
      await updateOnboarding({ [kind]: step, ...(next ? { current: next } : {}) });
      if (next) router.push(welcomePath(next));
    },
    [view, step, router]
  );

  const finish = useCallback(
    async (path: string) => {
      await updateOnboarding({ done: step, complete: true });
      router.push(path);
    },
    [step, router]
  );

  if (status === "error" && !view) return <SignedOut />;
  if (!view || !allowed) return <Loading />;

  const { index, total } = stepPosition(view.steps, step);
  return (
    <FlowContext.Provider value={{ step, view, advance, finish }}>
      <div className={styles.page}>
        <header className={styles.top}>
          <span className={styles.brand}>
            <Mark size={20} />
            <span>Sibyl</span>
          </span>
          <div className={styles.progress}>
            <span className={styles.progressText}>
              Step {index} of {total}
              <span className={styles.progressLabel}> · {STEP_LABELS[step]}</span>
            </span>
            <span
              className={styles.progressTrack}
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={1}
              aria-valuemax={total}
              aria-valuenow={index}
              aria-valuetext={`Step ${index} of ${total}: ${STEP_LABELS[step]}`}
            >
              {view.steps.map((item, position) => (
                <span key={item} className={styles.progressSegment} data-state={position + 1 < index ? "done" : position + 1 === index ? "current" : "todo"} />
              ))}
            </span>
          </div>
          <Link href="/" className={styles.later}>
            Finish later
          </Link>
        </header>
        <main className={styles.main} id="main">
          {STEPS[step]()}
        </main>
      </div>
    </FlowContext.Provider>
  );
}

/**
 * One onboarding screen: the title (focused when the step opens), a short
 * lead, the step's one decision, and the footer (Back, Skip, Continue).
 * Enter submits the form.
 */
export function StepLayout(props: {
  title: ReactNode;
  lead?: ReactNode;
  hero?: ReactNode;
  children?: ReactNode;
  /** Primary action label (default "Continue"). */
  primary?: string;
  primaryDisabled?: boolean;
  /**
   * Runs on Continue / Enter, then the step is marked done and the next one
   * opens. Return false to stay on the step, "handled" when it navigated itself.
   */
  onPrimary?: () => Promise<false | "handled" | void> | false | "handled" | void;
  /** A note next to Skip (e.g. "You can add it later in Settings"). */
  skipNote?: string;
  /** Hide the Skip button on an optional step (e.g. once something was done). */
  hideSkip?: boolean;
}) {
  const flow = useFlow();
  const router = useRouter();
  const [busy, setBusy] = useState<"primary" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previous = previousStep(flow.view.steps, flow.step);
  const optional = isOptional(flow.step) && !props.hideSkip;

  useEffect(() => {
    titleRef.current?.focus();
  }, [flow.step]);

  async function run(kind: "primary" | "skip"): Promise<void> {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "skip") {
        await flow.advance("skipped");
      } else {
        const result = props.onPrimary ? await props.onPrimary() : undefined;
        if (result !== false && result !== "handled") await flow.advance("done");
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (props.primaryDisabled) return;
    void run("primary");
  }

  return (
    <form className={styles.step} onSubmit={submit} noValidate>
      {props.hero ? <div className={styles.hero}>{props.hero}</div> : null}
      <h1 ref={titleRef} tabIndex={-1} className={styles.title}>
        {props.title}
      </h1>
      {props.lead ? <p className={styles.lead}>{props.lead}</p> : null}
      {props.children ? <div className={styles.body}>{props.children}</div> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <footer className={styles.footer}>
        {previous ? (
          <Button variant="ghost" onClick={() => router.push(welcomePath(previous))} disabled={busy !== null}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <span className={styles.footerEnd}>
          {optional ? (
            <span className={styles.skip}>
              {props.skipNote ? <span className={styles.skipNote}>{props.skipNote}</span> : null}
              <Button variant="ghost" onClick={() => void run("skip")} disabled={busy !== null}>
                {busy === "skip" ? "Skipping…" : "Skip"}
              </Button>
            </span>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy !== null || props.primaryDisabled}>
            {busy === "primary" ? "One moment…" : props.primary ?? "Continue"}
          </Button>
        </span>
      </footer>
    </form>
  );
}

function Loading() {
  return (
    <div className={styles.loading}>
      <SibylLoader state="thinking" size={40} label="Loading" />
    </div>
  );
}

function SignedOut() {
  return (
    <div className={styles.loading}>
      <p className={styles.lead}>Sign in to continue setting up Sibyl.</p>
      <Link href="/login?next=%2Fwelcome" className={styles.later}>
        Sign in
      </Link>
    </div>
  );
}
