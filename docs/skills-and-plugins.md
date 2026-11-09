# Skills and plugins

## Skills

A skill is a named instruction pack ("how we write release notes"): a slug
name, a title, a one-line **description of when to use it**, Markdown
instructions, optional expected tools and up to 20 small reference files.

### Progressive disclosure

The system prompt lists only enabled skills' **names and descriptions**
(at most 25 skills / ~2,000 characters, descriptions cut at 180 characters) —
typically 30–60 tokens per skill. The full instructions and files are loaded
only when the brain calls `use_skill` (read) with the skill's name
(`use_skill { name, file? }` reads one bundled file). Disabling the
`use_skill` tool or lacking `skills.use` removes the list from the prompt.

### Sources and versions

- **Your skills** — created in the app or imported. Every content edit bumps
  the patch version and keeps the previous text (last 10) so it can be restored.
- **Built-in** — three seeded skills: *Write a clear status update*,
  *Summarise a long document with citations*, *Plan a project with milestones*.
  They can be switched off or duplicated, not edited or deleted.
- **Plugin** — created by a plugin; switched on/off with it, removed on uninstall.

Skills are available in one workspace or in all (`scope: "all"`). Names are
unique across the organization.

### SKILL.md, folders and zips

```markdown
---
name: release-notes
title: Write release notes          # optional (else the first # heading)
description: Use when the user asks for release notes from merged pull requests.
version: 1.2.0                      # optional
tools: [read_webpage, web_search]   # or allowed-tools
---

# Release notes
…instructions…
```

Import a single `SKILL.md`, a folder (the browser sends `{ files: [{ path, content }] }`),
or a zip. `SKILL.md` must be at the top or one folder down; other files under
that folder are kept if they are UTF-8 text, ≤ 64 KB each and ≤ 256 KB in
total (others are listed as skipped). The zip is read in memory, never
extracted to disk; an absolute path, drive letter, backslash or `..` anywhere
rejects the whole import; every entry is size-capped while inflating; the
archive is capped at 2 MB. Importing a name you already own adds a new version.
Export gives `SKILL.md`, or `<name>.zip` when the skill has files.

### Skills API

| Route | Permission |
|---|---|
| `GET /api/skills`, `GET /api/skills/:id`, `GET /api/skills/:id/versions`, `GET /api/skills/:id/export` | `skills.use` |
| `POST /api/skills`, `PATCH /api/skills/:id`, `DELETE /api/skills/:id`, `POST /api/skills/:id/restore {version}`, `POST /api/skills/import[?scope=all]` | `skills.edit` |

## Plugins

A plugin is a `sibyl-plugin.json` that bundles skills, MCP servers, the
secrets they need, empty knowledge bases and routine templates — installed,
switched and removed as one unit.

### Install flow

1. **Source:** the curated catalog (`apps/gateway/src/plugins/catalog.json`),
   an https URL to a manifest, or a git repository (GitHub, GitLab, Bitbucket;
   `…/tree/<ref>/<dir>` supported). For git, only the manifest file is fetched
   from the host's raw-file URL — nothing is cloned or executed.
2. **Fetch safety:** https only, SSRF guard on every hop (private, local and
   link-local addresses refused), at most 3 redirects, 256 KB, 10 s.
3. **Review:** `POST /api/plugins/preview` validates and summarises without
   installing; the app shows every skill, connection (with its URL or
   command), key, knowledge base and routine before the user confirms.
4. **Install:** skills are created (`source: "plugin"`; a clashing name gets
   the plugin id as prefix), knowledge bases are created empty in the current
   workspace (an existing base with the same name is reused, not owned).
5. **Keys:** if a required secret is missing the plugin is **needs_secrets**
   ("Needs a key" in the app). The app opens the secure key box; the value is
   posted once to `/api/plugins/:id/secrets`, stored encrypted in the vault
   with the manifest's allowed hosts, and never echoed, logged or shown to the
   model. Keys added on the Secrets screen count too (`/recheck`).
6. **Connections:** with every key present, MCP servers are registered through
   the Connections manager as `<pluginId>-<key>` (or `<pluginId>` when the key
   equals the id). `${secret:NAME}` stays a reference and is resolved only at
   connect time, only for the allowed hosts.
7. **Routines:** templates are offered after install and created only when the
   user accepts each one (`routines.manage`).

