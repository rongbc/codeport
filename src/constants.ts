/** Shared constants (kept in one place so nothing drifts). */

/** Must match `version` in package.json; sent to language servers as clientInfo. */
export const EXTENSION_VERSION = '0.1.1';

/** Name of the CodePort output channel. */
export const OUTPUT_CHANNEL_NAME = 'CodePort';

/** Directory holding the local index, relative to a workspace root. */
export const INDEX_DIR_NAME = '.codeport';

/** Index database file name inside {@link INDEX_DIR_NAME}. */
export const DB_FILE_NAME = 'index.db';

/** Legacy configuration namespace, still read for migration. */
export const LEGACY_CONFIG_SECTION = 'mdCodeLinks';

/** Current configuration namespace. */
export const CONFIG_SECTION = 'codeport';
