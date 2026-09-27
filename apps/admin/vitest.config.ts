import path from "node:path";

export default {
  test: {
    environment: "jsdom",
    include: ["tests/components/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      "next/navigation": path.resolve(import.meta.dirname, "app/compat/next/navigation.ts"),
      "next/link": path.resolve(import.meta.dirname, "app/compat/next/link.tsx"),
    },
  },
};
