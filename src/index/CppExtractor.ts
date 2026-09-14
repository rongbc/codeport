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

/** One pending node of the depth-first walk, with the scope it is visited in. */
interface Frame {
  readonly node: SyntaxNode;
  readonly scope: readonly string[];
  readonly inAggregate: boolean;
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
    visitTree(tree.rootNode, state);
    return { symbols: state.symbols, references: state.references, includes: state.includes };
  }
}

/* ------------------------------- traversal ------------------------------- */

/**
 * Depth-first walk over the syntax tree using an explicit stack.
 *
 * The walk is deliberately *not* recursive: generated or macro-heavy C/C++ can
 * nest thousands of nodes deep (long expression chains, nested initialisers or
 * namespaces), and a recursive walk overflows the call stack — the
 * `Maximum call stack size exceeded` failure that aborted the whole rebuild.
 * Children are pushed in reverse so symbols keep their source order.
 */
function visitTree(root: SyntaxNode, state: WalkState): void {
  const stack: Frame[] = [{ node: root, scope: [], inAggregate: false }];

  while (stack.length > 0) {
    const { node, scope, inAggregate } = stack.pop()!;

    switch (node.type) {
      case 'namespace_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) pushSymbol(nameNode.text, nameNode, 'namespace', scope, undefined, state);
        const body = node.childForFieldName('body');
        const nextScope = nameNode ? [...scope, nameNode.text] : scope;
        if (body) stack.push({ node: body, scope: nextScope, inAggregate: false });
        continue;
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
        if (body) stack.push({ node: body, scope, inAggregate: false });
        continue;
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
        const frames: Frame[] = [];
        for (const child of node.namedChildren) {
          if (DECLARATOR_NODES.has(child.type)) {
            if (child.type === 'init_declarator') {
              const value = child.childForFieldName('value');
              if (value) frames.push({ node: value, scope, inAggregate: false });
            }
            continue;
          }
          frames.push({ node: child, scope, inAggregate: isField });
        }
        pushFrames(stack, frames);
        continue;
      }

      case 'struct_specifier':
      case 'class_specifier':
      case 'union_specifier': {
        // A specifier without a body is an elaborated type reference
        // (`struct Node *next;`), not a definition — emitting it would invent a
        // bogus symbol in the enclosing scope.
        const body = node.childForFieldName('body');
        if (!body) continue;
        const nameNode = node.childForFieldName('name');
        const kind: SymbolKind =
          node.type === 'class_specifier'
            ? 'class'
            : node.type === 'union_specifier'
              ? 'union'
              : 'struct';
        if (nameNode) pushSymbol(nameNode.text, nameNode, kind, scope, undefined, state);
        const nextScope = nameNode ? [...scope, nameNode.text] : scope;
        stack.push({ node: body, scope: nextScope, inAggregate: true });
        continue;
      }

      case 'enum_specifier': {
        const body =
          node.childForFieldName('body') ??
          node.namedChildren.find((child) => child.type === 'enumerator_list') ??
          null;
        // Same rule as aggregates: only a real definition carries enumerators.
        if (!body) continue;
        const nameNode = node.childForFieldName('name');
        if (nameNode) pushSymbol(nameNode.text, nameNode, 'enum', scope, undefined, state);
        for (const child of body.namedChildren) {
          if (child.type !== 'enumerator') continue;
          const enumerator = child.childForFieldName('name') ?? child.namedChildren[0];
          if (enumerator) {
            pushSymbol(enumerator.text, enumerator, 'enumerator', scope, undefined, state);
          }
        }
        continue;
      }

      case 'type_definition': {
        const declarator = node.childForFieldName('declarator');
        const info = declarator ? analyzeDeclarator(declarator) : undefined;
        if (info) {
          pushSymbol(info.name, info.nameNode, 'typedef', scope, undefined, state, info.container);
        }
        const frames: Frame[] = [];
        for (const child of node.namedChildren) {
          if (child === declarator) continue;
          frames.push({ node: child, scope, inAggregate: false });
        }
        pushFrames(stack, frames);
        continue;
      }

      case 'alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) pushSymbol(nameNode.text, nameNode, 'type', scope, undefined, state);
        continue;
      }

      case 'preproc_def':
      case 'preproc_function_def': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          pushSymbol(nameNode.text, nameNode, 'macro', scope, oneLine(node.text, 120), state);
        }
        continue;
      }

      case 'preproc_include': {
        const pathNode = node.childForFieldName('path');
        if (pathNode) state.includes.push(stripIncludeDelimiters(pathNode.text));
        continue;
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
        pushChildren(stack, node, scope, false);
        continue;
      }

      default:
        pushChildren(stack, node, scope, inAggregate);
    }
  }
}

/** Push frames so that the first one ends up on top of the stack. */
function pushFrames(stack: Frame[], frames: readonly Frame[]): void {
  for (let i = frames.length - 1; i >= 0; i--) stack.push(frames[i]!);
}

/** Push every named child, preserving source order. */
function pushChildren(
  stack: Frame[],
  node: SyntaxNode,
  scope: readonly string[],
  inAggregate: boolean
): void {
  const children = node.namedChildren;
  for (let i = children.length - 1; i >= 0; i--) {
    stack.push({ node: children[i]!, scope, inAggregate });
  }
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
  // Iterative with a bound: `((((f))))(x)` used to recurse once per pair of
  // parentheses and could overflow the stack on a pathological expression.
  let current: SyntaxNode | null = node;
  for (let depth = 0; current && depth < 64; depth++) {
    switch (current.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return current.text;
      case 'field_expression': {
        const field = current.childForFieldName('field');
        return field?.text;
      }
      case 'qualified_identifier':
      case 'scoped_identifier': {
        const full = current.text;
        const index = full.lastIndexOf('::');
        return index >= 0 ? full.slice(index + 2) : full;
      }
      case 'template_function': {
        const name = current.childForFieldName('name');
        return name?.text;
      }
      case 'parenthesized_expression':
        current = current.namedChildren[0] ?? null;
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}
