import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vitest/config"
import baseConfig from "./vitest.config.base"

const root = path.dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@opensea/tool-sdk": path.join(root, "src/index.ts"),
      },
    },
    test: {
      include: [
        "src/__tests__/**/*.test.ts",
        "examples/svm-echo-tool/**/*.test.ts",
      ],
    },
  }),
)
