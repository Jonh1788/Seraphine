import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#06091A",
          surface: "#0C1228",
          elevated: "#111B38",
          s1: "#0C1228",
          s2: "#111B38",
          s3: "#162040",
          s4: "#1E2C50",
        },
        ink: {
          primary: "#EEF2FF",
          dim: "#8B9CC8",
          faint: "#4D5E8A",
        },
        accent: {
          blue: "#4F7EFF",
          "blue-soft": "#7DA4FF",
          "blue-dim": "rgba(79,126,255,0.15)",
          glow: "rgba(79,126,255,0.45)",
          purple: "#4F7EFF",
          "purple-strong": "#3a66ea",
        },
        aura: {
          red: "#FF5B72",
          "red-dim": "rgba(255,91,114,0.12)",
          green: "#2DD4BF",
          "green-dim": "rgba(45,212,191,0.12)",
          amber: "#F5A623",
          "amber-dim": "rgba(245,166,35,0.15)",
          purple: "#A78BFA",
          pink: "#F472B6",
          border: "rgba(99,130,255,0.10)",
          border2: "rgba(99,130,255,0.18)",
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
