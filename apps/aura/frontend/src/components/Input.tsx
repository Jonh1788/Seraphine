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
          "rounded-lg border border-white/10 bg-bg-s2/60 px-3.5 py-2.5 min-h-11 text-ink-primary placeholder:text-ink-faint",
          "focus:border-accent-blue focus:outline-none focus:shadow-glow-blue/30",
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
          "rounded-lg border border-white/10 bg-bg-s2/60 px-3.5 py-2.5 text-ink-primary placeholder:text-ink-faint resize-none",
          "focus:border-accent-blue focus:outline-none",
          className,
        ].join(" ")}
      />
    </label>
  );
});
