import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "supabase/.temp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["shared/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["next", "next/*", "bullmq", "bullmq/*", "ioredis"],
          message: "shared cannot import next, bullmq, or ioredis",
        }],
      }],
    },
  },
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@reach/worker", "@reach/worker/*", "bullmq", "bullmq/*", "ioredis"],
          message: "the web app cannot import the worker or Redis",
        }],
      }],
    },
  },
);
