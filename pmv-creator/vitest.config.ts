import { configDefaults, defineConfig } from "vitest/config";

// the deploy clone (.deploy) and the end-to-end scratch folder hold copies of the tests – only ours run
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".deploy/**", ".tmp-e2e/**"] } });
