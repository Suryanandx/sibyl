"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { paths } from "../../lib/routes";
import { shortUrl, stateLabel } from "./format";
import { useComputer } from "./useComputer";
import styles from "./computers.module.css";

/**
 * A small live view of an agent's computer for a chat turn in which the agent
 * used its browser. It links to the full computer view; with `onOpen`, a plain
 * click shows it next to the chat instead (a modified click still opens the page).
 */
export function ComputerThumbnail({ agentId, agentName, onOpen }: { agentId: string; agentName: string; onOpen?: () => void }) {
  const { status, frame } = useComputer(agentId);
  const running = status?.state === "running";
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  };
  return (
    <Link href={paths.agentComputer(agentId)} className={styles.mini} aria-label={`Watch ${agentName}'s computer`} onClick={onClick}>
      <span className={styles.miniScreen}>
        {frame && running ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={frame} alt="" />
        ) : (
          <span className={styles.miniIdle}>{stateLabel(status)}</span>
        )}
      </span>
      <span className={styles.miniText}>
        <strong>{agentName}'s computer</strong>
        <small>{running ? shortUrl(status?.url) || "Running" : "Watch the steps"}</small>
      </span>
    </Link>
  );
}
