import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

/** A labelled form field: label, the control, then a hint or an error. */
export function Field({
  label,
  hint,
  error,
  className,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cx(styles.field, className)}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {error ? <span className={styles.fieldError}>{error}</span> : hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

type Mono = { mono?: boolean };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Mono>(function Input(
  { className, mono, ...rest },
  ref
) {
  return <input ref={ref} className={cx(styles.control, mono && styles.mono, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & Mono>(function Textarea(
  { className, mono, ...rest },
  ref
) {
  return <textarea ref={ref} className={cx(styles.control, mono && styles.mono, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx(styles.control, className)} {...rest} />;
});

/** A checkbox with its label to the right. */
export function Checkbox({
  label,
  className,
  title,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className={cx(styles.check, className)} title={title}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
