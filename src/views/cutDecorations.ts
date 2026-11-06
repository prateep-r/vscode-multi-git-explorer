import * as vscode from 'vscode';
import type { FileOperations } from '../fileCommands';
import { VIEW_SCHEME } from './viewUri';

/**
 * Dims rows that were cut until they're pasted, like the built-in Explorer.
 * Extensions can only change the color, so the name is dimmed but not the icon.
 */
export class CutDecorationProvider implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[]>;

  constructor(private readonly files: FileOperations) {
    this.onDidChangeFileDecorations = files.onDidChangeCut;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== VIEW_SCHEME || !this.files.isCut(uri.fsPath)) return undefined;
    return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('disabledForeground'));
  }
}
