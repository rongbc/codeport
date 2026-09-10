/**
 * C/C++ symbol extraction from a tree-sitter tree (plan section 5).
 *
 * This walker recovers *structure*: functions, methods, classes/structs/unions,
 * enums and their enumerators, typedefs, aliases, variables, fields, namespaces,
 * macros and includes. It deliberately makes no attempt at *semantics* —
 * overload resolution, template instantiation and macro expansion stay the
 * language server's job (plan section 5).
 */

import { isKeyword, oneLine } from '../util/text.ts';
import type { SymbolKind } from '../types.ts';
import type { SyntaxNode, SyntaxTree } from './TreeSitterParser.ts';
import type {
  ExtractOptions,
  ExtractResult,
  ExtractedReference,
  ExtractedSymbol,
  SymbolExtractor,
} from './SymbolExtractor.ts';

interface DeclaratorInfo {
  readonly name: string;
  readonly container?: string;
  readonly nameNode: SyntaxNode;
  readonly isFunction: boolean;
}

interface WalkState {
  readonly text: string;
  readonly symbols: ExtractedSymbol[];
  readonly references: ExtractedReference[];
  readonly includes: string[];
  readonly wantReferences: boolean;
}

/** Node types that represent a declared name (as opposed to a type or modifier). */
const DECLARATOR_NODES = new Set([
  'init_declarator',
  'identifier',
  'field_identifier',
  'pointer_declarator',
  'reference_declarator',
  'function_declarator',
  'array_declarator',
  'parenthesized_declarator',
  'qualified_identifier',
  'template_function',
  'attributed_declarator',
]);

export class CppExtractor implements SymbolExtractor {
  readonly id = 'cpp';
  readonly languages = ['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda-cpp'];

  extract(tree: SyntaxTree, _language: string, options: ExtractOptions = {}): ExtractResult {
    const state: WalkState = {
      text: tree.text,
      symbols: [],
      references: [],
      includes: [],
      wantReferences: options.references ?? false,
    };
    visit(tree.rootNode, [], false, state);
    return { symbols: state.symbols, references: state.references, includes: state.includes };
  }
}

/* ------------------------------- traversal ------------------------------- */

function visit(
  node: SyntaxNode,
  scope: readonly string[],
  inAggregate: boolean,
  state: WalkState
): void {
  switch (node.type) {
    case 'namespace_definition': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) pushSymbol(nameNode.text, nameNode, 'namespace', scope, undefined, state);
      const body = node.childForFieldName('body');
      const nextScope = nameNode ? [...scope, nameNode.text] : scope;
      if (body) recurse(body, nextScope, false, state);
      return;
    }

    case 'function_definition': {
      const declarator = node.childForFieldName('declarator');
      const info = declarator ? analyzeDeclarator(declarator) : undefined;
      if (info) {
        pushSymbol(
          info.name,
          info.nameNode,
          inAggregate ? 'method' : 'function',
          scope,
          signatureFor(node, state.text),
          state,
          info.container
        );
      }
      const body = node.childForFieldName('body');
      if (body) recurse(body, scope, false, state);
      return;
    }

    case 'declaration':
    case 'field_declaration': {
      const isField = node.type === 'field_declaration';
      for (const declarator of declaredNames(node)) {
        const info = analyzeDeclarator(declarator);
        if (!info) continue;
        const kind: SymbolKind = info.isFunction
          ? inAggregate || isField
            ? 'method'
            : 'function'
          : inAggregate || isField
            ? 'field'
            : 'variable';
        pushSymbol(
          info.name,
          info.nameNode,
          kind,
          scope,
          info.isFunction ? signatureFor(node, state.text) : undefined,
          state,
          info.container
        );
      }
      // Recurse into non-declarator children (nested struct definitions), and
      // into initialisers so calls inside them still become references.
      for (const child of node.namedChildren) {
        if (DECLARATOR_NODES.has(child.type)) {
          if (child.type === 'init_declarator') {
            const value = child.childForFieldName('value');
            if (value) visit(value, scope, false, state);
          }
          continue;
        }
        visit(child, scope, isField ? true : false, state);
      }
      return;
    }

    case 'struct_specifier':
    case 'class_specifier':
    case 'union_specifier': {
      // A specifier without a body is an elaborated type reference
      // (`struct Node *next;`), not a definition — emitting it would invent a
      // bogus symbol in the enclosing scope.
      const body = node.childForFieldName('body');
      if (!body) return;
      const nameNode = node.childForFieldName('name');
      const kind: SymbolKind =
        node.type === 'class_specifier'
          ? 'class'
          : node.type === 'union_specifier'
            ? 'union'
            : 'struct';
      if (nameNode) pushSymbol(nameNode.text, nameNode, kind, scope, undefined, state);
      const nextScope = nameNode ? [...scope, nameNode.text] : scope;
      recurse(body, nextScope, true, state);
      return;
    }

    case 'enum_specifier': {
      const body =
        node.childForFieldName('body') ??
        node.namedChildren.find((child) => child.type === 'enumerator_list') ??
        null;
      // Same rule as aggregates: only a real definition carries enumerators.
      if (!body) return;
      const nameNode = node.childForFieldName('name');
      if (nameNode) pushSymbol(nameNode.text, nameNode, 'enum', scope, undefined, state);
      for (const child of body.namedChildren) {
        if (child.type !== 'enumerator') continue;
        const enumerator = child.childForFieldName('name') ?? child.namedChildren[0];
        if (enumerator) {
          pushSymbol(enumerator.text, enumerator, 'enumerator', scope, undefined, state);
        }
      }
      return;
    }

    case 'type_definition': {
      const declarator = node.childForFieldName('declarator');
      const info = declarator ? analyzeDeclarator(declarator) : undefined;
      if (info) {
        pushSymbol(info.name, info.nameNode, 'typedef', scope, undefined, state, info.container);
      }
      for (const child of node.namedChildren) {
        if (child === declarator) continue;
        visit(child, scope, false, state);
      }
      return;
    }

    case 'alias_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) pushSymbol(nameNode.text, nameNode, 'type', scope, undefined, state);
      return;
    }

    case 'preproc_def':
    case 'preproc_function_def': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        pushSymbol(nameNode.text, nameNode, 'macro', scope, oneLine(node.text, 120), state);
      }
      return;
    }

    case 'preproc_include': {
      const pathNode = node.childForFieldName('path');
      if (pathNode) state.includes.push(stripIncludeDelimiters(pathNode.text));
      return;
    }

    case 'call_expression': {
      if (state.wantReferences) {
        const callee = node.childForFieldName('function');
        const name = callee ? calleeSymbolName(callee) : undefined;
        if (name && !isKeyword(name)) {
          state.references.push({
            name,
            kind: 'call',
            line: node.startPosition.row,
            column: node.startPosition.column,
          });
        }
      }
      recurse(node, scope, false, state);
      return;
    }

    default:
      recurse(node, scope, inAggregate, state);
  }
}

