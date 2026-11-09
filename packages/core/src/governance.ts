/**
 * Governance hooks: the audit trail and the tool/model policy.
 *
 * One `Governance` object per gateway runtime (`runtime.governance`). The
 * open-source code calls it at the places that matter:
 *
 * - `audit(event)`: sign-ins, member and role changes, invitations,
 *   connections, secret use (by name only), approvals, write actions,
 *   downloads, licence and policy changes. With no sink registered (no
 *   Enterprise licence) it does nothing.
 * - `toolDecision(tool, scope)`: consulted by `usableTools()` (what the model
 *   is offered) and by the tool loop (what may run, and whether a write needs
 *   an admin's second approval). With no policy, every tool is allowed.
 * - `modelDecision(model, scope)`: consulted where a model is chosen for a
 *   turn or run. With no policy, every model is allowed.
 * - `secondApproval(request)`: the admin's second approval for a write
 *   action a policy marked. Only asked when a policy says so.
 *
 * Enterprise modules (ee/) register the sinks and policies; open-source code
 * never imports them.
 */
import type { Principal } from "./permissions";
import type { ToolDefinition } from "./tools";

/* ───────────── Audit ───────────── */

/** The audit catalogue (what the log records). Modules may add their own "area.verb" actions. */
export const AUDIT_ACTIONS = {
  SIGN_IN: "auth.sign_in",
  SIGN_IN_FAILED: "auth.sign_in_failed",
  SIGN_OUT: "auth.sign_out",
  OWNER_CREATED: "auth.owner_created",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_REMOVED: "member.removed",
  INVITE_CREATED: "invite.created",
  INVITE_REVOKED: "invite.revoked",
  INVITE_ACCEPTED: "invite.accepted",
  WORKSPACE_CREATED: "workspace.created",
  WORKSPACE_DELETED: "workspace.deleted",
  WORKSPACE_UPDATED: "workspace.updated",
  ORG_SETTINGS_CHANGED: "org.settings_changed",
  ORG_ROLE_CHANGED: "member.org_role_changed",
  USER_DISABLED: "user.disabled",
  USER_ENABLED: "user.enabled",
  USER_REMOVED: "user.removed",
  INVITE_RESENT: "invite.resent",
  CONNECTOR_CONNECTED: "connector.connected",
  CONNECTOR_CHANGED: "connector.changed",
  CONNECTOR_DISCONNECTED: "connector.disconnected",
  CONNECTOR_APP_CHANGED: "connector.app_changed",
  SECRET_USED: "secret.used",
  SECRET_SAVED: "secret.saved",
  SECRET_DELETED: "secret.deleted",
  APPROVAL_DECIDED: "approval.decided",
  SECOND_APPROVAL_REQUESTED: "approval.second_requested",
  SECOND_APPROVAL_DECIDED: "approval.second_decided",
  TOOL_WRITE: "tool.write",
  TOOL_BLOCKED: "tool.blocked",
  MODEL_BLOCKED: "model.blocked",
  EXPORT: "data.exported",
  LICENSE_CHANGED: "license.changed",
  ROLE_CHANGED: "role.changed",
  ROLE_ASSIGNED: "role.assigned",
  GRANT_CHANGED: "grant.changed",
  POLICY_CHANGED: "policy.changed",
  RETENTION_PURGED: "retention.purged",
  AUDIT_EXPORTED: "audit.exported",
  AUDIT_STREAM_CHANGED: "audit.stream_changed"
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditOutcome = "success" | "failure" | "denied";

/** Who did it. `system`: the gateway itself (scheduled jobs, retention). */
export interface AuditActor {
  kind: "user" | "token" | "local" | "system";
  userId?: string;
  email?: string;
  name?: string;
}

/** Plain values only: never secret values, message text or tool output. */
export type AuditDetails = Record<string, string | number | boolean | null | readonly string[]>;

export interface AuditEvent {
  action: AuditAction | (string & {});
  /** Default: system. */
  actor?: AuditActor;
  workspaceId?: string;
  target?: { kind: string; id?: string; name?: string };
  /** Default: success. */
  outcome?: AuditOutcome;
  details?: AuditDetails;
  ip?: string;
}

/** What a sink receives: the event with its time and organization filled in. */
export interface AuditEntryInput extends AuditEvent {
  orgId: string;
  at: number;
  actor: AuditActor;
  outcome: AuditOutcome;
}

export type AuditSink = (entry: AuditEntryInput) => void;

/** The audit actor for a principal (undefined: the system). */
export function auditActor(principal: Principal | undefined): AuditActor {
  if (!principal) return { kind: "system" };
  return {
    kind: principal.kind,
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.email ? { email: principal.email } : {}),
    ...(principal.name ? { name: principal.name } : {})
  };
}

/* ───────────── Tool and model policy ───────────── */

export interface PolicyScope {
  principal?: Principal;
  workspaceId?: string;
}

export type GovernedTool = Pick<ToolDefinition, "name" | "effect" | "source" | "provider" | "risk">;

