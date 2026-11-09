/**
 * Built-in skills seeded for every organization (available in every
 * workspace). Users can switch them off but not delete them; a newer
 * built-in version replaces the text and keeps the on/off switch.
 */
export interface BuiltinSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  tools?: string[];
  instructions: string;
  files?: Array<{ name: string; content: string }>;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: "builtin-status-update",
    name: "status-update",
    title: "Write a clear status update",
    description:
      "Use when the user asks for a status update, progress report, weekly update or stakeholder summary of a project or piece of work.",
    version: "1.0.0",
    instructions: `# Write a clear status update

Goal: a reader who has 30 seconds knows where things stand, what changed and what you need from them.

## Steps
1. Find the facts. Use what the user gave you; if key facts are missing (period covered, audience, overall state), ask one short question or state your assumption.
2. Decide the overall state honestly: **On track**, **At risk** or **Off track**. Never round "at risk" up to "on track".
3. Write it in this order, using the template in \`template.md\`:
   - One-line headline with the state.
   - What changed since last time (3–5 bullets, outcomes not activity: "Checkout shipped to 10% of users", not "worked on checkout").
   - Next (what happens before the next update, with owners and dates when known).
   - Risks and blockers, each with its impact and what would unblock it.
   - Asks: decisions or help needed, addressed to a person, with a date.
4. Keep it under 200 words unless asked otherwise. Plain words, no jargon, numbers over adjectives.
5. Match the audience: executives get the headline, risks and asks first; the team gets more detail on next steps.

## Avoid
- Burying bad news below the fold.
- Listing tasks without saying why they matter.
- Vague dates ("soon", "next sprint") when a date is known.`,
    files: [
      {
        name: "template.md",
        content: `**[Project] — [On track | At risk | Off track]** · [period]

**Headline:** one sentence on where things stand.

**Since last update**
- …

**Next**
- … (owner, date)

**Risks & blockers**
- Risk — impact — what unblocks it

**Asks**
- @person: decision/help needed by [date]
`
      }
    ]
  },
  {
    id: "builtin-summarise-with-citations",
    name: "summarise-with-citations",
    title: "Summarise a long document with citations",
    description:
      "Use when the user asks to summarise, digest or extract key points from a long document, report, PDF, web page or knowledge base, and the summary must be checkable against the source.",
    version: "1.0.0",
    tools: ["read_file", "search_knowledge", "read_webpage"],
    instructions: `# Summarise a long document with citations

Goal: a faithful, skimmable summary where every important claim points to where it came from.

## Steps
1. Get the whole source. For an attached file use \`read_file\` and page through it until the end; for a web page use \`read_webpage\`; for the user's knowledge bases use \`search_knowledge\` with several focused queries. Don't summarise from the first page alone.
2. Note the structure (sections, pages) as you read, so you can cite precisely.
3. Write:
   - **TL;DR** — 2–3 sentences: what the document is and its main conclusion.
   - **Key points** — 5–8 bullets, most important first. End each with a citation like [p. 4] or [Section 2.1] or [Doc title › Section].
   - **Numbers that matter** — figures, dates and amounts quoted exactly, each cited.
   - **Open questions / caveats** — what the document doesn't settle, assumptions it makes.
4. Quote sparingly and exactly; paraphrase everything else.
5. If the user has a purpose ("for a board meeting", "what affects my team"), filter and order the points for it, and say what you left out.

## Rules
- Never cite a page or section you didn't read.
- If something is unclear or contradictory in the source, say so instead of smoothing it over.
- Keep the summary under a quarter of the source's length, and under 400 words unless asked.`
  },
  {
    id: "builtin-project-plan",
    name: "project-plan",
    title: "Plan a project with milestones",
    description:
      "Use when the user wants to plan a project, launch, migration or event: break it into milestones, tasks, owners, dates, dependencies and risks.",
    version: "1.0.0",
    instructions: `# Plan a project with milestones

Goal: a plan someone can start on tomorrow, with checkpoints that show early whether it is on track.

## Steps
1. Clarify, briefly: the outcome (what "done" looks like, measurably), the deadline or fixed date, the team and any hard constraints (budget, approvals, dependencies). Ask at most two questions; otherwise state assumptions.
2. Work backwards from the outcome into 3–6 **milestones**. Each milestone is a verifiable result ("Beta in the hands of 20 customers"), not an activity.
3. For each milestone list the key **tasks** (verbs, 1–2 days to 2 weeks each), an **owner** (role if no name), and an **estimate**.
4. Mark **dependencies** and the **critical path**; schedule milestones with dates, adding ~20% buffer before fixed dates.
5. List the top 3–5 **risks** with likelihood, impact and a mitigation or early warning sign.
6. End with **the first three actions** for this week.

## Format
- A short summary (goal, deadline, critical path in one line).
- A milestone table: Milestone | Done when | Date | Owner.
- Tasks under each milestone as bullets.
- Risks as a table: Risk | Likelihood | Impact | Mitigation.

If the user wants it scheduled, offer to create reminders or a routine for milestone check-ins.`
  }
];
