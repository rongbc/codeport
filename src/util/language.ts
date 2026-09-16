/** Language-id normalisation, shared by the Markdown parser and the resolver. */

const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  'obj-c': 'objective-c',
  objc: 'objective-c',
  objectivec: 'objective-c',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  py3: 'python',
  golang: 'go',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
};

/**
 * Normalise a language mention (fence info string or bare id) to a CodePort
 * language id. Uses only the first word, so ```` ```c {#x} ```` yields `c`.
 */
export function normalizeLanguageId(mention: string): string | undefined {
  const word = mention.trim().split(/[\s,{]/)[0]?.trim().toLowerCase();
  if (!word) return undefined;
  return LANGUAGE_ALIASES[word] ?? word;
}

/**
 * Language families: dialects that share a grammar, a language server and a
 * symbol namespace. Used for candidate ranking, where comparing a *project*
 * language (`cpp`, the adapter's default for a build) against a *file* dialect
 * (`c`) must not look like a contradiction.
 */
const LANGUAGE_FAMILIES: Readonly<Record<string, string>> = {
  c: 'c-family',
  cpp: 'c-family',
  'objective-c': 'c-family',
  'objective-cpp': 'c-family',
  'cuda-cpp': 'c-family',
  typescript: 'javascript',
  javascript: 'javascript',
};

/** True when both mentions belong to the same language family. */
export function sameLanguageFamily(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeLanguageId(a);
  const nb = normalizeLanguageId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return LANGUAGE_FAMILIES[na] === LANGUAGE_FAMILIES[nb] && LANGUAGE_FAMILIES[na] !== undefined;
}

/**
 * True for a C-family dialect (`c`, `cpp`, `objective-c`, `cuda-cpp`).
 *
 * Used by the build signal: `compile_commands.json` is a C/C++ artifact, so only
 * a C-family candidate may be reordered by it. An assembly or Rust node that
 * happens to share the database's directory is left alone.
 */
export function isCFamilyLanguage(language: string | undefined): boolean {
  return sameLanguageFamily(language, 'c');
}
