/**
 * Candidate ranking.
 *
 * There is deliberately **no numeric confidence** any more. The old 0..1 score
 * existed to be compared against `codeport.policy.indexAcceptConfidence` to
 * decide whether to escalate to a language server. With a single engine there is
 * nothing to escalate to, so a normalised "0.85" was fake precision: a number
 * that gated nothing while reading like a probability. The weights table, the
 * normalisation and `clamp01` went with it.
 *
 * What is still load-bearing is **ordering**. When several symbols share a name —
 * overloads, or `static` functions in different files — the mention's own
 * evidence has to decide which one is offered first, because the hover shows
 * `candidates[0]` and the Peek list is read top-down. So a candidate carries an
 * integer `rank`: how many independent pieces of evidence agree with it.
 *
 * Contradictions subtract rather than reject. Language families are unknown for
 * anything outside the table in `util/language.ts`, so a fence written ```text
 * would otherwise look like a contradiction and silently drop every candidate.
 */

import type { SymbolKind } from '../types.ts';
import { sameLanguageFamily } from '../util/language.ts';

export interface RankInput {
  readonly matchType: 'exact' | 'prefix';
  readonly queryName: string;
  readonly queryContainer?: string;
  readonly queryLanguage?: string;
  readonly queryKindHint?: SymbolKind;
  readonly hit: {
    readonly name: string;
    readonly qualifiedName?: string;
    readonly kind?: SymbolKind;
    readonly container?: string;
    readonly language?: string;
  };
}

export interface Ranking {
  /** Agreeing evidence minus contradicting evidence. Higher sorts first. */
  readonly rank: number;
  /** Human-readable evidence, surfaced verbatim in the hover and the log. */
  readonly reasons: string[];
}

/**
 * The most evidence a single **mention** can contribute (see `rankCandidate`).
 *
 * `CodegraphResolver` can take one candidate one point above this with
 * {@link BUILD_SIGNAL}: that point is evidence about the candidate's file and the
 * project's build, not about the mention, so it is added where the candidates are
 * assembled rather than here.
 */
export const MAX_RANK = 4;

/**
 * The build signal, contributed by `CodegraphResolver`.
 *
 * It answers the one question a static graph cannot: `up_allocate_heap` has one
 * definition per chip, and only a compilation database knows which of them the
 * current build compiles. Nothing about the *mention* can agree or disagree with a
 * build, which is why this is not a `rankCandidate` signal, and why it is the one
 * signal that can reach `MAX_RANK + 1`.
 *
 * C/C++ only, and only when a `compile_commands.json` actually exists — the whole
 * rationale lives in `CompileCommands.ts`.
 */
export const BUILD_SIGNAL = {
  points: 1,
  reason: 'in compile_commands.json',
} as const;

/**
 * The narrowing reason, appended by `CodegraphResolver` when the build database
 * *replaced* candidates instead of merely reordering them.
 *
 * The survivors are the strong definitions of a name whose weak default the linker
 * discards — NuttX's `weak_function` ARCH hooks are the canonical shape, and the
 * difference between jumping to a chip's real `up_allocate_heap` and jumping to the
 * generic no-op it overrides. Zero points on purpose: narrowing decides which
 * candidates exist, not how they rank. See `WeakLinkage.ts`.
 */
export const STRONG_DEFINITION = {
  points: 0,
  reason: 'strong definition',
} as const;

/**
 * Rank one candidate against the mention that produced it.
 *
 * Reasons are recorded because they are the provenance the hover shows: they are
 * what makes "why did it jump *there*" answerable.
 */
export function rankCandidate(input: RankInput): Ranking {
  const reasons: string[] = [];
  let rank = 0;

  if (input.matchType === 'exact' && input.hit.name === input.queryName) {
    rank += 1;
    reasons.push('exact name');
  } else {
    reasons.push('name prefix');
  }

  if (input.queryContainer) {
    if (input.hit.container && containerAgrees(input.hit.container, input.queryContainer)) {
      rank += 1;
      reasons.push(`qualifier ${input.hit.container}`);
    } else if (input.hit.container) {
      rank -= 1;
      reasons.push(`qualifier mismatch (${input.hit.container})`);
    }
  }

  if (input.queryLanguage && input.hit.language) {
    // Family granularity: a `cpp` project and a `.c` file are not a mismatch.
    if (sameLanguageFamily(input.queryLanguage, input.hit.language)) {
      rank += 1;
      reasons.push(`language ${input.hit.language}`);
    } else {
      rank -= 1;
      reasons.push(`language mismatch (${input.hit.language})`);
    }
  }

  if (input.queryKindHint && input.hit.kind) {
    if (kindsCompatible(input.queryKindHint, input.hit.kind)) {
      rank += 1;
      reasons.push(`kind ${input.hit.kind}`);
    } else {
      reasons.push(`kind differs (${input.hit.kind})`);
    }
  }

  return { rank, reasons };
}

/** True when a reported qualifier agrees with the mention's `a::b` prefix. */
export function containerAgrees(hitContainer: string, queryContainer: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/^::/, '').replace(/\s+/g, '').replace(/^<.*>$/, '');
  const a = normalize(hitContainer);
  const b = normalize(queryContainer);
  if (!a || !b) return false;
  return a === b || a.endsWith(`::${b}`) || b.endsWith(`::${a}`);
}

/** True when a mention's shape is consistent with a reported symbol kind. */
export function kindsCompatible(hint: SymbolKind, kind: SymbolKind): boolean {
  if (hint === kind) return true;
  switch (hint) {
    case 'function':
      // A call may land on a method or a constructor. CodeGraph has no
      // `macro` kind, so a call-shaped mention can only match a real callable.
      return kind === 'method' || kind === 'constructor';
    case 'macro':
      // `SOME_MACRO`-shaped mentions are the one place CodeGraph cannot answer:
      // it does not model preprocessor macros. Accept a same-named constant,
      // variable or function rather than refusing the jump outright.
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
