import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0a0e1a",
          surface: "#0f1525",
          elevated: "#141a2c",
        },
        ink: {
          primary: "#e5e7eb",
          dim: "#94a3b8",
          faint: "#64748b",
        },
        accent: {
          purple: "#a78bfa",
          "purple-strong": "#8b5cf6",
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
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        glass: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.5)",
      },
    },
  },
  plugins: [],
};

export default config;
