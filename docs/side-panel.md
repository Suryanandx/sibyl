# The side panel

The chat has a panel on the right that shows what the AI is doing or made, without leaving the conversation: an agent's computer working live, a deck being built, a visual at full size, a file you sent, or a web page it read.

## What it shows

| Item | What you see |
|---|---|
| **Agent computer** | The live screen with its address, **Stop**, and **What it did** (each step with a picture). A finished run shows its timeline. Same view as `/agents/<id>/computer`. |
| **Deck** | The deck card (thumbnail, PPTX, PDF) and the editor itself. While the deck is being built, the panel says so and switches to the deck when it is ready. |
| **Visual** | The chart, table or form from the reply, large. **Show source** shows its OpenUI code, with **Copy**. Buttons and forms in the newest visual still answer. |
| **File** | Images, PDF, plain text, Markdown, CSV (as a table, first 200 rows), video and audio play inside the panel. Other files get a **Download** button. |
| **Media** | An image, video or audio file the AI made. |
| **Web page** | A card with the site, the page title and the full address, and **Open in a new tab**. |

Pages from other websites are never loaded inside Sibyl. Most sites refuse to be framed anyway, and a page shown inside the app could look like part of Sibyl. The card opens them in a new tab, without telling the site where you came from.

## When it opens

It opens by itself when the AI:

- starts using an agent's computer (once per reply),
- starts building or revising a deck,
- starts making an image, video or audio.

If you close the panel, it stops opening by itself in that conversation. New things still go into its **Activity** list, and the **Activity** button at the top of the chat shows how many there are. Opening something yourself turns auto-opening back on.

Pages the AI read with `read_webpage` are added to the Activity list without opening it.

You open it yourself from the chat:

- **Expand** (the layers button under a reply) on a visual,
- a file or picture you attached,
- the small computer picture under an agent's steps,
- **Preview** on a deck card,
- a **Read a webpage** step.

A plain click opens the panel. Ctrl-click or ⌘-click on the computer picture or a picture still opens it in a new tab.

## Using it

- **Activity**: the row of tabs at the top lists everything from this conversation, newest first. Arrow keys move between them.
- **Open in full page** (the arrow button in the header): the computer's own page, the deck editor, the file, or the website in a new tab.
- **Close**: the × button, or **Esc** while the panel has focus.
- **Ctrl+\\** (⌘\\ on a Mac) shows or hides the panel.
- **Resize**: drag its left edge, or focus the edge and use the arrow keys (Shift for bigger steps). Sibyl remembers the width.
- At 900px wide and below (tablets in portrait, phones) the panel covers the chat as a full-screen sheet. Close it to get back to the chat.

Each conversation keeps its own Activity list in this browser (the last 30 items, for the last 40 conversations). When you open an old chat its list comes back, closed until you open it.

The address names what is open, for example `/c/<chat>?panel=computer:<agent>` or `?panel=visual:<reply>`. Back and Forward open and close the panel, and a reload shows the same item again.

## For developers

Anything in the web app can show an item:

```ts
import { openSidePanel, closeSidePanel } from "../features/side-panel";

openSidePanel({ kind: "computer", agentId });                         // the person asked: always opens
openSidePanel({ kind: "media", uploadId, mediaType: "image" }, { auto: true }); // the AI started it: follows the closed-here rule
closeSidePanel();
```

Items:

```ts
type SidePanelItem =
  | { kind: "media"; uploadId: string; mediaType: "image" | "video" | "audio"; title?: string; jobId?: string }
  | { kind: "computer"; agentId: string; runId?: string }
  | { kind: "slides"; artifactId: string; title?: string }
  | { kind: "visual"; requestId: string; title?: string }
  | { kind: "file"; uploadId: string; name: string; mime: string }
  | { kind: "url"; url: string; title?: string };
```

`openSidePanel` sends a `sibyl:side-panel` window event (`detail` is the item; `closeSidePanel` sends `null`). `{ auto: true }` sends `sibyl:side-panel:auto` instead. The panel lives in `apps/web/features/side-panel/`; its state rules are in `state.ts` and what it follows on the socket is in `auto-open.ts`.

Auto-opening follows the shared socket: `tool.started` for `computer_*` tools (with the agent from `agent.turn`), for `create_slides` / `revise_slides`, and for media tools named `create_<image|video|audio|music|speech|…>`. A build shows a placeholder until its `tool.finished` arrives; then it becomes the deck (`artifact.kind: "slides"`) or the media file (`artifact.id` is the upload id). `tool.finished` also carries `link` (`{ url, title }`) for pages a tool read.

There are no settings or environment variables for the panel.
