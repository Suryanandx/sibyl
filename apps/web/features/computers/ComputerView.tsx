"use client";

import { useEffect } from "react";
import type { ComputerActionView } from "@open-gpt-live/protocol";
import { Badge, Button, Card, CardHeader, EmptyState, Muted, Notice, Select, cx, type Tone } from "../../components/ui";
import { useGateway } from "../../lib/gateway";
import { shortUrl, stateLabel, timeOf, usageLabel } from "./format";
import { useComputer } from "./useComputer";
import styles from "./computers.module.css";

const STATE_TONE: Record<string, Tone> = { running: "positive", starting: "info", paused: "warning", unavailable: "danger" };

/**
 * An agent's computer: the live screen with its address, Stop, and the
 * timeline of what it did (the current run as it happens, or a past run).
 * `runId` opens that run's timeline; `stacked` puts the timeline under the
 * screen (the chat's side panel).
 */
export function ComputerView({ agentId, agentName, runId, stacked = false }: { agentId: string; agentName: string; runId?: string; stacked?: boolean }) {
  const computer = useComputer(agentId, { timeline: true });
  const { connected } = useGateway();
  const { status, openRun } = computer;
  const live = status?.state === "running" || status?.state === "starting";
  useEffect(() => {
    if (runId && connected) openRun(runId);
  }, [runId, connected, openRun]);
  return (
    <div className={cx(styles.layout, stacked && styles.stacked)}>
      <Card className={styles.screenCard} aria-label={`${agentName}'s screen`}>
        <div className={styles.addressBar}>
          <Badge tone={STATE_TONE[status?.state ?? ""] ?? "neutral"}>{stateLabel(status)}</Badge>
          <span className={styles.address} title={status?.url}>
            {shortUrl(status?.url) || (live ? "about:blank" : "No page open")}
          </span>
          <Button size="sm" variant="danger" disabled={!live} onClick={computer.stop}>
            Stop
          </Button>
        </div>
        <div className={styles.screen}>
          {computer.frame && live ? (
            // Live frames are data URLs from the socket, not files: no next/image here.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={computer.frame} alt={`${agentName}'s browser: ${status?.title || shortUrl(status?.url)}`} />
          ) : (
            <div className={styles.screenIdle}>
              <p>{idleText(status?.state, agentName)}</p>
            </div>
          )}
        </div>
        {status ? (
          <Muted className={styles.meta}>
            {usageLabel(status)} · stops after {status.idleMinutes} idle min
          </Muted>
        ) : null}
        {status?.reason ? <Notice tone={status.state === "unavailable" ? "danger" : "warning"}>{status.reason}</Notice> : null}
        {computer.error ? <Notice tone="danger">{computer.error}</Notice> : null}
      </Card>

      <Card className={styles.logCard} aria-label="What it did">
        <CardHeader
          title="What it did"
          meta={
            computer.runs.length > 1 ? (
              <Select aria-label="Run" value={computer.runId ?? ""} onChange={(e) => computer.openRun(e.target.value)}>
                {computer.runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {new Date(run.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {run.actions} steps
                  </option>
                ))}
              </Select>
            ) : undefined
          }
        />
        {computer.actions.length ? (
          <ol className={styles.log}>
            {computer.actions.map((action) => (
              <ActionRow key={action.id} action={action} />
            ))}
          </ol>
        ) : (
          <EmptyState title="Nothing yet" compact>
            <p>Ask {agentName} to do something on the web. Each step shows up here, with a picture.</p>
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

function ActionRow({ action }: { action: ComputerActionView }) {
  return (
    <li className={styles.logItem} data-status={action.status}>
      {action.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.thumb} src={`data:image/jpeg;base64,${action.thumb}`} alt="" />
      ) : (
        <span className={styles.thumb} aria-hidden />
      )}
      <span className={styles.logText}>
        <strong>{action.label}</strong>
        <small>
          {timeOf(action.at)}
          {action.url ? ` · ${shortUrl(action.url)}` : ""}
        </small>
        {action.detail && (action.status !== "ok" || action.tool === "computer_stop") ? <small className={styles.logDetail}>{action.detail}</small> : null}
      </span>
      {action.status !== "ok" ? <Badge tone={action.status === "blocked" ? "warning" : "danger"}>{action.status === "blocked" ? "Blocked" : "Failed"}</Badge> : null}
    </li>
  );
}

function idleText(state: string | undefined, name: string): string {
  switch (state) {
    case "disabled":
      return `${name} has no computer. Turn it on in the agent's settings.`;
    case "unavailable":
      return "Agent computers can't run on this gateway right now.";
    case "paused":
      return "Paused.";
    case "off":
      return `The computer is off. It starts when ${name} next uses the browser.`;
    default:
      return "Connecting…";
  }
}
