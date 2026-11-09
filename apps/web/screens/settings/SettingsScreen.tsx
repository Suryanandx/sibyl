"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ScreenFrame, ScreenNotice } from "../../components/ScreenFrame";
import { useAppSession } from "../../lib/app-session";
import { paths, type SettingsSection } from "../../lib/routes";
import { adminNavItems } from "../admin/AdminScreen";
import { settingsNav } from "./nav";
import { SETTINGS_SECTIONS_BY_ID, visibleSettingsSections } from "./sections";

/** Phone layout: below this width /settings shows the section list. */
const PHONE_QUERY = "(max-width: 760px)";

/**
 * Settings: one section per address (/settings/<section>), with the section
 * list beside it. `section` null is /settings itself: on a phone that's the
 * list; on wider screens it opens the first section.
 */
export function SettingsScreen({ section }: { section: SettingsSection | null }) {
  const router = useRouter();
  const session = useAppSession();
  const visible = visibleSettingsSections(session.can);
  const first = visible[0]?.id;

  useEffect(() => {
    if (section || !first) return;
    if (!window.matchMedia(PHONE_QUERY).matches) router.replace(paths.settings(first));
  }, [section, first, router]);

  const nav = settingsNav(session.can, adminNavItems(session));
  const definition = section ? SETTINGS_SECTIONS_BY_ID[section] : undefined;
  const allowed = definition && (!definition.permission || session.can(definition.permission));
  const Body = definition?.component;

  return (
    <ScreenFrame
      className="settingsScreen"
      navLabel="Settings"
      nav={nav}
      current={section ?? undefined}
      atIndex={!section}
      title={definition?.title ?? "Settings"}
      subtitle={definition?.description}
      back={{ href: paths.settings(), label: "All settings" }}
    >
      {!definition ? null : allowed && Body ? (
        <Body key={section} />
      ) : (
        <ScreenNotice title="You don't have access to this section">
          <p>Ask a workspace owner or admin if you need it.</p>
        </ScreenNotice>
      )}
    </ScreenFrame>
  );
}
