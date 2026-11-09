"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";
import { useAppSession, type WorkspaceSummary } from "../lib/app-session";
import { paths } from "../lib/routes";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function WorkspaceTile({ workspace }: { workspace?: WorkspaceSummary }) {
  return (
    <span className="wsTile" aria-hidden>
      {workspace?.icon ?? initials(workspace?.name ?? "?")}
    </span>
  );
}

/**
 * Which workspace is open, at the top of the rail. Everything shown is scoped
 * to it. A quiet "Personal ▾" button at the top of the chat sidebar; with one
 * workspace and no way to create another it isn't shown at all.
 */
export function WorkspaceSwitcher() {
  const session = useAppSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = session.currentWorkspace;
  const canSettings = session.can("workspace.settings");
  const canCreate = session.can("org.settings");

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const go = (href: string) => {
    close(false);
    router.push(href);
  };

  if (session.workspaces.length <= 1 && !canCreate) return null;

  return (
    <div className="wsSwitcher">
      <button
        ref={buttonRef}
        type="button"
        className="wsButton"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Workspace: ${current?.name ?? "none"}`}
        title={session.orgName ? `${session.orgName}: switch workspace` : "Switch workspace"}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="wsName">{current?.name ?? "Workspace"}</span>
        <Icon name="chevronDown" size={14} className="wsChevron" />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="wsMenu" role="menu" aria-label="Workspaces" onKeyDown={onMenuKey}>
          <p className="wsMenuLabel">{session.orgName ? `${session.orgName} · workspaces` : "Workspaces"}</p>
          {session.workspaces.map((workspace) => {
            const isCurrent = workspace.id === session.currentWorkspaceId;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                className={`wsMenuItem${isCurrent ? " current" : ""}`}
                tabIndex={-1}
                onClick={() => {
                  if (!isCurrent) session.switchWorkspace(workspace.id);
                  close();
                }}
              >
                <WorkspaceTile workspace={workspace} />
                <span className="wsMenuName">{workspace.name}</span>
                <span className="wsMenuRole">{workspace.role}</span>
                {isCurrent ? <Icon name="check" size={15} className="wsMenuCheck" /> : null}
              </button>
            );
          })}
          {canSettings || canCreate ? <span className="wsMenuSep" role="separator" /> : null}
          {canSettings ? (
            <button type="button" role="menuitem" className="wsMenuItem" tabIndex={-1} onClick={() => go(paths.settings("workspace"))}>
              <Icon name="sliders" size={16} />
              <span className="wsMenuName">Workspace settings</span>
            </button>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              role="menuitem"
              className="wsMenuItem"
              tabIndex={-1}
              onClick={() => go(`${paths.settings("workspace")}?new=1`)}
            >
              <Icon name="plus" size={16} />
              <span className="wsMenuName">New workspace</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
