/**
 * Every email Sibyl sends, as content for the one layout (layout.ts). Each
 * function takes structured data and returns an `EmailContent`; the mailer
 * renders it. Plain text in, never HTML: the layout escapes everything.
 *
 * Voice: short, plain, no jargon. Say what happened, what to do, and why the
 * reader got it.
 */
import type { EmailBlock, EmailContent, NotificationKind } from "@open-gpt-live/core";

/* ───────────── sign-in and sign-up ───────────── */

export interface SignInLinkEmail {
  url: string;
  /** Minutes the link works for. */
  minutes: number;
}

/** A magic link to an existing account. */
export function signInLinkEmail(input: SignInLinkEmail): EmailContent {
  return {
    subject: "Your Sibyl sign-in link",
    preheader: `Sign in with one click. The link works once, for ${minutes(input.minutes)}.`,
    heading: "Sign in to Sibyl",
    blocks: [
      { kind: "text", text: "Use the button below to sign in. No password needed." },
      { kind: "button", label: "Sign in", url: input.url, fallback: true },
      { kind: "note", text: `The link works once and expires in ${minutes(input.minutes)}. If you didn't ask for it, ignore this email. Nobody can sign in without it.` }
    ],
    reason: "You're getting this because someone asked to sign in to Sibyl with this address."
  };
}

/** A magic link that finishes a new sign-up (hosted Sibyl). */
export function signUpLinkEmail(input: SignInLinkEmail): EmailContent {
  return {
    subject: "Finish signing up for Sibyl",
    preheader: `Confirm your email to create your account. The link works for ${minutes(input.minutes)}.`,
    heading: "Finish signing up",
    blocks: [
      { kind: "text", text: "Confirm this is your email address and we'll set up your account." },
      { kind: "button", label: "Confirm and continue", url: input.url, fallback: true },
      { kind: "note", text: `The link works once and expires in ${minutes(input.minutes)}. If you didn't sign up for Sibyl, ignore this email and no account will be made.` }
    ],
    reason: "You're getting this because someone signed up for Sibyl with this address."
  };
}

export interface SignUpCodeEmail {
  /** The 6-digit code. */
  code: string;
  minutes: number;
}

/** The 6-digit code that confirms the address on a password sign-up. */
export function signUpCodeEmail(input: SignUpCodeEmail): EmailContent {
  return {
    subject: `${input.code} is your Sibyl code`,
    preheader: `Enter it on the sign-up page. It expires in ${minutes(input.minutes)}.`,
    heading: "Your Sibyl code",
    blocks: [
      { kind: "text", text: "Enter this code on the sign-up page to confirm your email address." },
      { kind: "code", code: input.code },
      { kind: "note", text: `It expires in ${minutes(input.minutes)}. If you didn't ask for it, ignore this email. Never share the code with anyone.` }
    ],
    reason: "You're getting this because someone signed up for Sibyl with this address."
  };
}

/* ───────────── invitations ───────────── */

export interface InvitationEmail {
  inviterName: string;
  workspaceName: string;
  /** The organization's name, when set. */
  orgName?: string;
  role: string;
  url: string;
  /** Days until the link expires. */
  days: number;
}

export function invitationEmail(input: InvitationEmail): EmailContent {
  const where = input.orgName ? `${input.workspaceName} (${input.orgName})` : input.workspaceName;
  const days = `${input.days} day${input.days === 1 ? "" : "s"}`;
  return {
    subject: `${input.inviterName} invited you to ${where} on Sibyl`,
    preheader: `Join the ${input.workspaceName} workspace as ${article(input.role)} ${input.role}. The invitation expires in ${days}.`,
    heading: `Join ${input.workspaceName} on Sibyl`,
    blocks: [
      {
        kind: "text",
        text: [
          { strong: input.inviterName },
          " invited you to the ",
          { strong: input.workspaceName },
          " workspace",
          ...(input.orgName ? [" of ", { strong: input.orgName }] : []),
          ` as ${article(input.role)} ${input.role}.`
        ]
      },
      { kind: "text", text: "Sibyl is where your team talks to AI, runs agents and meetings, and keeps the work in one place." },
      { kind: "button", label: "Accept invitation", url: input.url, fallback: true },
      { kind: "note", text: `The link works once and expires in ${days}. If you weren't expecting this, you can ignore this email.` }
    ],
    reason: `You're getting this because ${input.inviterName} invited this address to Sibyl.`
  };
}

