import path from "node:path";

/**
 * Resolves a state file. An explicit env var wins. Otherwise DATA_DIR replaces the
 * historical `data/` directory. With neither set, the path stays `data/<file>`.
 */
export function dataFile(env: NodeJS.ProcessEnv, explicit: string | undefined, fallbackRelative: string): string {
  const override = explicit?.trim();
  if (override) return path.resolve(override);
  const root = env.DATA_DIR?.trim();
  if (root) return path.resolve(root, path.basename(fallbackRelative));
  return path.resolve(fallbackRelative);
}
