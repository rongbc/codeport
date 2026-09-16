/**
 * A CodeGraph SDK that loads but cannot open a graph.
 *
 * This models "CodeGraph is installed but the index is missing, locked, or built
 * by an incompatible version" — the realistic failure the extension must survive
 * without taking the jump down with it.
 *
 * Tests use it instead of pointing at a nonexistent path because the loader
 * falls back to any globally installed CodeGraph, which would make the outcome
 * depend on the machine running the suite.
 */

'use strict';

class CodeGraph {
  static isInitialized() {
    return true;
  }

  static async open() {
    throw new Error('fake codegraph: graph is unavailable');
  }

  static openSync() {
    throw new Error('fake codegraph: graph is unavailable');
  }
}

module.exports = {
  CodeGraph,
  isInitialized: () => true,
  findNearestCodeGraphRoot: () => null,
  getSupportedLanguages: () => [],
};
