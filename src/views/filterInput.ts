import * as vscode from 'vscode';
import type { RepoExplorerProvider } from './repoExplorer';

/**
 * A one-line text box above the Repo Explorer. Tree views cannot hold an
 * input of their own, so this is a tiny webview view that sends what is
 * typed to the Repo Explorer.
 */
export class FilterInputProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly explorer: RepoExplorerProvider) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: { type: string; text?: string }) => {
      if (message.type === 'text') this.explorer.setFilterText(message.text ?? '');
      if (message.type === 'focusTree') void vscode.commands.executeCommand('multiRepoGit.explorer.focus');
    });
  }

  /** Puts the cursor in the box, opening the view if needed. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand('multiRepoGit.filterInput.focus');
    void this.view?.webview.postMessage({ type: 'focus' });
  }

  clear(): void {
    this.explorer.setFilterText('');
    void this.view?.webview.postMessage({ type: 'set', text: '' });
  }

  private html(): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const value = escapeHtml(this.explorer.filterText);
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { margin: 0; padding: 6px 12px 8px 20px; }
  .box { position: relative; display: flex; }
  input {
    flex: 1; min-width: 0; box-sizing: border-box; height: 26px; padding: 3px 24px 3px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  button {
    position: absolute; right: 2px; top: 3px; width: 20px; height: 20px; padding: 0;
    border: none; border-radius: 3px; background: transparent; cursor: pointer;
    color: var(--vscode-icon-foreground); font-size: 14px; line-height: 20px;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button[hidden] { display: none; }
</style>
</head>
<body>
<div class="box">
  <input id="text" type="text" value="${value}" placeholder="Filter by repo or changed file" aria-label="Filter Repo Explorer by repo path or changed file name" spellcheck="false">
  <button id="clear" title="Clear" aria-label="Clear filter"${value ? '' : ' hidden'}>✕</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('text');
  const clear = document.getElementById('clear');
  let timer;
  function send() {
    clear.hidden = input.value === '';
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'text', text: input.value }), 150);
  }
  input.addEventListener('input', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && input.value) { input.value = ''; send(); e.preventDefault(); }
    if (e.key === 'Enter' || e.key === 'ArrowDown') { vscode.postMessage({ type: 'focusTree' }); e.preventDefault(); }
  });
  clear.addEventListener('click', () => { input.value = ''; send(); input.focus(); });
  window.addEventListener('message', e => {
    if (e.data.type === 'focus') input.focus();
    if (e.data.type === 'set') { input.value = e.data.text; clear.hidden = input.value === ''; }
  });
</script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
