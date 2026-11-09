"use client";

import Link from "next/link";
import { useEffect, type ComponentType } from "react";
import { AuditSection, PoliciesSection, RolesSection } from "../../features/admin-governance";
import { OrganizationSection, UsersSection } from "../../features/admin-org";
import { ScimIcon, ScimSection, SessionIcon, SessionPolicySection, SsoIcon, SsoSection } from "../../features/admin-identity";
import { useRouter } from "next/navigation";
import { ScreenFrame, ScreenNotice, type ScreenNavItem } from "../../components/ScreenFrame";
import { AdminIcon } from "../../components/AppRail";
import { useAppSession, type AppSession } from "../../lib/app-session";
import { ADMIN_SECTIONS, paths, type AdminSection } from "../../lib/routes";
import { AuditIcon, OrgIcon, PoliciesIcon, RolesIcon, UsageIcon, UsersIcon, type SectionIcon } from "../settings/icons";
import { UsageControls } from "../../features/admin-usage";
import { ENTERPRISE } from "../../lib/edition";
import { adminNavId, settingsNav } from "../settings/nav";

interface AdminSectionDefinition {
  id: AdminSection;
  title: string;
  description: string;
  icon: SectionIcon;
  /**
   * Licence feature that unlocks the section (`useAppSession().hasFeature`),
   * using the ids in packages/core/src/features.ts. Absent: part of the free edition.
   */
  feature?: "custom_roles" | "policies" | "sso" | "scim" | "audit_log" | "usage_advanced";
  /** The section body, shown when the section is unlocked (otherwise a placeholder). */
  component?: ComponentType;
}

const ADMIN_SECTION_DEFINITIONS: Record<AdminSection, AdminSectionDefinition> = {
  org: { id: "org", title: "Organization", description: "Name, defaults for new people, workspaces and licence.", icon: OrgIcon, component: OrganizationSection },
  users: {
    id: "users",
    title: "Users",
    description: "Everyone in the organization: roles, workspaces, sign-in and invitations.",
    icon: UsersIcon,
    component: UsersSection
  },
  sso: {
    id: "sso",
    title: "Single sign-on",
    description: "Sign in through your identity provider (OpenID Connect or SAML), claimed domains and required SSO.",
    icon: SsoIcon,
    feature: "sso",
    component: SsoSection
  },
  scim: {
    id: "scim",
    title: "Provisioning (SCIM)",
    description: "Let your identity provider create, update and turn off accounts and groups.",
    icon: ScimIcon,
    feature: "scim",
    component: ScimSection
  },
  sessions: {
    id: "sessions",
    title: "Session policies",
    description: "Session length, idle sign-out, allowed networks and required two-step verification.",
    icon: SessionIcon,
    feature: "sso",
    component: SessionPolicySection
  },
  roles: { id: "roles", title: "Roles", description: "Custom roles and per-resource grants.", icon: RolesIcon, feature: "custom_roles", component: RolesSection },
  policies: {
    id: "policies",
    title: "Policies",
    description: "Second approvers, model allowlists, blocked tools and data retention.",
    icon: PoliciesIcon,
    feature: "policies",
    component: PoliciesSection
  },
  audit: { id: "audit", title: "Audit log", description: "Who did what, and when. Append-only.", icon: AuditIcon, feature: "audit_log", component: AuditSection },
  usage: {
    id: "usage",
    title: "Usage controls",
    description: "Budgets per person and role, request and model caps, rate limits, alerts and chargeback reports.",
    icon: UsageIcon,
    feature: "usage_advanced",
    component: UsageControls
  }
};

/** The admin sections for the Settings nav (none without org.settings); Enterprise ones carry a note when unlicensed. */
export function adminNavItems(session: Pick<AppSession, "can" | "hasFeature">): ScreenNavItem[] {
  if (!session.can("org.settings")) return [];
  return ADMIN_SECTIONS.map((id) => {
    const item = ADMIN_SECTION_DEFINITIONS[id];
    const Icon = item.icon;
    return {
      id,
      label: item.title,
      href: paths.admin(id),
      icon: <Icon size={18} />,
      ...(!item.feature || session.hasFeature(item.feature) ? {} : { note: "Enterprise" })
    };
  });
}

const PHONE_QUERY = "(max-width: 760px)";
/** Organization admin (/admin/<section>). Enterprise sections arrive later. */
export function AdminScreen({ section }: { section: AdminSection | null }) {
  const router = useRouter();
  const session = useAppSession();
  const allowed = session.can("org.settings");

  useEffect(() => {
    if (section || !allowed) return;
    if (!window.matchMedia(PHONE_QUERY).matches) router.replace(paths.admin(ADMIN_SECTIONS[0]));
  }, [section, allowed, router]);

  const definition = section ? ADMIN_SECTION_DEFINITIONS[section] : undefined;
  // Admin lives inside Settings: one nav, with the admin sections under an "Admin" heading.
  const nav = settingsNav(session.can, adminNavItems(session));

  return (
    <ScreenFrame
      className="adminScreen"
      navLabel="Settings"
      nav={nav}
      current={section ? adminNavId(section) : undefined}
      atIndex={!section}
      title={(allowed && definition?.title) || "Admin"}
      subtitle={allowed ? definition?.description : undefined}
      back={{ href: paths.settings(), label: "All settings" }}
    >
      {!allowed ? (
        <ScreenNotice icon={<AdminIcon size={22} />} title="Admin is for organization owners and admins">
          <p>Ask an owner of your organization if you need access.</p>
        </ScreenNotice>
      ) : !definition ? null : definition.component && (!definition.feature || session.hasFeature(definition.feature)) ? (
        <definition.component />
      ) : !definition.feature || session.hasFeature(definition.feature) ? (
        <ScreenNotice icon={<definition.icon size={22} />} title={`${definition.title} is on the way`}>
          <p>
            {definition.feature
              ? "Your licence includes this section. It arrives in a coming update."
              : "This section arrives in a coming update."}
          </p>
        </ScreenNotice>
      ) : (
        <ScreenNotice
          icon={<definition.icon size={22} />}
          title={`Available with ${ENTERPRISE.name}`}
          action={
            <span className="noticeActions">
              <a className="ghostBtn" href={ENTERPRISE.url} target="_blank" rel="noreferrer">
                {ENTERPRISE.contactLabel}
              </a>
              {session.can("org.settings") ? (
                <Link className="ghostBtn" href={paths.settings("licence")}>
                  Add a licence key
                </Link>
              ) : null}
            </span>
          }
        >
          <p>
            {definition.description} This is an enterprise control from {ENTERPRISE.name} by {ENTERPRISE.by}; a licence key turns it on.
          </p>
        </ScreenNotice>
      )}
    </ScreenFrame>
  );
}
