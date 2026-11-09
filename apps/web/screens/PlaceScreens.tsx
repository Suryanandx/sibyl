"use client";

import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionsListener } from "../components/ConnectionsPanel";
import { Inbox, countByRoutine } from "../components/Inbox";
import { RoutinesPanel } from "../components/RoutinesPanel";
import { ScreenFrame } from "../components/ScreenFrame";
import { EmptyState } from "../components/ui";
import { useAppSession } from "../lib/app-session";
import { useGateway } from "../lib/gateway";
import {
  MONITOR_EVENTS,
  NOTIFICATION_EVENTS,
  isConnectionsServerMessage,
  INTEGRATIONS_EVENTS,
  type IntegrationsServerMessage,
  type IntegrationsClientMessage,
  type MonitorEventView,
  type MonitorStatusView
} from "@open-gpt-live/protocol";
import { AgentsScreen as AgentsFeature } from "../features/agents";
import { IntegrationsScreen as IntegrationsFeature } from "../features/integrations";
import { KnowledgeScreen as KnowledgeFeature } from "../features/knowledge";
import { MonitorsScreen as MonitorsFeature, createMonitorsApi } from "../features/monitors";
import { PluginsScreen as PluginsFeature } from "../features/plugins";
import { SkillsScreen as SkillsFeature } from "../features/skills";
import { SlidesScreen as SlidesFeature } from "../features/slides";
import { paths } from "../lib/routes";

/** Shown when the gateway isn't reachable yet. */
function OfflineHint() {
  const { connected, status } = useGateway();
  if (connected) return null;
  return (
    <p className="screenOffline" role="status">
      {status === "connecting" || status === "reconnecting" ? "Connecting to Sibyl…" : "Sibyl is offline. Changes are paused until it reconnects."}
    </p>
  );
}

function NoAccess({ what }: { what: string }) {
  return (
    <EmptyState title={`You don't have access to ${what}`}>
      <p>Ask a workspace owner or admin if you need it.</p>
    </EmptyState>
  );
}

export function RoutinesScreen() {
  const router = useRouter();
  const { routines, connected } = useGateway();
  const session = useAppSession();
  const allowed = session.can("routines.use") || session.can("routines.manage");
  return (
    <ScreenFrame
      title="Routines"
      subtitle={
        <>
          Tasks Sibyl runs on a schedule, on its own. Create one by asking in chat, e.g. &ldquo;Every weekday at 8, send me
          a summary of tech news.&rdquo;
        </>
      }
    >
      <OfflineHint />
      {allowed ? (
        <RoutinesPanel
          routines={routines.routines}
          connected={connected}
          waiting={countByRoutine(routines.inbox)}
          onUpdate={routines.updateRoutine}
          onRunNow={routines.runNow}
          onDelete={routines.deleteRoutine}
          onOpenConversation={(id) => router.push(paths.conversation(id))}
          onOpenInbox={() => router.push(paths.inbox)}
        />
      ) : (
        <NoAccess what="routines" />
      )}
    </ScreenFrame>
  );
}

export function InboxScreen() {
  const router = useRouter();
  const { routines, notifications, connected } = useGateway();
  return (
    <ScreenFrame
      title="Inbox"
      subtitle="Actions waiting for your approval (nothing happens until you approve), and everything routines, monitors and agents did for you."
    >
      <OfflineHint />
      <Inbox
        items={routines.inbox}
        routines={routines.routines}
        submitting={routines.submitting}
        connected={connected}
        notifications={notifications}
        onDecide={routines.decide}
        onOpenConversation={(id) => router.push(paths.conversation(id))}
        onOpenRoutines={() => router.push(paths.routines)}
        onOpen={(href) => router.push(href)}
      />
    </ScreenFrame>
  );
}