export interface ToolDecision {
  allowed: boolean;
  /** Why it is not allowed (shown to the model and the person). */
  reason?: string;
  /** A write that also needs an organization admin's approval after the person's own. */
  secondApproval?: boolean;
}

export interface ModelDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * A rule set from an enterprise module. Return undefined to stay out of the
 * decision. Blocks win over allows; any `secondApproval: true` applies.
 * Both must be synchronous and cheap (they run each time tools are offered).
 */
export interface ToolPolicyHook {
  tool?(tool: GovernedTool, scope: PolicyScope): Partial<ToolDecision> | undefined;
  model?(model: string, scope: PolicyScope): ModelDecision | undefined;
}

export interface SecondApprovalRequest {
  tool: GovernedTool & Pick<ToolDefinition, "title">;
  input: Record<string, unknown>;
  /** Who asked (the run's principal) and where. */
  principal?: Principal;
  workspaceId?: string;
  runId: string;
  conversationId?: string;
  signal: AbortSignal;
}

export type SecondApprovalOutcome = "approved" | "declined" | "expired";
export type SecondApprover = (request: SecondApprovalRequest) => Promise<SecondApprovalOutcome>;

/* ───────────── The runtime object ───────────── */

export interface Governance {
  /** Record an audit event (no-op without a sink). Never throws. */
  audit(event: AuditEvent): void;
  /** True when a sink is listening (skip building expensive details otherwise). */
  readonly auditing: boolean;
  toolDecision(tool: GovernedTool, scope?: PolicyScope): ToolDecision;
  modelDecision(model: string, scope?: PolicyScope): ModelDecision;
  /** Ask an admin to approve too. Without an approver this declines (a policy asked, nobody can answer). */
  secondApproval(request: SecondApprovalRequest): Promise<SecondApprovalOutcome>;
  registerAuditSink(sink: AuditSink): () => void;
  registerToolPolicy(policy: ToolPolicyHook): () => void;
  setSecondApprover(approver: SecondApprover): () => void;
}

export interface GovernanceOptions {
  orgId: string;
  now?: () => number;
  /** A sink or policy threw (logged; never breaks the caller). */
  onError?(where: string, error: unknown): void;
}

const ALLOWED: ToolDecision = Object.freeze({ allowed: true });
const MODEL_ALLOWED: ModelDecision = Object.freeze({ allowed: true });

export function createGovernance(options: GovernanceOptions): Governance {
  const now = options.now ?? Date.now;
  const sinks = new Set<AuditSink>();
  const policies = new Set<ToolPolicyHook>();
  let approver: SecondApprover | undefined;
  const failed = (where: string, error: unknown) => options.onError?.(where, error);

  return {
    get auditing() {
      return sinks.size > 0;
    },
    audit(event) {
      if (sinks.size === 0) return;
      const entry: AuditEntryInput = {
        ...event,
        orgId: options.orgId,
        at: now(),
        actor: event.actor ?? { kind: "system" },
        outcome: event.outcome ?? "success"
      };
      for (const sink of sinks) {
        try {
          sink(entry);
        } catch (error) {
          failed("audit", error);
        }
      }
    },
    toolDecision(tool, scope = {}) {
      if (policies.size === 0) return ALLOWED;
      let second = false;
      for (const policy of policies) {
        let decision: Partial<ToolDecision> | undefined;
        try {
          decision = policy.tool?.(tool, scope);
        } catch (error) {
          // A broken rule blocks rather than silently allowing.
          failed("tool_policy", error);
          return { allowed: false, reason: "An organization policy could not be checked." };
        }
        if (decision?.allowed === false) return { allowed: false, reason: decision.reason ?? "Blocked by an organization policy." };
        if (decision?.secondApproval && tool.effect === "write") second = true;
      }
      return second ? { allowed: true, secondApproval: true } : ALLOWED;
    },
    modelDecision(model, scope = {}) {
      if (policies.size === 0) return MODEL_ALLOWED;
      for (const policy of policies) {
        try {
          const decision = policy.model?.(model, scope);
          if (decision && !decision.allowed) return { allowed: false, reason: decision.reason ?? `The model ${model} is not allowed by an organization policy.` };
        } catch (error) {
          failed("model_policy", error);
          return { allowed: false, reason: "An organization policy could not be checked." };
        }
      }
      return MODEL_ALLOWED;
    },
    async secondApproval(request) {
      if (!approver) return "declined";
      try {
        return await approver(request);
      } catch (error) {
        failed("second_approval", error);
        return "declined";
      }
    },
    registerAuditSink(sink) {
      sinks.add(sink);
      return () => void sinks.delete(sink);
    },
    registerToolPolicy(policy) {
      policies.add(policy);
      return () => void policies.delete(policy);
    },
    setSecondApprover(next) {
      approver = next;
      return () => {
        if (approver === next) approver = undefined;
      };
    }
  };
}

/** Governance that records nothing and allows everything (bare test runtimes). */
export function createOpenGovernance(orgId = "owner"): Governance {
  return createGovernance({ orgId });
}