**Disable/enable** switches the plugin's skills and MCP servers together.
**Uninstall** removes its skills, servers and the routines it created, and its
knowledge bases if they are still empty (bases with documents and vault keys
are kept — they hold the user's data). Reinstalling replaces the previous version's parts.

### Safety

Plugins are data. No manifest field runs code in the gateway. MCP servers
with `transport: "stdio"` would run a program on the host; they start only
when the operator sets `SIBYL_ALLOW_STDIO_MCP=true` (otherwise the plugin
shows an error for that part), and the review step shows the exact command.
Remote (`http`) servers must use https and may only receive secrets in headers.

### Manifest reference (`manifestVersion: 1`)

Validation is strict: unknown keys are rejected at every level.

```jsonc
{
  "$schema": "…",                       // optional, ignored
  "manifestVersion": 1,                 // required
  "id": "github",                       // [a-z0-9-], 1–64, unique per organization
  "name": "GitHub",                     // ≤ 80
  "version": "1.0.0",                   // semver
  "description": "…",                   // ≤ 500
  "author": "…", "homepage": "https://…", "license": "MIT",   // optional
  "skills": [{                          // ≤ 20
    "name": "release-notes",            // skill slug
    "title": "…", "description": "Use when …", "instructions": "# Markdown …",
    "tools": ["web_search"],            // optional, informational
    "files": [{ "name": "template.md", "content": "…" }]   // optional, same caps as skills
  }],
  "mcpServers": {                       // ≤ 5; key: [A-Za-z0-9_-]{1,24}
    "github": { "transport": "http", "url": "https://api.githubcopilot.com/mcp/",
                "headers": { "Authorization": "Bearer ${secret:GITHUB_TOKEN}" } },
    "files":  { "transport": "stdio", "command": "npx", "args": ["-y", "…"],
                "env": { "TOKEN": "${secret:FILES_TOKEN}" } }
  },
  "secrets": [{                         // ≤ 10; every ${secret:X} used above must be declared
    "name": "GITHUB_TOKEN",             // UPPER_SNAKE_CASE
    "description": "…",
    "allowedHosts": ["api.githubcopilot.com"],   // hosts it may be sent to, or "local" for stdio
    "howToGet": "…", "docsUrl": "https://…",
    "optional": false
  }],
  "routines": [{ "name": "…", "instruction": "…", "cron": "0 9 * * 1" }],   // ≤ 10, 5-field cron
  "knowledgeBases": [{ "name": "Research sources", "description": "…" }]  // ≤ 5
}
```

Whole manifest ≤ 256 KB. The catalog ships three examples built from Sibyl's
own parts: **Meeting notes kit** (two skills + a weekly routine template),
**Research desk** (two research skills + a "Research sources" knowledge base),
and **GitHub** (two skills + GitHub's official remote MCP server with
`${secret:GITHUB_TOKEN}`).

### Plugins API

| Route | Permission |
|---|---|
| `GET /api/plugins` → `{ installed, catalog, stdioAllowed }`, `GET /api/plugins/:id` | `skills.use` |
| `POST /api/plugins/preview {source}`, `POST /api/plugins/install {source, scope}` | `plugins.install` |
| `PATCH /api/plugins/:id {enabled}`, `DELETE /api/plugins/:id` | `plugins.install` |
| `POST /api/plugins/:id/secrets {name, value, allowedHosts?}`, `POST /api/plugins/:id/recheck` | `plugins.install` |
| `POST /api/plugins/:id/routines {index}` | `routines.manage` |

`source` is `{ kind: "catalog" | "url" | "git", ref }`; `scope` is
`"workspace"` (default) or `"all"`. MCP servers and vault secrets are
organization-wide, like everything on the Connections and Secrets screens.

## Web

- `apps/web/features/skills` → `SkillsScreen` (list, editor with Markdown
  preview, import SKILL.md/zip/folder, export, versions, built-ins), `MarkdownPreview`.
- `apps/web/features/plugins` → `PluginsScreen` (catalog cards, installed list
  with status, install from git/URL with review, "Needs a key" → secure key box,
  enable/disable, uninstall, routine templates).

Mount them as screens, e.g. `/skills` renders `<SkillsScreen />` and
`<PluginsScreen />`, inside `AppSessionProvider` (they use `useAppSession()`
for permissions and the current workspace).
