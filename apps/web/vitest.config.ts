import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  }),
);
