/** CodePort's output channel and the logger shared by every layer. */

import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from './constants.ts';

export type LogLevel = 'off' | 'messages' | 'verbose';

/**
 * Level semantics:
 *   off      -> warnings and errors only (problems are never hidden)
 *   messages -> plus informational lifecycle messages (the default)
 *   verbose  -> plus per-request tracing
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;
  private level: LogLevel = 'messages';

  constructor() {
    this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  info(message: string): void {
    if (this.level === 'off') return;
    this.channel.appendLine(`[info] ${message}`);
  }

  /** Always written: a user with `trace = "off"` still needs to see problems. */
  warn(message: string): void {
    this.channel.appendLine(`[warn] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[error] ${message}`);
  }

  /** Verbose diagnostics; only emitted with `codeport.trace = "verbose"`. */
  trace(message: string): void {
    if (this.level !== 'verbose') return;
    this.channel.appendLine(`[trace] ${message}`);
  }

  /** A visible marker so runs are easy to separate in the log. */
  section(title: string): void {
    this.channel.appendLine('');
    this.channel.appendLine(`===== ${title} =====`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
