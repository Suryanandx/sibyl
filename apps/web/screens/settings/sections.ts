import type { ComponentType } from "react";
import LicenseSection from "../../components/settings/LicenseSection";
import MembersSection from "../../components/settings/MembersSection";
import WorkspaceSection from "../../components/settings/WorkspaceSection";
import { ShieldIcon, TwoStepSection } from "../../features/admin-identity";
import type { SettingsSection } from "../../lib/routes";
import {
  DiagnosticsSection,
  MemorySection,
  ModelsSection,
  SecretsSection,
  UsageSection,
  VoiceSection
} from "./GatewaySections";
import {
  DiagnosticsIcon,
  LicenceIcon,
  MembersIcon,
  MemoryIcon,
  ModelsIcon,
  SecretsIcon,
  UsageIcon,
  VoiceIcon,
  WorkspaceIcon,
  type SectionIcon
} from "./icons";

export interface SettingsSectionDefinition {
  id: SettingsSection;
  title: string;
  /** One line under the title. */
  description: string;
  icon: SectionIcon;
  /** The section body (no frame: the settings screen provides it). */
  component: ComponentType;
  /** Needed to see the section (`useAppSession().can`); none: everyone. */
  permission?: string;
}

/** Settings sections in nav order: /settings/<id>. */
export const SETTINGS_SECTION_LIST: SettingsSectionDefinition[] = [
  {
    id: "workspace",
    title: "Workspace",
    description: "Name, icon and defaults for this workspace.",
    icon: WorkspaceIcon,
    component: WorkspaceSection,
    permission: "workspace.settings"
  },
  {
    id: "members",
    title: "Members",
    description: "Who is in this workspace and what they can do.",
    icon: MembersIcon,
    component: MembersSection,
    // Everyone in a workspace may see who else is in it; inviting and
    // changing roles are checked inside the section (members.invite/manage).
    permission: "chat.use"
  },
  {
    id: "security",
    title: "Sign-in security",
    description: "Two-step verification for your account.",
    icon: ShieldIcon,
    component: TwoStepSection
  },
  {
    id: "models",
    title: "Models",
    description: "Presets and the models Sibyl uses to talk, think and transcribe.",
    icon: ModelsIcon,
    component: ModelsSection,
    permission: "models.choose"
  },
  {
    id: "voice",
    title: "Voice",
    description: "How Sibyl speaks, and whether answers come with visuals.",
    icon: VoiceIcon,
    component: VoiceSection
  },
  {
    id: "memory",
    title: "Memory",
    description: "What Sibyl remembers across chats. Fully under your control.",
    icon: MemoryIcon,
    component: MemorySection
  },
  {
    id: "usage",
    title: "Usage",
    description: "Spend this session and against your budgets.",
    icon: UsageIcon,
    component: UsageSection,
    permission: "usage.view"
  },
  {
    id: "secrets",
    title: "Secrets",
    description:
      "API keys for the services Sibyl connects to. Encrypted on your server, sent only to the hosts you allow, and never shown to the assistant — or here.",
    icon: SecretsIcon,
    component: SecretsSection,
    permission: "secrets.manage"
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    description: "Voice latency, the voice activity detector and the gateway connection.",
    icon: DiagnosticsIcon,
    component: DiagnosticsSection
  },
  {
    id: "licence",
    title: "Licence",
    description: "Your Sibyl edition and licence key.",
    icon: LicenceIcon,
    component: LicenseSection,
    permission: "org.settings"
  }
];

export const SETTINGS_SECTIONS_BY_ID = Object.fromEntries(
  SETTINGS_SECTION_LIST.map((section) => [section.id, section])
) as Record<SettingsSection, SettingsSectionDefinition>;

/** Sections the user may open, in order. */
export function visibleSettingsSections(can: (permission: string) => boolean): SettingsSectionDefinition[] {
  return SETTINGS_SECTION_LIST.filter((section) => !section.permission || can(section.permission));
}
