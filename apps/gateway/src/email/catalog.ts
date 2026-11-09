/**
 * Every email Sibyl sends, with sample data: the preview script renders these
 * and the tests check each one. Add a template → add it here.
 */
import { NOTIFICATION_KINDS, type EmailContent, type NotificationKind } from "@open-gpt-live/core";
import { invitationEmail, notificationEmail, signInLinkEmail, signUpCodeEmail, signUpLinkEmail, usageAlertEmail } from "./templates.js";

export interface EmailSample {
  /** File name in the preview folder. */
  id: string;
  /** When Sibyl sends it (docs, preview index). */
  when: string;
  to: string;
  content: EmailContent;
  /** URLs the email must carry (the tests check the text version has them). */
  links: string[];
}

const APP = "https://app.opensibyl.world";

const NOTICE_SAMPLES: Record<NotificationKind, { title: string; body: string; path: string; when: string }> = {
  approval_needed: {
    title: "Second approval needed: Send the Q3 pricing email to 214 customers",
    body: "Ana Lopes approved this action: Send “Q3 pricing update” to 214 contacts in HubSpot. Your organization's policy needs an admin to approve it too. Open Admin, then Policies.",
    path: "/inbox",
    when: "An action needs an approval (a routine waiting for a yes, or a second approval that policy requires), when email is asked for."
  },
  routine_finished: {
    title: "Monday pipeline summary",
    body: "12 deals moved this week. Acme Corp went to Negotiation ($48,000). Two deals have had no activity for 14 days: Globex and Initech.",
    path: "/routines",
    when: "A routine run finishes, when email is asked for."
  },
  routine_failed: {
    title: "Monday pipeline summary",
    body: "HubSpot stopped answering after 3 tries (503). The next run is on Monday at 9:00.",
    path: "/routines",
    when: "A routine run fails or is interrupted, when email is asked for."
  },
  budget_blocked: {
    title: "Research Assistant's computer paused",
    body: "The agent's computer reached its daily budget of $2.00.",
    path: "/agents",
    when: "A budget stops an agent's computer or a routine, when email is asked for."
  },
  monitor_fired: {
    title: "2 new matches for “Deals in negotiation”: Acme Corp, Globex.",
    body: "- Acme Corp moved to Negotiation\n  https://app.hubspot.com/contacts/1/deal/101\n  Why: the stage changed from Proposal to Negotiation\n- Globex moved to Negotiation\n  https://app.hubspot.com/contacts/1/deal/102\n\nMonitor: Deals in negotiation",
    path: "/monitors",
    when: "A monitor finds new matches and its notify action includes email."
  },
  monitor_paused: {
    title: "“Deals in negotiation” was paused: HubSpot needs to be reconnected.",
    body: "Monitor: Deals in negotiation",
    path: "/monitors",
    when: "A monitor pauses itself (a lost connection, its budget) and its notify action includes email."
  },
  agent_action: {
    title: "Dot acted on its own",
    body: "Dot sent an email to finance@acme.com: “Invoice 2041 is attached”.",
    path: "/agents",
    when: "An agent acts on its own and its settings say to tell you by email."
  },
  deck_ready: {
    title: "Deck ready",
    body: "Q3 board update",
    path: "/library/slides",
    when: "A deck you asked for is built, when email is asked for."
  },
  invite_accepted: {
    title: "Max Weber joined Sales",
    body: "Max Weber (max@acme.com) accepted your invitation and joined Sales as a member.",
    path: "/inbox",
    when: "Someone accepts your invitation, when email is asked for."
  },
  meeting_notes: {
    title: "Notes ready: Weekly product sync",
    body: "We agreed to ship the new onboarding on 18 November. Ana owns the release notes; Max follows up with design on the empty states.",
    path: "/meetings/m1",
    when: "A meeting ends and its notes are written, when email is asked for."
  },
  voicemail: {
    title: "Voicemail from +49 30 1234 5678",
    body: "Hi, this is Jonas from Globex. Could someone call me back about the renewal? I'm free after 3 pm.",
    path: "/c/c1",
    when: "Someone leaves a voicemail on a Sibyl phone line, when email is asked for."
  }
};

export function emailSamples(): EmailSample[] {
  const signIn = `${APP}/signup/link?token=Zx81_qPr4kT0aLm2`;
  const invite = `${APP}/invite/inv_7Hk2pQ9xWm`;
  const usage = `${APP}/admin/usage`;
  return [
    {
      id: "sign-in-link",
      when: "Someone asks for a sign-in link on /login or /signup and already has an account.",
      to: "ana@acme.com",
      content: signInLinkEmail({ url: signIn, minutes: 15 }),
      links: [signIn]
    },
    {
      id: "sign-up-link",
      when: "Hosted Sibyl: someone without an account asks for a link on /signup.",
      to: "ana@acme.com",
      content: signUpLinkEmail({ url: signIn, minutes: 15 }),
      links: [signIn]
    },
    {
      id: "sign-up-code",
      when: "Hosted Sibyl: someone signs up with a password; the code confirms the address.",
      to: "ana@acme.com",
      content: signUpCodeEmail({ code: "482913", minutes: 15 }),
      links: []
    },
    {
      id: "invitation",
      when: "An admin invites someone by email, or sends an invitation again.",
      to: "max@acme.com",
      content: invitationEmail({ inviterName: "Ana Lopes", workspaceName: "Sales", orgName: "Acme", role: "member", url: invite, days: 7 }),
      links: [invite]
    },
    ...NOTIFICATION_KINDS.map((kind): EmailSample => {
      const sample = NOTICE_SAMPLES[kind];
      const url = `${APP}${sample.path}`;
      return {
        id: `notification-${kind.replace(/_/g, "-")}`,
        when: sample.when,
        to: "ana@acme.com",
        content: notificationEmail({ kind, title: sample.title, body: sample.body, url }),
        links: [url]
      };
    }),
    {
      id: "usage-alert",
      when: "Agent Serve, advanced usage controls: someone crosses an alert threshold of their budget (also “Send a test alert”).",
      to: "ops@acme.com",
      content: usageAlertEmail({ name: "Ana Lopes", period: "monthly", thresholdPercent: 80, blocked: false, spent: "$40.12", cap: "$50.00", workspace: "Sales", settingsUrl: usage }),
      links: [usage]
    },
    {
      id: "usage-alert-blocked",
      when: "Agent Serve, advanced usage controls: someone reaches their budget and is stopped.",
      to: "ops@acme.com",
      content: usageAlertEmail({ name: "Ana Lopes", period: "daily", thresholdPercent: 100, blocked: true, spent: "$5.00", cap: "$5.00", settingsUrl: usage }),
      links: [usage]
    }
  ];
}
