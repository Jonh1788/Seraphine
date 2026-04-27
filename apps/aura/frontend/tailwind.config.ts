import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#02040c",
          surface: "#0a1228",
          elevated: "#121a36",
          s1: "#0a1228",
          s2: "#121a36",
          s3: "#1b2547",
        },
        ink: {
          primary: "#e5e7eb",
          dim: "#94a3b8",
          faint: "#64748b",
        },
        accent: {
          blue: "#4F7EFF",
          "blue-soft": "#7da0ff",
          glow: "rgba(79,126,255,0.45)",
          purple: "#4F7EFF",
          "purple-strong": "#3a66ea",
        },
        mod: {
          tasks: "#3b82f6",
          finance: "#22c55e",
          reminders: "#f97316",
          habits: "#10b981",
          chat: "#14b8a6",
        },
      },
      fontFamily: {
        display: [
          "Sora",
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
        sans: [
          "DM Sans",
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      borderRadius: {
        xl2: "22px",
        xl3: "32px",
        xl4: "46px",
      },
      boxShadow: {
        glass: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.5)",
        "glow-blue": "0 0 32px -8px rgba(79,126,255,0.45)",
        "inset-edge": "inset 0 1px 0 0 rgba(255,255,255,0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
