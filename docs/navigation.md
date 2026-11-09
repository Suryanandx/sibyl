# Finding your way around

The rail on the left is the same on every screen. It has a few groups. A group
with more than one part shows them as tabs at the top of its screens.

| Rail | Tabs | Addresses |
| --- | --- | --- |
| Inbox (bell, top) | | `/inbox` |
| **Chat** | | `/`, `/c/<id>` |
| **Agents** | | `/agents`, `/agents/<id>/computer` |
| **Meetings** | | `/meetings`, `/meetings/<id>`, `/call/<id>` |
| **Spaces** | Slides · Media | `/library/slides`, `/media` |
| **Library** | Knowledge · Skills · Plugins · Integrations | `/knowledge`, `/skills`, `/skills/plugins`, `/integrations` |
| **Automations** | Routines · Monitors | `/routines`, `/monitors` |
| **Settings** (bottom) | Admin sections inside Settings | `/settings/<section>`, `/admin/<section>` |

At the bottom of the rail you also find the Getting started ring (until you
finish or dismiss it), the light/dark switch and the connection dot.

- **Inbox.** The bell opens the inbox: approvals waiting for you and what
  routines, monitors and agents did. The badge counts what is new.
- **Admin.** Organization owners and admins see an **Admin** heading in the
  Settings list (Organization, Users, Single sign-on, and so on). Admin
  sections keep their own addresses, `/admin/<section>`.
- **Only what you can use.** Groups and tabs you have no access to are hidden.
  A viewer, for example, has no Integrations tab. A group with no tabs left
  disappears, and a group opens on the first tab you can use.
- **Addresses.** Every address above works as a link and with Back and Forward.
  The rail highlights the group of the screen you are on.

## On a phone

There is no rail. In the chat, the menu button opens a short list of the same
groups (Agents, Meetings, Spaces, Library, Automations, Settings) above your
conversations. The bell sits in the chat's top bar. Tabs scroll sideways under
a screen's title. The back arrow on a screen returns to the chat.

## For developers

The groups and tabs are defined once in `apps/web/lib/nav.ts`; `placeOf` in
`apps/web/lib/routes.ts` names the group of an address. `ScreenFrame` shows
the tabs of the current group on every screen, so a new screen whose address
is listed as a tab gets them without extra code.
