/**
 * Adapter registry: maps language ids to `LanguageAdapter`s.
 *
 * `codeport.languages` lets users override the mapping (plan section 9) without
 * touching code, e.g. `{ "c": "clangd", "cpp": "clangd" }`.
 */

import type { LanguageAdapter } from './LanguageAdapter.ts';
import { normalizeLanguageId } from '../util/language.ts';

export class AdapterRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): LanguageAdapter | undefined {
    return this.adapters.get(id);
  }

  all(): LanguageAdapter[] {
    return [...this.adapters.values()];
  }

  get size(): number {
    return this.adapters.size;
  }

  /**
   * The adapter serving `language`, honouring user overrides where present.
   * Returns `undefined` when nothing can handle it — CodePort would rather say
   * "no definition found" than guess (plan section 7, level 3).
   */
  forLanguage(
    language: string | undefined,
    overrides?: Readonly<Record<string, string>>
  ): LanguageAdapter | undefined {
    if (!language) return undefined;
    const normalized = normalizeLanguageId(language);
    if (!normalized) return undefined;

    if (overrides) {
      const overrideId = overrides[normalized] ?? overrides[language];
      if (overrideId) {
        const override = this.adapters.get(overrideId);
        if (override) return override;
      }
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.languages.some((candidate) => normalizeLanguageId(candidate) === normalized)) {
        return adapter;
      }
    }
    return undefined;
  }

  /** Every adapter that can serve `language`, most specific first. */
  allForLanguage(language: string | undefined): LanguageAdapter[] {
    const primary = this.forLanguage(language);
    if (!primary) return this.all();
    return [primary, ...this.all().filter((adapter) => adapter !== primary)];
  }
}
