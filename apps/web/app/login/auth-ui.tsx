"use client";

/**
 * Shared pieces of the sign-in screens (/setup, /login, /invite/<token>):
 * a centered card with the Sibyl mark, labelled fields and an error line.
 */
import type { ReactNode } from "react";
import { SilverMark } from "../../components/Brand";

export function AuthCard({ title, lead, children }: { title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <main className="identPage">
      <section className="identCard" aria-labelledby="ident-title">
        <SilverMark size={56} />
        <h1 id="ident-title" className="identTitle">
          {title}
        </h1>
        {lead ? <p className="identLead">{lead}</p> : null}
        {children}
      </section>
    </main>
  );
}

export function AuthField(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  hint?: string;
  invalid?: boolean;
}) {
  return (
    <label className="identField">
      <span className="identLabel">{props.label}</span>
      <input
        className="identInput"
        type={props.type ?? "text"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
      />
      {props.hint ? <span className="identHint">{props.hint}</span> : null}
    </label>
  );
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="identError" role="alert">
      {message}
    </p>
  );
}

/** Where to go after signing in: a same-site path from ?next=, else home. */
export function nextPath(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
