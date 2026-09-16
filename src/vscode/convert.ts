/** Conversions between CodePort's plain types and the `vscode` API. */

import * as vscode from 'vscode';
import type { Location, Position, Range } from '../types.ts';

export function toVsRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

export function fromVsPosition(position: vscode.Position): Position {
  return { line: position.line, character: position.character };
}

export function toVsLocation(location: Location): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(location.uri), toVsRange(location.range));
}

/** `file:line` label for a location, used in hover and status messages. */
export function describeLocation(location: Location): string {
  const path = location.uri.replace(/^file:\/\//, '');
  return `${path}:${location.range.start.line + 1}`;
}
