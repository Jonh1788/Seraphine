import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, className = "", ...rest },
  ref,
) {
  return (
    <label className="flex flex-col gap-1.5">
      {label ? <span className="text-sm text-ink-dim">{label}</span> : null}
      <input
        {...rest}
        ref={ref}
        className={[
          "rounded-md border border-white/10 bg-bg-elevated/60 px-3 py-2 text-ink-primary placeholder:text-ink-faint",
          "focus:border-accent-purple focus:outline-none",
          className,
        ].join(" ")}
      />
    </label>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className = "", ...rest },
  ref,
) {
  return (
    <label className="flex flex-col gap-1.5">
      {label ? <span className="text-sm text-ink-dim">{label}</span> : null}
      <textarea
        {...rest}
        ref={ref}
        className={[
          "rounded-md border border-white/10 bg-bg-elevated/60 px-3 py-2 text-ink-primary placeholder:text-ink-faint resize-none",
          "focus:border-accent-purple focus:outline-none",
          className,
        ].join(" ")}
      />
    </label>
  );
});
