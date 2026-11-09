import { notFound, redirect } from "next/navigation";
import { SettingsScreen } from "../../../screens/settings/SettingsScreen";
import { SETTINGS_SECTION_TITLES, SETTINGS_SECTIONS, isSettingsSection, paths } from "../../../lib/routes";

export function generateStaticParams() {
  return SETTINGS_SECTIONS.map((section) => ({ section }));
}

export function generateMetadata({ params }: { params: { section: string } }) {
  return { title: `${isSettingsSection(params.section) ? SETTINGS_SECTION_TITLES[params.section] : "Settings"} · Settings · Sibyl` };
}

export default function SettingsSectionPage({ params }: { params: { section: string } }) {
  // US spelling from older links.
  if (params.section === "license") redirect(paths.settings("licence"));
  if (!isSettingsSection(params.section)) notFound();
  return <SettingsScreen section={params.section} />;
}
