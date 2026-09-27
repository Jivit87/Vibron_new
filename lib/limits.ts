/**
 * Shared numeric limits that both the browser and server import.
 *
 * Kept in its own tiny module (no server-only imports) so client bundles
 * (SettingsPage, the store) can pull it in without dragging in anything
 * that only runs on the server.
 */

/** Ceiling for "Parallel specialists": how many steps of a plan's wave the
 * orchestrator is allowed to run at once. Higher finishes sooner but leans
 * harder on provider rate limits and, for CLI-backed models, local RAM
 * (each specialist is a separate process). */
export const MAX_CONCURRENCY = 10;

/** Floor — always at least one specialist running. */
export const MIN_CONCURRENCY = 1;

/** Used when a request omits `concurrency` or sends something unusable. */
export const DEFAULT_CONCURRENCY = 3;
