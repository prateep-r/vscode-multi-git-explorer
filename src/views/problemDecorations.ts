import * as vscode from 'vscode';
import { problemBadge } from '../core/problems';
import { VIEW_SCHEME, toViewUri } from './viewUri';

/**
 * Colors and counts files with errors or warnings in our views, and tints
 * the folders above them, like the built-in Explorer. Follows
 * `problems.visibility` and `problems.decorations.enabled`.
 */
export class ProblemDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[];

  constructor() {
    this.disposables = [
      this._onDidChange,
      // Naming the files makes VS Code ask for them even off screen, so their folders get tinted too.
      vscode.languages.onDidChangeDiagnostics(e => this.fire(e.uris)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('problems')) this._onDidChange.fire(undefined);
      }),
    ];
    // Problems found before we started.
    setTimeout(() => this.fire(vscode.languages.getDiagnostics().map(([uri]) => uri)), 0);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private fire(uris: readonly vscode.Uri[]): void {
    const files = uris.filter(uri => uri.scheme === 'file').map(uri => toViewUri(uri.fsPath));
    if (files.length) this._onDidChange.fire(files);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== VIEW_SCHEME || !enabled()) return undefined;
    let errors = 0;
    let warnings = 0;
    for (const d of vscode.languages.getDiagnostics(vscode.Uri.file(uri.fsPath))) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
    const problem = problemBadge(errors, warnings);
    if (!problem) return undefined;
    const decoration = new vscode.FileDecoration(
      problem.badge,
      problem.tooltip,
      new vscode.ThemeColor(problem.isError ? 'list.errorForeground' : 'list.warningForeground'),
    );
    decoration.propagate = true;
    return decoration;
  }
}

function enabled(): boolean {
  const problems = vscode.workspace.getConfiguration('problems');
  return problems.get<boolean>('visibility') !== false && problems.get<boolean>('decorations.enabled') !== false;
}