/* ───────────── notifications ───────────── */

export interface NotificationEmail {
  kind: NotificationKind;
  /** The notice's short line. */
  title: string;
  /** Plain-text details (may be several lines). */
  body: string;
  /** Where it leads in the web app (absent when SIBYL_APP_URL isn't set). */
  url?: string;
}

interface NoticeCopy {
  subject(title: string, body: string): string;
  heading(title: string, body: string): string;
  /** A sentence before the details. */
  lead?: string;
  /** How the details are shown: a panel (someone's words, results, lists) or a plain paragraph. */
  details: "panel" | "text" | "none";
  detailsLabel?: string;
  button: string;
  reason: string;
}

const NOTICE_COPY: Record<NotificationKind, NoticeCopy> = {
  approval_needed: {
    subject: (title) => title,
    heading: () => "Waiting for your approval",
    lead: "Sibyl stopped before doing something and needs a yes or no from you.",
    details: "panel",
    button: "Review it",
    reason: "You're getting this because you can approve actions in this workspace."
  },
  routine_finished: {
    subject: (title) => `Routine finished: ${title}`,
    heading: (title) => `${title} finished`,
    details: "panel",
    detailsLabel: "Result",
    button: "See the result",
    reason: "You're getting this because you created this routine."
  },
  routine_failed: {
    subject: (title) => `Routine didn't finish: ${title}`,
    heading: (title) => `${title} didn't finish`,
    details: "panel",
    detailsLabel: "What happened",
    button: "See what happened",
    reason: "You're getting this because you created this routine."
  },
  budget_blocked: {
    subject: (title) => title,
    heading: (title) => title,
    lead: "A budget stopped this so it wouldn't spend more. Nothing else was changed.",
    details: "panel",
    button: "Open Sibyl",
    reason: "You're getting this because you started this work in Sibyl."
  },
  monitor_fired: {
    subject: (title) => title,
    heading: () => "Your monitor found something",
    details: "panel",
    button: "Open Monitors",
    reason: "You're getting this because one of your monitors is set to email you. You can change that in Monitors."
  },
  monitor_paused: {
    subject: (title) => title,
    heading: () => "A monitor was paused",
    lead: "It won't check again until you turn it back on.",
    details: "panel",
    button: "Open Monitors",
    reason: "You're getting this because one of your monitors is set to email you. You can change that in Monitors."
  },
  agent_action: {
    subject: (title) => title,
    heading: (title) => title,
    details: "text",
    button: "See what it did",
    reason: "You're getting this because this agent is set to tell you by email when it acts on its own. You can change that in the agent's settings."
  },
  deck_ready: {
    subject: (_title, body) => (body ? `Your deck is ready: ${body}` : "Your deck is ready"),
    heading: () => "Your deck is ready",
    details: "none",
    button: "Open the deck",
    reason: "You're getting this because you asked Sibyl to make this deck."
  },
  invite_accepted: {
    subject: (title) => title,
    heading: (title) => title,
    details: "text",
    button: "Open Sibyl",
    reason: "You're getting this because you sent the invitation."
  },
  meeting_notes: {
    subject: (title) => title,
    heading: (title) => title,
    details: "panel",
    detailsLabel: "Overview",
    button: "Read the notes",
    reason: "You're getting this because you were in this meeting."
  },
  voicemail: {
    subject: (title) => title,
    heading: (title) => title,
    details: "panel",
    detailsLabel: "What they said",
    button: "Open the call",
    reason: "You're getting this because your workspace has a Sibyl phone line."
  }
};

