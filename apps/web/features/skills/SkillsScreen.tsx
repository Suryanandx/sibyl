"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SKILL_NAME, type SkillVersionView, type SkillView } from "@open-gpt-live/protocol";
import { useAppSession } from "../../lib/app-session";
import { errorText, gatewayDownload, gatewayRequest } from "../../lib/gateway-http";
import { relativeTime } from "../../lib/format";
import { Badge, Button, Card, Checkbox, Field, Input, ListItem, ListItems, Muted, Notice, Row, Select, Spacer, Split, SplitBack, Stack, Tabs, Textarea, Toolbar } from "../../components/ui";
import { MarkdownPreview } from "./MarkdownPreview";
import styles from "./skills.module.css";

interface Draft {
  id?: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools: string;
  scope: "workspace" | "all";
  enabled: boolean;
}

const EMPTY: Draft = {
  name: "",
  title: "",
  description: "Use when the user asks …",
  instructions: "# Steps\n\n1. …\n",
  tools: "",
  scope: "workspace",
  enabled: true
};

function toDraft(skill: SkillView): Draft {
  return {
    id: skill.id,
    name: skill.name,
    title: skill.title,
    description: skill.description,
    instructions: skill.instructions,
    tools: (skill.tools ?? []).join(", "),
    scope: skill.workspaceId ? "workspace" : "all",
    enabled: skill.enabled
  };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Skills: instruction packs the assistant loads when relevant. */
export function SkillsScreen() {
  const session = useAppSession();
  const canEdit = session.can("skills.edit");
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<SkillVersionView[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const { skills: list } = await gatewayRequest<{ skills: SkillView[] }>("/api/skills");
      setSkills(list);
      setError(null);
      return list;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setDraft(null);
    void load();
  }, [session.currentWorkspaceId, load]);

  const current = skills?.find((skill) => skill.id === selected) ?? null;
  const editable = canEdit && (!current || current.source === "user");

  useEffect(() => {
    setVersions(null);
    if (current?.source === "user") {
      gatewayRequest<{ versions: SkillVersionView[] }>(`/api/skills/${encodeURIComponent(current.id)}/versions`)
        .then((result) => setVersions(result.versions))
        .catch(() => setVersions([]));
    }
  }, [current?.id, current?.version, current?.source]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (skills ?? []).filter((skill) => !needle || `${skill.name} ${skill.title} ${skill.description}`.toLowerCase().includes(needle));
  }, [skills, filter]);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function open(skill: SkillView): void {
    setSelected(skill.id);
    setDraft(toDraft(skill));
    setPreview(skill.source !== "user" || !canEdit);
  }

  function startNew(base?: SkillView): void {
    setSelected(null);
    setPreview(false);
    setDraft(
      base
        ? { ...toDraft(base), id: undefined, name: `${base.name}-copy`.slice(0, 64), title: `${base.title} (copy)`, scope: "workspace", enabled: true }
        : { ...EMPTY }
    );
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    const tools = draft.tools.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean);
    const body = {
      name: draft.name,
      title: draft.title,
      description: draft.description,
      instructions: draft.instructions,
      tools,
      scope: draft.scope,
      enabled: draft.enabled
    };
    await run(async () => {
      const result = draft.id
        ? await gatewayRequest<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(draft.id)}`, { method: "PATCH", body })
        : await gatewayRequest<{ skill: SkillView }>("/api/skills", { method: "POST", body });
      await load();
      setSelected(result.skill.id);
      setDraft(toDraft(result.skill));
      setNotice(draft.id ? `Saved as version ${result.skill.version ?? ""}.` : "Skill created.");
    });
  }

  async function toggle(skill: SkillView): Promise<void> {
    await run(async () => {
      await gatewayRequest(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "PATCH", body: { enabled: !skill.enabled } });
      const list = await load();
      const updated = list?.find((item) => item.id === skill.id);
      if (updated && draft?.id === skill.id) setDraft(toDraft(updated));
    });
  }

  async function importFiles(files: FileList | null, folder: boolean): Promise<void> {
    if (!files?.length) return;
    await run(async () => {
      let result: { skill: SkillView; updated: boolean; skipped: string[] };
      if (folder) {
        const entries = await Promise.all(
          [...files].map(async (file) => ({
            // "my-skill/SKILL.md" (webkitRelativePath keeps the folder name).
            path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
            content: await file.text()
          }))
        );
        // Only text-like files; binaries are skipped by the gateway anyway.
        const textual = entries.filter((entry) => !/\.(png|jpe?g|gif|webp|pdf|zip|ico|woff2?)$/i.test(entry.path));
        result = await gatewayRequest("/api/skills/import", { method: "POST", body: { files: textual } });
      } else {
        const file = files[0]!;
        const zip = /\.zip$/i.test(file.name);
        result = await gatewayRequest("/api/skills/import", {
          method: "POST",
          body: file,
          contentType: zip ? "application/zip" : "text/markdown",
          headers: { "X-Filename": encodeURIComponent(file.name) }
        });
      }
      await load();
      open(result.skill);
      setNotice(
        `${result.updated ? "Updated" : "Imported"} “${result.skill.title}”.` + (result.skipped.length ? ` Skipped: ${result.skipped.join(", ")}.` : "")
      );
    });
    if (fileRef.current) fileRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
  }

  const nameValid = draft ? SKILL_NAME.test(draft.name) : false;

  return (
    <>
      {canEdit ? (
        <Toolbar
          end={
            <>
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                Import SKILL.md or zip
              </Button>
              <Button onClick={() => folderRef.current?.click()} disabled={busy}>
                Import folder
              </Button>
              <Button variant="primary" onClick={() => startNew()} disabled={busy}>
                New skill
              </Button>
              <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.zip,text/markdown,application/zip" hidden onChange={(event) => void importFiles(event.target.files, false)} />
              <input
                ref={(node) => {
                  folderRef.current = node;
                  // Folder picking (non-standard attribute, supported by all major browsers).
                  node?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                multiple
                hidden
                onChange={(event) => void importFiles(event.target.files, true)}
              />
            </>
          }
        />
      ) : null}

      <Stack>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {notice ? <Notice tone="positive">{notice}</Notice> : null}

        <Split
          open={Boolean(draft)}
          list={
            <Card aria-label="Skills">
              <Input type="search" placeholder="Filter skills" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter skills" />
              {!skills ? (
                <Muted>Loading…</Muted>
              ) : visible.length === 0 ? (
                <Muted>No skills match.</Muted>
              ) : (
                <ListItems label="Skills">
                  {visible.map((skill) => (
                    <ListItem
                      key={skill.id}
                      current={selected === skill.id}
                      onSelect={() => open(skill)}
                      title={
                        <>
                          <span className={styles.ellipsis}>{skill.title}</span>
                          {!skill.enabled ? <Badge>Off</Badge> : null}
                        </>
                      }
                      meta={
                        <>
                          {skill.name}
                          {skill.source === "builtin" ? " · built-in" : skill.source === "plugin" ? ` · from ${skill.pluginId ?? "a plugin"}` : ""}
                          {skill.workspaceId ? "" : " · all workspaces"}
                        </>
                      }
                    />
                  ))}
                </ListItems>
              )}
            </Card>
          }
          detail={
            <Card aria-label="Skill">
              {!draft ? (
                <Muted>Choose a skill, or create a new one.</Muted>
              ) : (
                <form className={styles.editor} onSubmit={(event) => void save(event)}>
                  <Row>
                    <SplitBack label="Skills" onClick={() => setDraft(null)} />
                    {current ? (
                      <Badge tone="outline">{current.source === "builtin" ? "Built-in" : current.source === "plugin" ? `Plugin · ${current.pluginId}` : "Your skill"}</Badge>
                    ) : null}
                    {current?.version ? <Muted as="span">v{current.version}</Muted> : null}
                    <Spacer />
                    {current ? (
                      <>
                        <Checkbox label="On" checked={current.enabled} disabled={!canEdit || busy} onChange={() => void toggle(current)} />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void run(() => gatewayDownload(`/api/skills/${encodeURIComponent(current.id)}/export`, `${current.name}.md`))}
                        >
                          Export
                        </Button>
                        {canEdit && current.source !== "user" ? (
                          <Button variant="ghost" size="sm" onClick={() => startNew(current)}>
                            Duplicate
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </Row>

                  <div className={styles.grid2}>
                    <Field label="Title">
                      <Input
                        value={draft.title}
                        maxLength={120}
                        disabled={!editable}
                        required
                        onChange={(event) => {
                          const title = event.target.value;
                          setDraft({ ...draft, title, ...(draft.id ? {} : { name: slug(title) }) });
                        }}
                      />
                    </Field>
                    <Field label="Name" hint="Used by the assistant." error={!nameValid && draft.name ? "Lowercase letters, digits and dashes." : undefined}>
                      <Input
                        value={draft.name}
                        maxLength={64}
                        disabled={!editable}
                        required
                        aria-invalid={!nameValid}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value.toLowerCase() })}
                      />
                    </Field>
                  </div>
                  <Field label="When to use it" hint="One line, shown to the assistant.">
                    <Input value={draft.description} maxLength={400} disabled={!editable} required onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                  </Field>

                  <Row>
                    <span className={styles.label}>Instructions</span>
                    <Spacer />
                    {editable ? (
                      <Tabs
                        label="Instructions view"
                        options={[
                          { value: "write", label: "Write" },
                          { value: "preview", label: "Preview" }
                        ]}
                        value={preview ? "preview" : "write"}
                        onChange={(value) => setPreview(value === "preview")}
                      />
                    ) : null}
                  </Row>
                  {preview || !editable ? (
                    <MarkdownPreview source={draft.instructions} />
                  ) : (
                    <Textarea
                      mono
                      className={styles.instructions}
                      value={draft.instructions}
                      maxLength={40_000}
                      required
                      onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                      aria-label="Instructions (Markdown)"
                    />
                  )}

                  {current?.files?.length ? <Muted>Bundled files: {current.files.map((file) => file.name).join(", ")}</Muted> : null}

                  <div className={styles.grid2}>
                    <Field label="Tools it expects" hint="Optional, comma-separated.">
                      <Input value={draft.tools} disabled={!editable} placeholder="web_search, read_webpage" onChange={(event) => setDraft({ ...draft, tools: event.target.value })} />
                    </Field>
                    <Field label="Available in">
                      <Select value={draft.scope} disabled={!editable} onChange={(event) => setDraft({ ...draft, scope: event.target.value as Draft["scope"] })}>
                        <option value="workspace">This workspace</option>
                        <option value="all">All workspaces</option>
                      </Select>
                    </Field>
                  </div>

                  {editable ? (
                    <Row>
                      <Button type="submit" variant="primary" disabled={busy || !nameValid}>
                        {draft.id ? "Save new version" : "Create skill"}
                      </Button>
                      {draft.id ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              if (!window.confirm(`Delete the skill “${draft.title}”?`)) return;
                              await gatewayRequest(`/api/skills/${encodeURIComponent(draft.id!)}`, { method: "DELETE" });
                              setDraft(null);
                              setSelected(null);
                              await load();
                            })
                          }
                        >
                          Delete
                        </Button>
                      ) : null}
                    </Row>
                  ) : current?.source !== "user" ? (
                    <Muted>
                      {current?.source === "plugin"
                        ? "Managed by its plugin — switch it on or off here."
                        : "Built-in skills can be switched off or duplicated to make your own version."}
                    </Muted>
                  ) : null}

                  {versions && versions.length > 0 && editable ? (
                    <Stack gap={6}>
                      <span className={styles.label}>Earlier versions</span>
                      {versions.map((version) => (
                        <Row key={`${version.version}-${version.savedAt}`}>
                          <Muted as="span">
                            v{version.version} · {relativeTime(version.savedAt)}
                          </Muted>
                          <Button
                            variant="link"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const { skill } = await gatewayRequest<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(current!.id)}/restore`, {
                                  method: "POST",
                                  body: { version: version.version }
                                });
                                await load();
                                setDraft(toDraft(skill));
                                setNotice(`Restored v${version.version} as v${skill.version}.`);
                              })
                            }
                          >
                            Restore
                          </Button>
                        </Row>
                      ))}
                    </Stack>
                  ) : null}
                </form>
              )}
            </Card>
          }
        />
      </Stack>
    </>
  );
}
