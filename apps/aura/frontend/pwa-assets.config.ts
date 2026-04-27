import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: {
    ...minimal2023Preset,
    maskable: {
      ...minimal2023Preset.maskable,
      resizeOptions: { background: "#02040c", fit: "contain" },
    },
    apple: {
      ...minimal2023Preset.apple,
      resizeOptions: { background: "#02040c", fit: "contain" },
    },
    transparent: {
      ...minimal2023Preset.transparent,
      sizes: [64, 192, 512],
      favicons: [[48, "favicon.ico"]],
    },
  },
  images: ["public/aura-source.svg"],
});
