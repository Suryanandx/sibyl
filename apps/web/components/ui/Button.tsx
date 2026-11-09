import Link from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";

export interface ButtonLook {
  /** primary: graphite pill (one per view); secondary: outlined; ghost: quiet; danger: destructive; link: inline text. */
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Square button holding only an icon (give it an aria-label). */
  iconOnly?: boolean;
}

/** Class names for something that should look like a button (e.g. a link). */
export function buttonClass({ variant = "secondary", size = "md", iconOnly = false }: ButtonLook = {}, extra?: string): string {
  return cx(
    styles.btn,
    variant !== "secondary" && styles[variant],
    size === "sm" && styles.sm,
    iconOnly && styles.iconOnly,
    extra
  );
}

export type ButtonProps = ButtonLook & ButtonHTMLAttributes<HTMLButtonElement>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, iconOnly, className, type = "button", ...rest },
  ref
) {
  return <button ref={ref} type={type} className={buttonClass({ variant, size, iconOnly }, className)} {...rest} />;
});

/**
 * A link that looks like a button. App routes use next/link; `outside` marks
 * a page this app doesn't render (e.g. the slides editor under /slides).
 */
export function ButtonLink({
  href,
  outside = false,
  variant,
  size,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; outside?: boolean; children?: ReactNode }) {
  const classes = buttonClass({ variant, size, iconOnly }, className);
  if (!outside && href.startsWith("/") && !href.startsWith("//") && !rest.target) {
    return (
      <Link href={href} className={classes} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} {...rest}>
      {children}
    </a>
  );
}
