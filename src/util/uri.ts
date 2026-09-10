/** URI <-> path conversion, kept free of the `vscode` API. */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Absolute path -> `file://` URI string. */
export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

/** `file://` URI string -> absolute path. Throws for non-file URIs. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) {
    throw new Error(`CodePort only supports file URIs, got: ${uri}`);
  }
  return fileURLToPath(uri);
}

/** Like {@link uriToPath} but returns `undefined` instead of throwing. */
export function tryUriToPath(uri: string): string | undefined {
  try {
    return uriToPath(uri);
  } catch {
    return undefined;
  }
}
