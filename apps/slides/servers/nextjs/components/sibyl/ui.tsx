/**
 * Shared Sibyl components for Slides (Button, Input, Card, Dialog, Pill),
 * styled only from the Sibyl tokens in app/sibyl.css, so nothing off-brand
 * can slip into new UI. Primary = graphite pill (--ink / --ink-text), the same
 * as the chat's .darkBtn; secondary = ghost/outline pill (.ghostBtn).
 */
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

type Variant = "primary" | "secondary";
type Size = "md" | "sm";

function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return [
    variant === "primary" ? "sibylDarkBtn" : "sibylGhostBtn",
    size === "sm" ? "sibylBtnSm" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const SibylButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function SibylButton({ variant, size, className, type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />;
});

export function SibylButtonLink({
  variant,
  size,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return <a className={buttonClass(variant, size, className)} {...props} />;
}

export const SibylInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SibylInput({ className, ...props }, ref) {
    return <input ref={ref} className={`sibylInput ${className ?? ""}`} {...props} />;
  }
);

export function SibylCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`sibylCard ${className ?? ""}`} {...props} />;
}

export function SibylPill({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`sibylPill ${className ?? ""}`} {...props} />;
}

export function SibylDialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="sibylDialogBackdrop" onClick={onClose} aria-hidden />
      <div className="sibylDialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="mb-3 text-[17px] font-semibold">{title}</h2>
        <div className="text-sm text-[var(--text-2)]">{children}</div>
        {actions ? <div className="mt-5 flex justify-end gap-2">{actions}</div> : null}
      </div>
    </>
  );
}
