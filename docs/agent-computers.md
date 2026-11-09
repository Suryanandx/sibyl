# Agent computers

An agent can have its own computer: a real browser in a sandbox, with a folder for files. It can open public websites, read them, click, fill in forms, download files and take screenshots. You can watch it work live, look at each step afterwards, and stop it at any time.

## Turn it on

1. Build the sandbox image once (it needs Docker):

   ```bash
   docker build -f Dockerfile.computer -t sibyl-computer:1.64.1 .
   # or: docker compose --profile computers build computer
   ```

2. Open **Agents**, edit an agent, and tick **Give it its own computer** in the **Computer** section. You can also set:
   - **Stop when idle for**: the sandbox stops after this many minutes without a browser action (default 5).
   - **Computer time per day**: when it is used up, the computer pauses until the next day (UTC). Default 60 minutes.

3. Chat with the agent and ask it to do something on the web: "Open example.com and take a screenshot."

If Docker is not running or the image is missing, the editor and the computer view say **Unavailable** and why. Sibyl never runs the browser on the gateway's own machine instead.

## Watching

- **In the chat**: when an agent uses its computer, a small live picture of its screen appears under its steps, and the chat's [side panel](side-panel.md) opens with the live screen and its steps. Click the picture to show it there again (Ctrl-click or ⌘-click opens the full view).
- **The computer view** (`/agents/<id>/computer`, or **Computer** on the agent's card): the live screen with its address, how much time it used today, a **Stop** button, and **What it did**: every step with a small picture, the page it was on, and anything that was blocked. Pick an earlier run from the list to see it again.

Only people who can see the agent can watch its computer or stop it.

Full video recordings of sessions are an Agent Serve feature. The open-source edition keeps the step-by-step timeline (the last 30 runs per agent).

## What it may do

| Tool | What it does | Approval |
|---|---|---|
| `computer_open` | Open a public web page | no |
| `computer_read` | Read the page's text and its elements | no |
| `computer_click` | Click links, tabs, checkboxes | no |
| `computer_type` | Fill a field (search boxes may press Enter) | no |
| `computer_select` | Choose options in a list | no |
| `computer_scroll` | Scroll the page | no |
| `computer_screenshot` | Save a screenshot to its files | no |
| `computer_download` | Download a file to its files | no |
| `computer_files`, `computer_read_file` | List and read its files | no |
| `computer_submit` | Send a form: sign in, send, post, save, confirm | yes |
| `computer_upload` | Put one of its files into a site's file picker | yes |
| `computer_purchase` | Buy, pay, order, donate, subscribe | always (high risk) |

"Approval" follows the agent's autonomy, like every other tool: **Ask me first** asks for every write; **Act, then tell me** and **Fully autonomous** run writes and report them; purchases always ask.

Read actions can't send anything by accident:

- `computer_click` refuses buttons that send a form, or whose label says they send, sign in, buy or delete.
- While the agent isn't running an approved write action, the browser itself refuses to send a form, and during a read action it also refuses data sent by page scripts. Blocked requests show up in the timeline.
- The approval card names the site, and the action only runs if the page is still on that site.

### Passwords

A password field only accepts a secret from the vault, written as `${secret:NAME}`. The gateway fills in the value; the agent never sees it, and the secret's **allowed hosts** apply (it is only typed on a site the secret allows). Store secrets in **Settings → Secrets**; with **Controlled** access the agent can only use the secrets you picked. Signing in then needs `computer_submit`, so it asks first.

## Safety

Each agent's computer is its own Docker container:

- **No host access**: no files from the host are mounted. Its files live on the gateway (`$SIBYL_DATA_DIR/computers/<agent>/files`) and are copied over the browser connection when it downloads or uploads.
- **Locked down**: runs as a normal user, read-only system files, no Linux capabilities, no privilege escalation, CPU, memory and process limits.
- **Network**: the browser is started with Sibyl's egress proxy and can only reach **public internet** addresses. Private networks, `localhost`, link-local and cloud metadata addresses (`169.254.169.254`), and other reserved ranges are refused, with the same checks Sibyl uses for every other web request (DNS rebinding included). WebRTC can't go around the proxy.
- **Time**: it stops when idle, after at most an hour per session, and when its daily time or budget is used up. Every action has a time limit.
- **Per workspace**: at most three computers run at once (configurable).

For the strictest setup on Linux, put the sandboxes on an internal Docker network that only reaches the gateway (`SIBYL_COMPUTER_NETWORK`, with `SIBYL_COMPUTER_PROXY_HOST` set to the gateway's container name). The browser's own traffic always goes through the proxy; the internal network also covers anything else in the container.

## Cost

Computer time is counted per agent per day. By default it costs nothing (it runs on your machine). Set `SIBYL_COMPUTER_USD_PER_HOUR` to put a price on it: the time then shows in usage and counts toward the agent's own budget and the workspace budget. When a limit is reached the computer stops cleanly, the creator gets a notification, and the agent is told why.

## Running the gateway in Docker

The gateway talks to Docker through its socket. When the gateway runs in a container, mount the socket and tell it how sandboxes reach it:

```yaml
gateway:
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  environment:
    SIBYL_COMPUTER_NETWORK: sibyl_default
    SIBYL_COMPUTER_PROXY_HOST: gateway
    SIBYL_COMPUTER_PROXY_BIND: 0.0.0.0
```

Mounting the Docker socket gives the gateway control of Docker on that machine. Only do it on a host dedicated to Sibyl.

All settings are listed in [configuration.md](configuration.md#agent-computers).
