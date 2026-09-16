/**
 * A stand-in for a real CodeGraph install, used by the test suite.
 *
 * CodePort loads CodeGraph as an external tool through a computed dynamic
 * `import()`, so tests can point `CODEGRAPH_SDK_PATH` at this file and exercise
 * the whole chain — loader, index facade, resolver, providers — without the real
 * 292 MB package being present.
 *
 * It reads `<root>/.codegraph/fake-graph.json`:
 *
 * ```json
 * {
 *   "nodes": [{ "id", "kind", "name", "qualifiedName", "filePath", "language",
 *               "startLine", "endLine", "startColumn", "endColumn", "signature" }],
 *   "usages": { "<nodeId>": [{ "node": {...}, "edge": { ... } }] }
 * }
 * ```
 *
 * `filePath` is deliberately relative, exactly as the real CodeGraph reports it,
 * so the tests would catch a regression in the root-joining code.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GRAPH_DIR = '.codegraph';

function graphFile(root) {
  return path.join(root, GRAPH_DIR, 'codegraph.db');
}

function dataFile(root) {
  return path.join(root, GRAPH_DIR, 'fake-graph.json');
}

function loadData(root) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(root), 'utf8'));
  } catch {
    return { nodes: [], usages: {} };
  }
}

class FakeGraph {
  constructor(root, data) {
    this.root = root;
    this.data = data;
    this.closed = false;
  }

  getNodesByName(name) {
    return this.data.nodes.filter((node) => node.name === name);
  }

  getNodesByNamePrefix(prefix, limit) {
    const hits = this.data.nodes.filter((node) => node.name.startsWith(prefix));
    return typeof limit === 'number' ? hits.slice(0, limit) : hits;
  }

  getNodesByNameSubstring(substring, options) {
    const limit = options && typeof options.limit === 'number' ? options.limit : undefined;
    const hits = this.data.nodes.filter((node) => node.name.includes(substring));
    return limit === undefined ? hits : hits.slice(0, limit);
  }

  findUsages(nodeId) {
    return this.data.usages[nodeId] || [];
  }

  getCallers(nodeId) {
    return this.findUsages(nodeId);
  }

  getStats() {
    return {
      nodeCount: this.data.nodes.length,
      edgeCount: Object.values(this.data.usages).reduce((sum, list) => sum + list.length, 0),
      fileCount: new Set(this.data.nodes.map((node) => node.filePath)).size,
      dbSizeBytes: 4096,
    };
  }

  async getCode(nodeId) {
    const node = this.data.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    try {
      const lines = fs.readFileSync(path.resolve(this.root, node.filePath), 'utf8').split('\n');
      return lines.slice(node.startLine - 1, node.endLine).join('\n');
    } catch {
      return null;
    }
  }

  close() {
    this.closed = true;
  }
}

class CodeGraph {
  static isInitialized(projectRoot) {
    return fs.existsSync(graphFile(projectRoot));
  }

  static async open(projectRoot, _options) {
    if (!CodeGraph.isInitialized(projectRoot)) {
      throw new Error(`not initialized: ${projectRoot}`);
    }
    return new FakeGraph(projectRoot, loadData(projectRoot));
  }

  static openSync(projectRoot) {
    if (!CodeGraph.isInitialized(projectRoot)) {
      throw new Error(`not initialized: ${projectRoot}`);
    }
    return new FakeGraph(projectRoot, loadData(projectRoot));
  }
}

function isInitialized(projectRoot) {
  return CodeGraph.isInitialized(projectRoot);
}

function findNearestCodeGraphRoot(from) {
  let current = path.resolve(from);
  for (;;) {
    if (fs.existsSync(graphFile(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function getSupportedLanguages() {
  return ['c', 'cpp', 'typescript', 'python'];
}

module.exports = {
  CodeGraph,
  isInitialized,
  findNearestCodeGraphRoot,
  getSupportedLanguages,
};