function recurse(
  node: SyntaxNode,
  scope: readonly string[],
  inAggregate: boolean,
  state: WalkState
): void {
  for (const child of node.namedChildren) visit(child, scope, inAggregate, state);
}

/* ------------------------------ declarators ------------------------------ */

/**
 * Walk a declarator chain down to the declared identifier.
 * Handles pointers, references, arrays, parents, templates, destructors and
 * qualified names (`void nx::start() {}`).
 */
function analyzeDeclarator(node: SyntaxNode): DeclaratorInfo | undefined {
  let current: SyntaxNode | null = node;
  let isFunction = false;

  for (let depth = 0; current && depth < 32; depth++) {
    switch (current.type) {
      case 'function_declarator':
        isFunction = true;
        break;
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'namespace_identifier':
      case 'statement_identifier':
        return { name: current.text, nameNode: current, isFunction };
      case 'destructor_name':
      case 'operator_name':
      case 'operator_cast':
        return { name: current.text, nameNode: current, isFunction: true };
      case 'qualified_identifier':
      case 'scoped_identifier':
      case 'scoped_type_identifier': {
        const full = current.text;
        const index = full.lastIndexOf('::');
        if (index < 0) return { name: full, nameNode: current, isFunction };
        return {
          name: full.slice(index + 2),
          container: full.slice(0, index),
          nameNode: current,
          isFunction,
        };
      }
      default:
        break;
    }
    const next: SyntaxNode | null =
      current.childForFieldName('declarator') ?? current.childForFieldName('name');
    if (!next || next === current) return undefined;
    current = next;
  }
  return undefined;
}

/** Every declared name in a `declaration` / `field_declaration` node. */
function declaredNames(node: SyntaxNode): SyntaxNode[] {
  const typeNode = node.childForFieldName('type');
  const out: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (!DECLARATOR_NODES.has(child.type)) continue;
    // Skip the node that the `type` field points at (e.g. a typedef name used
    // as a type) so it is not reported as a fresh declaration.
    if (typeNode && child.startIndex === typeNode.startIndex && child.type === typeNode.type) {
      continue;
    }
    out.push(child);
  }
  return out;
}

/* ------------------------------- helpers ------------------------------- */

function pushSymbol(
  name: string,
  nameNode: SyntaxNode,
  kind: SymbolKind,
  scope: readonly string[],
  signature: string | undefined,
  state: WalkState,
  explicitContainer?: string
): void {
  if (!name) return;
  const container = explicitContainer ?? (scope.length > 0 ? scope.join('::') : undefined);
  const qualifiedName = container ? `${container}::${name}` : name;
  state.symbols.push({
    name,
    qualifiedName,
    kind,
    container,
    signature,
    line: nameNode.startPosition.row,
    column: nameNode.startPosition.column,
    endLine: nameNode.endPosition.row,
    endColumn: nameNode.endPosition.column,
  });
}

/** Text from the declaration start up to its body, on a single line. */
function signatureFor(node: SyntaxNode, text: string): string | undefined {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : node.endIndex;
  const slice = text.slice(node.startIndex, end).replace(/[;{]\s*$/, '');
  const signature = oneLine(slice, 200);
  return signature.length > 0 ? signature : undefined;
}

function stripIncludeDelimiters(text: string): string {
  return text.replace(/^[<"]/, '').replace(/[>"]$/, '');
}

/** The identifier a call expression ultimately invokes. */
function calleeSymbolName(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
      return node.text;
    case 'field_expression': {
      const field = node.childForFieldName('field');
      return field?.text;
    }
    case 'qualified_identifier':
    case 'scoped_identifier': {
      const full = node.text;
      const index = full.lastIndexOf('::');
      return index >= 0 ? full.slice(index + 2) : full;
    }
    case 'template_function': {
      const name = node.childForFieldName('name');
      return name?.text;
    }
    case 'parenthesized_expression': {
      const inner = node.namedChildren[0];
      return inner ? calleeSymbolName(inner) : undefined;
    }
    default:
      return undefined;
  }
}