/** A notification (routine, monitor, agent, approval, meeting, …) as an email. */
export function notificationEmail(input: NotificationEmail): EmailContent {
  const copy = NOTICE_COPY[input.kind];
  const title = input.title.trim();
  const body = input.body.trim();
  const blocks: EmailBlock[] = [];
  if (copy.lead) blocks.push({ kind: "text", text: copy.lead });
  if (input.kind === "deck_ready" && body) blocks.push({ kind: "text", text: [{ strong: body }, " is built and ready to look at and edit."] });
  else if (body && body !== title && copy.details === "panel") blocks.push({ kind: "panel", text: body, ...(copy.detailsLabel ? { label: copy.detailsLabel } : {}) });
  else if (body && body !== title && copy.details === "text") blocks.push({ kind: "text", text: body });
  if (input.url) blocks.push({ kind: "button", label: copy.button, url: input.url });
  else blocks.push({ kind: "note", text: "Open Sibyl to see it." });
  const subject = copy.subject(title, body) || "Sibyl";
  return {
    subject,
    preheader: preheaderFrom(body && body !== title ? body : subject),
    heading: copy.heading(title, body),
    blocks,
    reason: copy.reason
  };
}

/* ───────────── usage alerts (Agent Serve: advanced usage controls) ───────────── */

export interface UsageAlertEmail {
  /** Who spent it (name or email). */
  name: string;
  period: "daily" | "monthly";
  thresholdPercent: number;
  /** The person was stopped by the budget. */
  blocked: boolean;
  /** Formatted amounts, e.g. "$4.20". */
  spent: string;
  cap: string;
  workspace?: string;
  /** Admin → Usage controls, when SIBYL_APP_URL is known. */
  settingsUrl?: string;
}

export function usageAlertEmail(input: UsageAlertEmail): EmailContent {
  const { period } = input;
  const subject = input.blocked
    ? `Sibyl usage: ${input.name} reached their ${period} budget`
    : `Sibyl usage: ${input.name} used ${input.thresholdPercent}% of their ${period} budget`;
  const summary = input.blocked
    ? `${input.name} was stopped by their ${period} budget: ${input.spent} of ${input.cap} used.`
    : `${input.name} has used ${input.spent} of their ${input.cap} ${period} budget (${input.thresholdPercent}%).`;
  return {
    subject,
    preheader: summary,
    heading: input.blocked ? `${input.name} reached their ${period} budget` : `${input.name} used ${input.thresholdPercent}% of their ${period} budget`,
    blocks: [
      { kind: "text", text: summary },
      {
        kind: "facts",
        rows: [
          { label: "Spent", value: input.spent },
          { label: `${period === "daily" ? "Daily" : "Monthly"} budget`, value: input.cap },
          ...(input.workspace ? [{ label: "Workspace", value: input.workspace }] : []),
          { label: "Resets", value: period === "daily" ? "At midnight (server time)" : "On the 1st of the month" }
        ]
      },
      ...(input.blocked ? [{ kind: "text" as const, text: "Until it resets, Sibyl won't make model calls for them. Raise the budget to let them carry on." }] : []),
      input.settingsUrl ? { kind: "button" as const, label: "Open usage controls", url: input.settingsUrl } : { kind: "note" as const, text: "Change budgets in Admin, then Usage controls." }
    ],
    reason: "You're getting this because your organization's usage controls send budget alerts to this address."
  };
}

/* ───────────── helpers ───────────── */

function minutes(value: number): string {
  return `${value} minute${value === 1 ? "" : "s"}`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** The first words of the details, without URLs or list dashes. */
function preheaderFrom(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.replace(/https?:\/\/\S+/g, "").replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}