export function IntegrationsScreen() {
  const gateway = useGateway();
  const session = useAppSession();
  const allowed = session.can("integrations.use") || session.can("mcp.manage");
  const subscribeMcp = useCallback(
    (listener: ConnectionsListener) =>
      gateway.subscribe((message) => {
        if (isConnectionsServerMessage(message)) listener(message);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway.subscribe]
  );
  const live = useMemo(
    () => ({
      connected: gateway.connected,
      send: (message: IntegrationsClientMessage) => gateway.send(message),
      subscribe: (listener: (message: IntegrationsServerMessage) => void) =>
        gateway.subscribe((message) => {
          if (message.type === INTEGRATIONS_EVENTS.STATE) listener(message);
        })
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway.connected, gateway.send, gateway.subscribe]
  );
  return (
    <ScreenFrame
      title="Integrations"
      subtitle="Connect Google, Microsoft, Slack and business apps. Sibyl and your agents can then read and act in them, with your approval for anything that changes data."
    >
      <OfflineHint />
      {allowed ? (
        <IntegrationsFeature
          live={live}
          {...(session.can("mcp.manage")
            ? { mcp: { connected: gateway.connected, send: gateway.send, subscribe: subscribeMcp } }
            : {})}
        />
      ) : (
        <NoAccess what="integrations" />
      )}
    </ScreenFrame>
  );
}

/* Screens in a rail group with tabs (Spaces, Library, Automations) get them
   from ScreenFrame (components/PlaceTabs, defined in lib/nav.ts). */

export function AgentsScreen() {
  const router = useRouter();
  const { agents, catalog } = useGateway();
  const session = useAppSession();
  const allowed = session.can("agents.use") || session.can("agents.create");
  return (
    <ScreenFrame
      title="Agents"
      subtitle="Teammates you build: their own look, voice, access and way of working. They learn as they go, and you stay in control of what they can do."
    >
      <OfflineHint />
      {allowed ? (
        <AgentsFeature
          agents={agents}
          catalog={catalog}
          onChat={(agentId) => {
            agents.select(agentId);
            router.push(paths.newChat);
          }}
        />
      ) : (
        <NoAccess what="agents" />
      )}
    </ScreenFrame>
  );
}

export function KnowledgeScreen() {
  const session = useAppSession();
  return (
    <ScreenFrame
      title="Knowledge"
      subtitle="Files, web pages and notes Sibyl and your agents can search and cite. Bases marked “Searched automatically” are checked on every chat in this workspace."
    >
      <OfflineHint />
      {session.can("knowledge.view") ? <KnowledgeFeature /> : <NoAccess what="knowledge" />}
    </ScreenFrame>
  );
}

export function SkillsScreen({ tab }: { tab: "skills" | "plugins" }) {
  const session = useAppSession();
  return (
    <ScreenFrame
      title={tab === "skills" ? "Skills" : "Plugins"}
      subtitle={
        tab === "skills"
          ? "Ways of working Sibyl loads when they're relevant: how your team writes, plans and reports. Sibyl sees each skill's name and description, and loads the full instructions when a request matches."
          : "Ready-made bundles of skills, connectors and routines, installed in one step. Plugins are data only: they never run code inside Sibyl."
      }
    >
      <OfflineHint />
      {!session.can("skills.use") ? <NoAccess what={tab} /> : tab === "skills" ? <SkillsFeature /> : <PluginsFeature />}
    </ScreenFrame>
  );
}

export function SlidesScreen() {
  const session = useAppSession();
  const canManage = session.can("slides.manage");
  return (
    <ScreenFrame title="Slides" subtitle="Decks Sibyl built for you, grouped into spaces. Open one in the editor, download it, or start a new one.">
      <OfflineHint />
      {session.can("slides.use") || canManage ? (
        // useSearchParams (the open space) needs a Suspense boundary for static rendering.
        <Suspense fallback={null}>
          <SlidesFeature canManage={canManage} />
        </Suspense>
      ) : (
        <NoAccess what="slides" />
      )}
    </ScreenFrame>
  );
}

export function MonitorsScreen() {
  const router = useRouter();
  const { agents, subscribe, send, connected } = useGateway();
  const session = useAppSession();
  const [liveStatus, setLiveStatus] = useState<Record<string, MonitorStatusView>>({});
  const [liveEvents, setLiveEvents] = useState<MonitorEventView[]>([]);
  const monitorsApi = useMemo(() => createMonitorsApi(), []);
  // Ask for live status while this screen is open (and again after a reconnect).
  useEffect(() => {
    if (connected) send({ type: MONITOR_EVENTS.SUBSCRIBE });
  }, [connected, send]);
  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === MONITOR_EVENTS.STATUS) {
          const { status } = message;
          setLiveStatus((current) => ({ ...current, [status.id]: status }));
        } else if (message.type === NOTIFICATION_EVENTS.NOTIFICATION) {
          // Fired and paused events arrive as shared notifications; show the stored event they point at.
          const { kind, links } = message.notification;
          if ((kind !== "monitor_fired" && kind !== "monitor_paused") || !links.monitorId) return;
          void monitorsApi
            .events({ monitorId: links.monitorId, limit: 1 })
            .then(([event]) => {
              if (event) setLiveEvents((current) => [event, ...current.filter((e) => e.id !== event.id)].slice(0, 50));
            })
            .catch(() => undefined);
        }
      }),
    [subscribe, monitorsApi]
  );
  const allowed = session.can("monitors.use") || session.can("monitors.manage");
  return (
    <ScreenFrame
      title="Monitors"
      subtitle="Sibyl keeps an eye on your sources and tells you, or gets to work, when something you care about happens."
    >
      <OfflineHint />
      {allowed ? (
        <MonitorsFeature
          agents={agents.agents.map((agent) => ({ id: agent.id, name: agent.name }))}
          canManage={session.can("monitors.manage")}
          liveStatus={liveStatus}
          liveEvents={liveEvents}
          onOpenConversation={(id) => router.push(paths.conversation(id))}
        />
      ) : (
        <NoAccess what="monitors" />
      )}
    </ScreenFrame>
  );
}
