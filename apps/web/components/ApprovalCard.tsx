"use client";

import { useId, useState } from "react";
import type { ApprovalView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";

export type ApprovalCardStatus = "pending" | "approved" | "declined" | "expired";

interface ApprovalCardProps {
  approval: ApprovalView;
  status: ApprovalCardStatus;
  /** True after the user decided, until the gateway confirms. */
  submitting?: boolean;
  /** Omitted when the card is read-only (e.g. a saved conversation). */
  onDecide?: (decision: "approve" | "decline", remember: boolean) => void;
}

const RESOLVED_LABEL: Record<Exclude<ApprovalCardStatus, "pending">, string> = {
  approved: "Approved",
  declined: "Declined",
  expired: "Expired — nothing was done"
};

/** Asks before Sibyl does something in the world (send, create, delete, buy). */
export function ApprovalCard({ approval, status, submitting = false, onDecide }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const titleId = useId();
  const summaryId = useId();
  const rememberId = useId();
  const pending = status === "pending";
  const interactive = pending && Boolean(onDecide) && !submitting;

  return (
    <section
      className={`approvalCard ${status}`}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
    >
      <div className="approvalHead">
        <span className="approvalEyebrow">
          {pending ? "Needs your approval" : "Approval"}
          {approval.risk === "high" ? (
            <span className="approvalRisk" title="Sending, deleting, sharing or moving money can't easily be taken back.">
              Hard to undo
            </span>
          ) : null}
        </span>
        <h3 className="approvalTitle" id={titleId}>
          {approval.title}
        </h3>
      </div>
      <p className="approvalSummary" id={summaryId}>
        {approval.summary}
      </p>
      {approval.details && approval.details.length > 0 ? (
        <dl className="approvalDetails">
          {approval.details.map((detail) => (
            <div className="approvalDetail" key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {pending && onDecide ? (
        <div className="approvalFoot">
          <label className="approvalRemember" htmlFor={rememberId}>
            <input
              id={rememberId}
              type="checkbox"
              checked={remember}
              disabled={!interactive}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>Don&rsquo;t ask again in this chat</span>
          </label>
          <div className="approvalButtons">
            <button
              type="button"
              className="approvalBtn"
              disabled={!interactive}
              onClick={() => onDecide("decline", false)}
            >
              Decline
            </button>
            <button
              type="button"
              className="approvalBtn primary"
              disabled={!interactive}
              aria-busy={submitting}
              onClick={() => onDecide("approve", remember)}
            >
              {submitting ? <span className="spinner" aria-hidden /> : null}
              Approve
            </button>
          </div>
        </div>
      ) : null}

      <p className="approvalStatus" role="status" aria-live="polite">
        {pending ? (
          onDecide ? null : "Waiting for a decision"
        ) : (
          <>
            <Icon
              name={status === "approved" ? "check" : "close"}
              size={14}
              className={`approvalStatusIcon ${status}`}
            />
            {RESOLVED_LABEL[status]}
          </>
        )}
      </p>
    </section>
  );
}
