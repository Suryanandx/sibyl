"use client";

import { Icon, type IconName } from "../../components/Icon";
import { KeyIcon } from "../../components/SecretPrompt";

/** Small 24×24 line icons for the settings and admin sections. */
function Line({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export type SectionIcon = (props: { size?: number }) => JSX.Element;

const named = (name: IconName): SectionIcon =>
  function NamedIcon({ size = 18 }: { size?: number }) {
    return <Icon name={name} size={size} />;
  };

export const WorkspaceIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M4.5 20.5v-14l7-3 7 3v14 M3 20.5h18 M9 9.5h1.5 M13.5 9.5H15 M9 13h1.5 M13.5 13H15 M10.5 20.5v-3.5h3v3.5" />
);
export const MembersIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M3 20a6 6 0 0 1 12 0 M16 4.3a3.5 3.5 0 0 1 0 6.4 M17.5 14.2A6 6 0 0 1 21 20" />
);
export const ModelsIcon: SectionIcon = named("layers");
export const VoiceIcon: SectionIcon = named("mic");
export const MemoryIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-3.8-6 3.8v-16a1 1 0 0 1 1-1Z" />
);
export const UsageIcon: SectionIcon = named("activity");
export const SecretsIcon: SectionIcon = ({ size }) => <KeyIcon size={size} />;
export const DiagnosticsIcon: SectionIcon = named("code");
export const LicenceIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M12 3.5l2.3 1.7 2.8-.2.9 2.7 2.3 1.6-.9 2.7.9 2.7-2.3 1.6-.9 2.7-2.8-.2L12 20.5l-2.3-1.7-2.8.2-.9-2.7-2.3-1.6.9-2.7-.9-2.7L6 7.7l.9-2.7 2.8.2Z M9 12l2 2 4-4" />
);
export const OrgIcon: SectionIcon = WorkspaceIcon;
export const UsersIcon: SectionIcon = MembersIcon;
export const RolesIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z M12 9v4 M12 16h.01" />
);
export const PoliciesIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M7 3.5h7l4 4v13H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z M14 3.5v4h4 M9 12h6 M9 15.5h6" />
);
export const AuditIcon: SectionIcon = named("history");
export const PhoneIcon: SectionIcon = ({ size }) => (
  <Line size={size} d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z" />
);
