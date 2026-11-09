/**
 * The Sibyl product family: one entry per product page (apps/site/products/<slug>.html).
 * Used by build-products.mjs (the pages), build-docs.mjs (the docs home) and kept in step
 * with the Products menu in index.html by hand.
 *
 * Costs: only numbers that were measured, each with where it comes from. Screenshots are
 * of the real app (apps/site/assets/screens/, made from a fresh install; see docs/site.md).
 */

const shot = (file, alt, width = 1600, height = 1000) => ({ src: `../assets/screens/${file}`, alt, width, height });

export const PRODUCTS = [
  {
    slug: "assistant",
    name: "Sibyl Assistant",
    line: "Chat and live voice, with answers you can see",
    headline: "An assistant you talk to, that answers with charts, tables and sources.",
    lede: "Type or talk. Sibyl answers in text and visuals, searches your own files, works in your Google, Microsoft and Slack accounts, and runs routines for you. Anything that sends, changes or spends asks you first. You pay for the AI you use, not for seats.",
    features: [
      {
        title: "Ask, and see the answer",
        text: "Replies can be charts, tables, plans, option cards and forms, with the sources underneath. Tap the mic and the same chat becomes a live voice conversation.",
        image: shot("chat-visual.webp", "A question about smartphone market share answered with a bar chart, a table and two sources"),
        docs: ["../docs/generative-ui.html", "Visual answers"]
      },
      {
        title: "Answers from your own files",
        text: "Add PDFs (scanned ones too), Word, Excel, PowerPoint, web pages, folders and ZIP files to a knowledge base. Sibyl searches them and shows which file and section each answer came from.",
        image: shot("knowledge-chat.webp", "An answer drawn from a knowledge base called Product handbook, with a cost table and the two documents it used listed as sources"),
        docs: ["../docs/knowledge.html", "Knowledge"]
      },
      {
        title: "Works in your apps, with your approval",
        text: "Connect Google Workspace, Microsoft 365 and Slack, or anything else through MCP. Sibyl can read and act in them, and every action that changes something shows an approval card first.",
        image: shot("integrations.webp", "The Integrations screen with Google Workspace, Microsoft 365 and Slack, and custom connectors through MCP"),
        docs: ["../docs/integrations.html", "Integrations"]
      },
      {
        title: "Routines and monitors that ask before they act",
        text: "Routines run on a schedule; monitors watch your mail, calendar, files or web pages. What they want to do waits in the Inbox until you approve it.",
        image: shot("inbox-approval.webp", "The Inbox with a routine waiting for approval before it calls an API, with Approve and Decline"),
        docs: ["../docs/monitors.html", "Routines and monitors"]
      },
      {
        title: "You choose what it costs",
        text: "Pick a preset (Cheapest, Balanced, Fastest or Best quality) and see the price of 100 messages before you start. Daily and monthly budgets stop spending before it happens.",
        image: shot("settings-models.webp", "Settings, Models: the presets with their price per 100 messages and the models each one uses"),
        docs: ["../docs/models-and-costs.html", "Models and costs"]
      }
    ],
    costs: [
      ["100 typed messages, Balanced preset", "about $0.27", "Model scout run of 2026-11-09", "../docs/models-and-costs.html"],
      ["Average reply in our screenshot run (Balanced, with web search and tools)", "$0.02", "Settings → Usage, 2026-11-10", null],
      ["Live voice with the Sibyl voice engine", "about $0.005–0.01 a minute", "Cheapest and Balanced presets", "../docs/voice.html#voice-engines-sibyl-voice-and-gpt-realtime"],
      ["A scanned PDF page into knowledge", "about $0.002 a page", "mistral-ocr, measured November 2026", "../docs/knowledge.html"]
    ],
    docs: [
      ["../docs/voice.html", "Voice"],
      ["../docs/generative-ui.html", "Visual answers"],
      ["../docs/knowledge.html", "Knowledge"],
      ["../docs/integrations.html", "Integrations"],
      ["../docs/skills-and-plugins.html", "Skills and plugins"],
      ["../docs/monitors.html", "Routines and monitors"],
      ["../docs/models-and-costs.html", "Models and costs"]
    ]
  },
  {
    slug: "meet",
    name: "Sibyl Meet",
    line: "Meetings with people and agents, and notes that write themselves",
    headline: "Meetings where people and agents work together, and the notes write themselves.",
    lede: "Start a call, invite people and agents, and talk. An agent can take part, or sit in as a silent note-taker that keeps the transcript, writes the summary as you go and finds the action items. Calls run on LiveKit, which you host yourself.",
    features: [
      {
        title: "A page for every meeting",
        text: "Afterwards each meeting has its own page: the overview, key points and AI insight, the transcript, the action items, comments and an Ask AI box. Save the notes to knowledge or share them by link.",
        image: shot("meeting.webp", "A meeting page with the overview, key points, AI insight, the participants, the recording and comments", 1440, 900),
        docs: ["../docs/meetings.html", "Meetings"]
      },
      {
        title: "Agents in the room",
        text: "Add agents as participants who speak when someone says their name, or as silent note-takers. The people panel shows who is in the call and what each agent is there to do.",
        image: shot("meeting-room.webp", "A live meeting room with a shared screen, a test camera feed, and the People panel listing three people and three agents with their roles", 1440, 900),
        docs: ["../docs/meetings.html", "Meetings"]
      },
      {
        title: "Every meeting in one place",
        text: "Upcoming, live and past meetings in one list, searchable by notes and people. Guests can join by link once the host lets them in.",
        image: shot("meetings-list.webp", "The Meetings list with two past meetings, their summaries, participants and action items", 1440, 900),
        docs: ["../docs/realtime.html", "Calls with LiveKit"]
      }
    ],
    costs: [
      ["One hour with a silent note-taker (notes plus transcription)", "about $0.02–0.12", "Measured 2026-11-09", "../docs/meetings.html#cost"],
      ["One notes refresh during the call", "$0.0001–0.0003", "z-ai/glm-5.3-flash, measured 2026-11-09", "../docs/meetings.html#cost"],
      ["One Ask AI question about a meeting", "about $0.003", "claude-sonnet-5.5, measured 2026-11-09", "../docs/meetings.html#cost"],
      ["The call itself", "free", "LiveKit on your own server", "../docs/realtime.html"]
    ],
    docs: [
      ["../docs/meetings.html", "Meetings"],
      ["../docs/realtime.html", "Calls with LiveKit"],
      ["../docs/agents.html", "Agents"]
    ],
    note: "Audio and video recordings of meetings come with Agent Serve, the enterprise edition."
  },
  {
    slug: "slides",
    name: "Sibyl Slides",
    line: "Decks from a prompt, your files or connected data",
    headline: "Slide decks from a prompt, your files or your data.",
    lede: "Ask for a deck in chat, or start one in Spaces → Slides. Sibyl gathers the facts first, shows you roughly what the build costs, then makes the deck. Edit it in the browser and export PowerPoint or PDF.",
    features: [
      {
        title: "Ask in chat, approve the build",
        text: "Sibyl writes the brief, the number of slides and an estimate, and waits for your approval before it spends anything.",
        image: shot("slides-approval.webp", "A request for a five-slide launch plan deck and the approval card showing the title, brief, number of slides and an estimate of about $0.003"),
        docs: ["../docs/slides.html", "Slides"]
      },
      {
        title: "Your decks in one place",
        text: "Every deck you or your agents made, grouped into spaces. Open one in the editor, or download it as PPTX or PDF.",
        image: shot("slides-library.webp", "Spaces, Slides with a five-slide deck called Q1 Product Launch Plan, with Open in editor, PPTX and PDF"),
        docs: ["../docs/slides.html", "Slides"]
      },
      {
        title: "Edit it yourself",
        text: "A browser editor with the slide list, text, charts, tables, images and shapes. Change anything, then export again.",
        image: shot("slides-editor.webp", "The slide editor with five slides on the left and the title slide, Ready to Launch Q1 with Confidence, open", 1600, 1218),
        docs: ["../docs/slides.html", "Slides"]
      }
    ],
    costs: [
      ["Our five-slide launch plan deck", "$0.0030", "Measured in Settings → Usage, 2026-11-10 (deepseek-v4.1-flash)", null],
      ["Estimate shown before a build when no price is known", "$0.004 a slide", "SIBYL_SLIDES_USD_PER_SLIDE default", "../docs/configuration.html"]
    ],
    docs: [["../docs/slides.html", "Slides"]]
  },
  {
    slug: "studio",
    name: "Sibyl Studio",
    line: "Images, video and audio in chat, and a Media library",
    headline: "Images, video and audio, made in the chat you already use.",
    lede: "Switch the composer from Chat to Image, Video or Audio, pick a model and its settings, and see the price before you make anything. Point at earlier work with @ references. Everything you make lands in Media.",
    features: [
      {
        title: "Make it in chat",
        text: "The result opens in the side panel with its prompt, model, settings and cost. Make another, remix it, or use it as a reference for the next one.",
        image: shot("side-panel-image.webp", "An image of a ceramic cup made in Create mode, with the side panel showing its prompt, model, settings and its cost of $0.039"),
        docs: ["../docs/media.html", "Media"]
      },
      {
        title: "Each model's own settings, with the price up front",
        text: "Aspect ratio, resolution, length, sound and seed, as the model offers them. The estimate updates as you change them.",
        image: shot("studio-settings.webp", "Video settings for Seedance 1.5 Pro: aspect ratio, 480p, 4 seconds, no sound, and an estimate of about $0.049"),
        docs: ["../docs/media.html", "Media"]
      },
      {
        title: "A library for everything you made",
        text: "Spaces → Media keeps the images, videos and audio from chat, agents and your team, with filters by type, model and person, favourites and collections.",
        image: shot("media-library.webp", "The Media library with three generated images and a short video"),
        docs: ["../docs/media.html", "Media"]
      }
    ],
    costs: [
      ["One image, Nano Banana (gemini-2.5-flash-image)", "$0.039", "Measured 2026-11-09/10", "../docs/media.html"],
      ["One image, FLUX.2 Klein 4B", "$0.015", "Measured 2026-11-09/10", "../docs/media.html"],
      ["A 4-second 480p video, Seedance 1.5 Pro, no sound", "$0.049", "Measured 2026-11-10", null],
      ["A 4-second 480p video, Seedance 2.0 Fast, with a reference image", "$0.17", "Measured 2026-11-09/10", "../docs/media.html"],
      ["A 30-second music clip, Lyria 3", "$0.04", "Measured 2026-11-09/10", "../docs/media.html"]
    ],
    docs: [
      ["../docs/media.html", "Media"],
      ["../docs/side-panel.html", "The side panel"]
    ]
  },
  {
    slug: "agents",
    name: "Sibyl Agents",
    line: "Agents you build, with their own face, voice and computer",
    headline: "Agents you build yourself, that work where you can see them.",
    lede: "Give an agent a name, a face, a voice and instructions. Decide what it may use and how much it may do on its own. It can have its own sandboxed browser that you watch live, work in Slack and Teams, and run on a schedule.",
    features: [
      {
        title: "Your team of agents",
        text: "Start from a template or a blank agent. Each one shows its autonomy and access at a glance, and you can chat with it or open its computer.",
        image: shot("agents.webp", "The Agents screen with four agents, each with its own avatar, autonomy and access, and the templates to start from"),
        docs: ["../docs/agents.html", "Agents"]
      },
      {
        title: "Access, autonomy and voice",
        text: "An agent never gets more than you have. Choose Everything I can use or a controlled list, and Ask me first, Act then tell me, or Fully autonomous. Sending money, deleting and sharing outside always ask.",
        image: shot("agent-editor.webp", "Editing an agent: identity, instructions, model, its own voice and voice engine, and the Access and Autonomy choices"),
        docs: ["../docs/agents.html#access--never-more-than-the-creator", "Access and autonomy"]
      },
      {
        title: "Watch it work",
        text: "With a computer turned on, an agent opens real web pages in a sandbox on your server. Its screen shows live in the side panel next to the chat.",
        image: shot("agent-computer-chat.webp", "Research Dot reading a Hacker News thread on its own computer, live in the side panel, next to its answer in the chat"),
        docs: ["../docs/agent-computers.html", "Agent computers"]
      },
      {
        title: "See every step afterwards",
        text: "The computer page keeps a picture of each step it took, grouped by run. Stop it at any time; it also stops on its own when idle.",
        image: shot("agent-computer.webp", "Research Dot's computer page: the live browser with a Stop button, and What it did with a picture of each step"),
        docs: ["../docs/agent-computers.html", "Agent computers"]
      }
    ],
    costs: [
      ["An agent's turn", "the same as a chat turn", "Agents use the same models and budgets as chat", "../docs/agents.html#budgets"],
      ["Agent computer time", "free by default", "It runs on your machine; set SIBYL_COMPUTER_USD_PER_HOUR to price it", "../docs/agent-computers.html"],
      ["Our test: three browsing tasks", "7 computer minutes", "Out of 60 a day by default, measured 2026-11-10", null]
    ],
    docs: [
      ["../docs/agents.html", "Agents"],
      ["../docs/agent-computers.html", "Agent computers"],
      ["../docs/slack-and-teams.html", "Slack and Teams"]
    ]
  }
];
