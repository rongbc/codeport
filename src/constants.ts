/** Shared constants (kept in one place so nothing drifts). */

/** Name of the CodePort output channel. */
export const OUTPUT_CHANNEL_NAME = 'CodePort';

/**
 * Directory holding a CodeGraph index, relative to a project root.
 *
 * CodePort no longer owns this directory — CodeGraph does — but the name is
 * needed to find a graph by walking up from a file.
 */
export const GRAPH_DIR_NAME = '.codegraph';

/** Current configuration namespace. */
export const CONFIG_SECTION = 'codeport';
