/**
 * Confidence scoring (plan sections 12-13).
 *
 * The weights keep the shape the plan describes — the name match dominates, then
 * an explicit qualifier, the language, the symbol kind, and finally uniqueness —
 * but they are normalised so a fully corroborated exact hit reaches exactly 1.0.
 * That matters because a policy decides "answer from the index or pay for the
 * language server" by comparing this number against a threshold.
 *
 * A plain `` `nx_start` `` mention therefore scores 0.70 and is confirmed by the
 * language server, while `` `nx_start()` `` inside a ```` ```c ```` block scores
 * 0.85 and is served straight from the index: the call parentheses and the fence
 * language are real evidence, and CodePort uses them.
 */

import type { SymbolKind } from '../types.ts';
import { sameLanguageFamily } from '../util/language.ts';

export const INDEX_WEIGHTS = {
  /** The name matches the query exactly. */
  exactName: 0.5,
  /** Only a prefix matched — usable, but not proof. */
  prefixName: 0.2,
  /** The indexed qualifier agrees with the mention's `namespace::` prefix. */
  qualifiedName: 0.15,
  /** The mention's language family agrees with the defining file's language. */
  language: 0.1,
  /** The mention's shape (`name(...)`, `SOME_MACRO`) agrees with the kind. */
  kind: 0.15,
  /** Exactly one candidate exists in the whole workspace. */
  unique: 0.1,
  /** The qualifier actively contradicts the mention's prefix. */
  qualifierPenalty: 0.2,
  /** The language contradicts the mention's fence. */
  languagePenalty: 0.1,
} as const;

export interface IndexScoreInput {
  readonly matchType: 'exact' | 'prefix';
  readonly queryName: string;
  readonly queryContainer?: string;
  readonly queryLanguage?: string;
  readonly queryKindHint?: SymbolKind;
  /** How many candidates the index returned for this query. */
  readonly resultCount: number;
  readonly hit: {
    readonly name: string;
    readonly qualifiedName?: string;
    readonly kind?: SymbolKind;
    readonly container?: string;
    readonly language?: string;
  };
}

export interface Score {
  readonly score: number;
  readonly reasons: string[];
}

/**
 * Score one index candidate. Reasons are recorded because they make the
 * behaviour debuggable: the log and the hover explain every jump.
 */
export function scoreIndexHit(input: IndexScoreInput): Score {
  const reasons: string[] = [];
  let score = 0;

  if (input.matchType === 'exact' && input.hit.name === input.queryName) {
    score += INDEX_WEIGHTS.exactName;
    reasons.push('exact name');
  } else {
    score += INDEX_WEIGHTS.prefixName;
    reasons.push('name prefix');
  }

  if (input.queryContainer) {
    if (input.hit.container && containerAgrees(input.hit.container, input.queryContainer)) {
      score += INDEX_WEIGHTS.qualifiedName;
      reasons.push(`qualifier ${input.hit.container}`);
    } else if (input.hit.container) {
      score -= INDEX_WEIGHTS.qualifierPenalty;
      reasons.push(`qualifier mismatch (${input.hit.container})`);
    }
  }

  if (input.queryLanguage && input.hit.language) {
    // Family granularity: a `cpp` project and a `.c` file are not a mismatch.
    if (sameLanguageFamily(input.queryLanguage, input.hit.language)) {
      score += INDEX_WEIGHTS.language;
      reasons.push(`language ${input.hit.language}`);
    } else {
      score -= INDEX_WEIGHTS.languagePenalty;
      reasons.push(`language mismatch (${input.hit.language})`);
    }
  }

  if (input.queryKindHint && input.hit.kind) {
    if (kindsCompatible(input.queryKindHint, input.hit.kind)) {
      score += INDEX_WEIGHTS.kind;
      reasons.push(`kind ${input.hit.kind}`);
    } else {
      reasons.push(`kind differs (${input.hit.kind})`);
    }
  }

  if (input.resultCount === 1) {
    score += INDEX_WEIGHTS.unique;
    reasons.push('unique result');
  } else {
    reasons.push(`${input.resultCount} candidates`);
  }

  return { score: clamp01(score), reasons };
}

/** Confidence for a hit that came from a language server's workspace symbols. */
export const LSP_WEIGHTS = {
  exactName: 0.92,
  qualifiedName: 0.95,
  fuzzyName: 0.6,
  /** `textDocument/definition` is semantic truth. */
  definition: 0.98,
  /** `textDocument/references` is likewise authoritative. */
  reference: 0.92,
} as const;

export function lspSymbolConfidence(
  match: 'exact' | 'qualified' | 'fuzzy',
  options: { readonly resultCount: number } = { resultCount: 1 }
): Score {
  const reasons: string[] = [];
  let score: number;
  switch (match) {
    case 'qualified':
      score = LSP_WEIGHTS.qualifiedName;
      reasons.push('language server: qualified match');
      break;
    case 'exact':
      score = LSP_WEIGHTS.exactName;
      reasons.push('language server: exact match');
      break;
    default:
      score = LSP_WEIGHTS.fuzzyName;
      reasons.push('language server: partial match');
      break;
  }
  if (options.resultCount > 1) {
    // Multiple definitions (e.g. `static` functions with the same name) are
    // legitimate, but the individual choice is less certain.
    score -= 0.05;
    reasons.push(`${options.resultCount} definitions`);
  }
  return { score: clamp01(score), reasons };
}

/** True when an index qualifier agrees with the mention's `a::b` prefix. */
export function containerAgrees(indexContainer: string, queryContainer: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/^::/, '').replace(/\s+/g, '').replace(/^<.*>$/, '');
  const a = normalize(indexContainer);
  const b = normalize(queryContainer);
  if (!a || !b) return false;
  return a === b || a.endsWith(`::${b}`) || b.endsWith(`::${a}`);
}

/** True when a mention's shape is consistent with an indexed symbol kind. */
export function kindsCompatible(hint: SymbolKind, kind: SymbolKind): boolean {
  if (hint === kind) return true;
  switch (hint) {
    case 'function':
      // A call may land on a method, a constructor or a function-like macro.
      return kind === 'method' || kind === 'constructor' || kind === 'macro';
    case 'macro':
      return kind === 'function' || kind === 'variable' || kind === 'type';
    case 'struct':
      return kind === 'class' || kind === 'union' || kind === 'type' || kind === 'typedef';
    case 'class':
      return kind === 'struct' || kind === 'interface' || kind === 'type';
    case 'variable':
      return kind === 'field' || kind === 'enumerator';
    default:
      return false;
  }
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
