import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  /** Render an inline blinking caret at the end — used while streaming. */
  streaming?: boolean;
}

/**
 * Markdown renderer for assistant chat bubbles.
 *
 * Tailwind classes are applied directly to each block element; we
 * deliberately don't pull in @tailwindcss/typography to keep bundle
 * size + opinionated styling small. The look matches the dark Aura
 * palette (cyan accents for code, purple for links).
 */
export function Markdown({ text, streaming = false }: Props) {
  return (
    <div className="text-ink-primary text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-purple underline underline-offset-2 hover:text-accent-purple-strong"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-ink-primary">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 marker:text-ink-faint">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 marker:text-ink-faint">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => (
            <h1 className="mt-4 mb-2 text-xl font-bold text-ink-primary">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-4 mb-2 text-lg font-semibold text-ink-primary">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1.5 text-base font-semibold text-ink-primary">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-accent-purple/40 pl-3 italic text-ink-dim">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-white/10" />,
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[0.9em] text-cyan-300 font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className ?? ""} font-mono text-[13px]`} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-lg bg-black/40 border border-white/5 p-3 text-[13px] text-ink-primary">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/[0.04]">{children}</thead>,
          th: ({ children }) => (
            <th className="text-left font-semibold text-ink-primary px-3 py-2 border-b border-white/10">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-t border-white/5 text-ink-primary">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-block w-[2px] h-[1em] align-[-2px] ml-0.5 bg-accent-purple animate-pulse" />
      )}
    </div>
  );
}
