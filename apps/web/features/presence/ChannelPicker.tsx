"use client";

/**
 * Pick a Slack channel, or a Teams team and channel, from the workspace's
 * shared connection. Used by an agent's Presence section and by the
 * notifications channel setting.
 */
import { useEffect, useId, useState } from "react";
import type { PresenceChannelList, PresenceChannelRef, PresenceProvider } from "@open-gpt-live/protocol";
import { Field, Muted, Select } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { fetchChannels } from "./api";
import styles from "./presence.module.css";

export function ChannelPicker({ provider, value, onChange }: { provider: PresenceProvider; value: PresenceChannelRef | undefined; onChange(value: PresenceChannelRef | undefined): void }) {
  const id = useId();
  const [list, setList] = useState<PresenceChannelList>();
  const [teamId, setTeamId] = useState<string | undefined>(value?.teamId);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    fetchChannels(provider, provider === "teams" ? teamId : undefined)
      .then((next) => {
        if (!live) return;
        setList(next);
        if (provider === "teams" && !teamId && next.teams?.[0]) setTeamId(next.teams[0].id);
      })
      .catch((err: unknown) => live && setError(errorText(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [provider, teamId]);

  if (error) return <Muted className={styles.error}>{error}</Muted>;
  const team = list?.teams?.find((t) => t.id === teamId);
  return (
    <div className={styles.pickers}>
      {provider === "teams" ? (
        <Field label="Team">
          <Select
            id={`${id}-team`}
            value={teamId ?? ""}
            onChange={(event) => {
              setTeamId(event.target.value || undefined);
              onChange(undefined);
            }}
          >
            {(list?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Channel" hint={provider === "slack" ? "Invite the app to a channel in Slack (/invite @Sibyl) before an agent answers there." : undefined}>
        <Select
          id={`${id}-channel`}
          value={value?.channelId ?? ""}
          disabled={loading}
          onChange={(event) => {
            const channel = list?.channels.find((c) => c.id === event.target.value);
            if (!channel) return onChange(undefined);
            onChange({
              channelId: channel.id,
              channelName: channel.name,
              ...(provider === "teams" && team ? { teamId: team.id, teamName: team.name } : {})
            });
          }}
        >
          <option value="">{loading ? "Loading…" : "Choose a channel"}</option>
          {(list?.channels ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {provider === "slack" ? "#" : ""}
              {c.name}
              {c.private ? " (private)" : ""}
              {provider === "slack" && c.appIsMember === false ? " — app not invited yet" : ""}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
