"""Draws the README illustrations as HTML pages styled like VS Code's Dark Modern theme.

The text in them is what the extension shows for the sample workspace made by
scripts/make-sample-repos.sh. Run render.sh rather than this file directly.
"""
import os
import re

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1f1f1f;color:#cccccc;font:13px -apple-system,"Segoe UI",sans-serif;overflow:hidden}
.ci{font-family:codicon;font-size:16px;line-height:1;vertical-align:middle}
.win{display:grid;height:100vh}
.title{background:#181818;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;justify-content:center;font-size:12px;color:#9d9d9d;position:relative}
.dots{position:absolute;left:12px;display:flex;gap:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block}
.act{background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:8px;gap:4px}
.act .a{width:48px;height:44px;display:flex;align-items:center;justify-content:center;color:#868686;font-size:24px}
.act .a.on{color:#d7d7d7;border-left:2px solid #0078d4}
.side{background:#181818;border-right:1px solid #2b2b2b;position:relative;z-index:3}
.vt{font-size:11px;color:#cccccc;padding:0 20px;height:35px;display:flex;align-items:center;letter-spacing:.02em}
.sec{font-size:11px;font-weight:700;height:22px;display:flex;align-items:center;gap:2px;padding-left:2px;border-top:1px solid #2b2b2b;color:#cccccc}
.sec .d{font-weight:400;color:#9d9d9d;margin-left:6px}
.sec .acts{margin-left:auto;padding-right:8px;display:flex;gap:6px;color:#cccccc}
.row{display:flex;align-items:center;height:22px;padding-right:12px;white-space:nowrap}
.row .tw{width:16px;text-align:center;color:#cccccc;flex:none}
.row .ic{width:16px;margin-right:6px;flex:none;text-align:center}
.row .lb{flex:none}
.row .ds{color:#9d9d9d;font-size:12px;margin-left:6px;overflow:hidden;text-overflow:ellipsis;flex:1}
.row .sp{flex:1}
.row .bd{flex:none;min-width:18px;text-align:right;font-size:12px;margin-left:8px}
.sel{background:#04395e;outline:1px solid #0078d4;outline-offset:-1px}
.hov{background:#2a2d2e}
.am{color:#e2c08d}.bl{color:#75beff}.rd{color:#e4676b}.pu{color:#c586c0}.gr{color:#81b88b}.mu{color:#8c8c8c}
.ed{background:#1f1f1f;display:flex;flex-direction:column;overflow:hidden}
.tabs{height:35px;background:#181818;display:flex;border-bottom:1px solid #2b2b2b}
.tab{background:#1f1f1f;padding:0 14px;display:flex;align-items:center;gap:6px;color:#ffffff;border-top:1px solid #0078d4;border-right:1px solid #2b2b2b}
.crumbs{height:22px;display:flex;align-items:center;padding-left:16px;color:#a9a9a9;font-size:12px;gap:4px}
.code{padding:4px 0;font:13px/19px Menlo,monospace;color:#cccccc}
.code div{white-space:pre}.ln{color:#6e7681;display:inline-block;width:44px;text-align:right;margin-right:24px}
.k{color:#569cd6}.s{color:#ce9178}.f{color:#dcdcaa}.t{color:#4ec9b0}.v{color:#9cdcfe}.c{color:#6a9955}
.status{background:#181818;border-top:1px solid #2b2b2b;color:#cccccc;display:flex;align-items:center;font-size:12px;padding:0 6px;gap:2px}
.status .it{padding:0 6px;display:flex;align-items:center;gap:4px;height:100%}
.status .sp{flex:1}
.tip{position:absolute;background:#202020;border:1px solid #454545;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.6);padding:6px 9px;font-size:12px;line-height:1.6;color:#cccccc;white-space:pre;z-index:5}
.menu{position:absolute;background:#1f1f1f;border:1px solid #454545;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.6);padding:4px;font-size:13px;z-index:6;min-width:250px}
.mi{height:26px;display:flex;align-items:center;padding:0 24px 0 26px;border-radius:4px;color:#cccccc;white-space:nowrap}
.mi.hl{background:#0078d4;color:#fff}
.msep{height:1px;background:#454545;margin:4px 6px}
.mi .kb{margin-left:auto;padding-left:28px;color:#9d9d9d;letter-spacing:1px}
.mi.hl .kb{color:#fff}
.mi.dis{color:#6b6b6b}
.cap{position:absolute;background:#ffd84d;color:#1b1b1b;font-weight:700;font-size:12px;border-radius:11px;height:22px;min-width:22px;padding:0 7px;display:flex;align-items:center;justify-content:center;z-index:9;box-shadow:0 0 0 3px rgba(0,0,0,.45);white-space:nowrap}
"""
HEAD = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"><style>' + CSS + '</style></head><body>'
# The Activity Bar icon, read from the one shipped with the extension.
ICON = re.sub(r'\s*\n\s*', '', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'media', 'icon.svg')).read().replace(' xmlns="http://www.w3.org/2000/svg"', ''))

def ci(name, cls=''):
    return f'<i class="codicon codicon-{name} {cls}"></i>'

def row(indent, twisty, label, desc='', badge='', color='', icon='', extra=''):
    tw = {'open': ci('chevron-down'), 'closed': ci('chevron-right'), '': ''}[twisty]
    ic = f'<span class="ic">{icon}</span>' if icon else ''
    d = f'<span class="ds">{desc}</span>' if desc else '<span class="sp"></span>'
    b = f'<span class="bd {color}">{badge}</span>' if badge else ''
    return f'<div class="row {extra}" style="padding-left:{8 + indent * 8}px"><span class="tw">{tw}</span>{ic}<span class="lb {color}">{label}</span>{d}{b}</div>'

TS = '<span style="color:#519aba;font-size:10px;font-weight:700">TS</span>'
MD = '<span style="color:#519aba;font-size:12px">' + ci('markdown') + '</span>'
REPO = ci('repo')

def chrome(cols, side, editor, status_left, status_right, title):
    return (HEAD + f'<div class="win" style="grid-template-columns:48px {cols} 1fr;grid-template-rows:30px 1fr 22px">'
        + f'<div class="title" style="grid-column:1/4"><span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>{title}</div>'
        + '<div class="act"><div class="a">' + ci('files') + '</div><div class="a">' + ci('search') + '</div><div class="a">' + ci('source-control')
        + f'</div><div class="a on">{ICON}</div><div class="a">' + ci('extensions') + '</div></div>'
        + f'<div class="side">{side}</div><div class="ed">{editor}</div>'
        + f'<div class="status" style="grid-column:1/4">{status_left}<span class="sp"></span>{status_right}</div></div></body></html>')

EDITOR = ('<div class="tabs"><div class="tab">' + TS + ' sso.ts</div></div>'
    '<div class="crumbs">services ' + ci('chevron-right') + ' auth-service ' + ci('chevron-right') + ' src ' + ci('chevron-right') + ' sso.ts</div>'
    '<div class="code">'
    '<div><span class="ln">1</span><span class="k">import</span> { <span class="v">Issuer</span> } <span class="k">from</span> <span class="s">\'openid-client\'</span>;</div>'
    '<div><span class="ln">2</span></div>'
    '<div><span class="ln">3</span><span class="k">export async function</span> <span class="f">createSsoClient</span>(<span class="v">issuerUrl</span>: <span class="t">string</span>) {</div>'
    '<div><span class="ln">4</span>  <span class="k">const</span> <span class="v">issuer</span> = <span class="k">await</span> <span class="t">Issuer</span>.<span class="f">discover</span>(<span class="v">issuerUrl</span>);</div>'
    '<div><span class="ln">5</span>  <span class="k">return new</span> <span class="v">issuer</span>.<span class="t">Client</span>({ <span class="v">client_id</span>: <span class="s">\'web\'</span> });</div>'
    '<div><span class="ln">6</span>}</div></div>')

STATUS_LEFT = '<span class="it">' + ci('git-branch') + ' auth-service: feat/sso ↑2</span>'
STATUS_RIGHT = ('<span class="it">' + ci('warning') + ' 2</span><span class="it">' + ci('circle-filled') + ' 3</span>'
    '<span class="it">' + ci('arrow-up') + ' 2</span><span class="it">' + ci('arrow-down') + ' 2</span>')

def group(label, count, icon, color, open_=True):
    return (f'<div class="row" style="padding-left:8px"><span class="tw">{ci("chevron-down" if open_ else "chevron-right")}</span>'
            f'<span class="ic {color}">{ci(icon)}</span><span class="lb">{label}</span><span class="ds">{count}</span></div>')

def repo_row(path, desc, badge, color, extra=''):
    return row(2, '', path, desc, badge, color, icon=REPO, extra=extra)

GIT_REPOS = (
    group('Conflict / in progress', 2, 'warning', 'rd')
    + repo_row('services/billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
    + repo_row('services/catalog', '⎇ topic · REBASING 1/2 · ✕1', '!', 'rd')
    + group('Uncommitted changes', 3, 'circle-filled', 'am')
    + repo_row('frontend/design-system', '⎇ 3f2a9c1 (detached) · ●1', '1', 'am')
    + repo_row('services/api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
    + repo_row('services/reports', '⎇ main · ?12', '9+', 'am')
    + group('Not pushed', 2, 'arrow-up', 'bl')
    + repo_row('services/auth-service', '⎇ feat/sso · ↑2 · ≡1', '↑2', 'bl', 'SELAUTH')
    + repo_row('services/mobile-api', '⎇ fix/login · no upstream', '↑', 'bl')
    + group('Behind remote', 2, 'arrow-down', 'pu')
    + repo_row('services/payments', '⎇ main · ↑2 ↓3', '↕', 'pu')
    + repo_row('services/search', '⎇ main · ↓4', '↓4', 'pu')
    + group('Clean', 290, 'check', 'gr', open_=False))

def repo_explorer(sel=True):
    return (
        row(0, 'closed', 'archive', '287 repos · all clean')
        + row(0, 'closed', 'docs', 'no git')
        + row(0, 'closed', 'frontend', '3 repos · ●1')
        + row(0, 'open', 'services', '9 repos · !2 ●2 ↑2 ↓2')
        + row(1, 'closed', 'api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
        + row(1, 'open', 'auth-service', '⎇ feat/sso · ↑2 · ≡1', '↑2', 'bl', extra='sel' if sel else '')
        + row(2, 'closed', 'src')
        + row(2, '', 'README.md', icon=MD)
        + row(1, 'closed', 'billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
        + row(1, 'closed', 'catalog', '⎇ topic · REBASING 1/2 · ✕1', '!', 'rd')
        + row(1, 'closed', 'mobile-api', '⎇ fix/login · no upstream', '↑', 'bl')
        + row(1, 'closed', 'notification', '⎇ main')
        + row(1, 'closed', 'payments', '⎇ main · ↑2 ↓3', '↕', 'pu')
        + row(1, 'closed', 'reports', '⎇ main · ?12', '9+', 'am')
        + row(1, 'closed', 'search', '⎇ main · ↓4', '↓4', 'pu'))

def sec(title, desc='', acts=''):
    a = f'<span class="acts">{acts}</span>' if acts else ''
    d = f'<span class="d">{desc}</span>' if desc else ''
    return f'<div class="sec"><span class="tw">{ci("chevron-down")}</span>{title}{d}{a}</div>'

# Our file tree's header: "Files", with the project's name as the view's
# description, which keeps its case.
PROJECT = 'FILES<span class="d">sample-ws</span>'

REPOS_ACTS = ci('cloud-download') + ci('filter') + ci('refresh') + ci('collapse-all')

# 1. Overview
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + sec(PROJECT, '', ci('new-file') + ci('new-folder') + ci('circle-outline') + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all')) + repo_explorer()
    + sec('GIT REPOSITORIES', '299', REPOS_ACTS) + GIT_REPOS.replace('SELAUTH', ''))
html = chrome('470px', side, EDITOR, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
caps = ('<div class="cap" style="left:220px;top:65px">1  Files</div>'
        '<div class="cap" style="left:180px;top:417px">2  Git Repositories</div>'
        '<div class="cap" style="left:190px;top:757px">3  Status bar</div>')
html = html.replace('grid-template-rows:30px 1fr 22px', 'grid-template-rows:30px minmax(0,1fr) 22px')
open('overview.html', 'w').write(html.replace('</body>', caps + '</body>'))

# 2. Built-in Explorer with badges and tooltip
tip = ('auth-service — ⎇ feat/sso\n2 to push (origin/feat/sso)\nNo local changes\nStash: 1\nLast fetch: 43 minutes ago')
side = ('<div class="vt">EXPLORER</div>' + sec('SAMPLE-WS')
    + row(0, 'closed', 'archive') + row(0, 'closed', 'docs') + row(0, 'closed', 'frontend', badge='•', color='am')
    + row(0, 'open', 'services', badge='•', color='rd')
    + row(1, 'closed', 'api-gateway', badge='4', color='am')
    + row(1, 'closed', 'auth-service', badge='↑2', color='bl', extra='hov')
    + row(1, 'closed', 'billing', badge='!', color='rd')
    + row(1, 'closed', 'catalog', badge='!', color='rd')
    + row(1, 'closed', 'mobile-api', badge='↑', color='bl')
    + row(1, 'closed', 'notification')
    + row(1, 'closed', 'payments', badge='↕', color='pu')
    + row(1, 'closed', 'reports', badge='9+', color='am')
    + row(1, 'closed', 'search', badge='↓4', color='pu')
    + f'<div class="tip" style="left:318px;top:196px">{tip}</div>')
html = chrome('300px', side, EDITOR, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
open('explorer.html', 'w').write(html)

# 3. The file tree filtered to changed files
LETTER = {'M': 'am', 'A': 'gr', 'U': 'gr', 'D': 'rd', '!': 'rd', 'R': 'bl'}
def frow(indent, name, letter, extra_desc='', strike=False):
    lab = f'<span style="text-decoration:line-through">{name}</span>' if strike else name
    color = LETTER[letter]
    return (f'<div class="row" style="padding-left:{8 + indent * 8}px"><span class="tw"></span><span class="ic">{TS if name.endswith(".ts") else MD if name.endswith(".md") else ci("file")}</span>'
            f'<span class="lb {color}">{lab}</span><span class="ds">{extra_desc}</span><span class="bd {color}">{letter}</span></div>')
FILTER_ON = '<span style="color:#ffffff">' + ci('circle-filled') + '</span>'
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + '<div class="sec"><span class="tw">' + ci('chevron-down') + '</span>' + PROJECT + '<span class="acts">' + ci('new-file') + ci('new-folder') + FILTER_ON + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all') + '</span></div>'
    + '<div style="padding:6px 20px 8px;color:#9d9d9d;font-size:12px">Showing changed files · 5 of 299 repos</div>'
    + row(0, 'open', 'frontend', '1 repo · ●1')
    + row(1, 'open', 'design-system', '⎇ 3f2a9c1 (detached) · ●1', '1', 'am')
    + frow(2, 'README.md', 'M')
    + row(0, 'open', 'services', '4 repos · !2 ●2')
    + row(1, 'open', 'api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
    + row(2, 'open', 'src')
    + frow(3, 'index.ts', 'M')
    + frow(3, 'routes.ts', 'A', 'staged')
    + frow(2, 'NOTES.md', 'U')
    + frow(2, 'README.md', 'M')
    + row(1, 'open', 'billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
    + frow(2, 'README.md', '!', 'conflict')
    + row(1, 'open', 'catalog', '⎇ topic · REBASING 1/2 · ✕1', '!', 'rd')
    + frow(2, 'README.md', '!', 'conflict')
    + row(1, 'open', 'reports', '⎇ main · ?12', '9+', 'am')
    + frow(2, 'a.csv', 'U') + frow(2, 'b.csv', 'U') + frow(2, 'c.csv', 'U')
    + frow(2, 'd.csv', 'U')
    + '<div class="sec"><span class="tw">' + ci('chevron-right') + '</span>GIT REPOSITORIES<span class="d">299</span></div>')
html = chrome('470px', side, EDITOR, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
caps = ''
open('filter.html', 'w').write(html.replace('</body>', caps + '</body>'))

# 4. Diff opened from a changed file
def tsl(code):
    import re
    code = code.replace('&', '&amp;').replace('<', '&lt;')
    code = re.sub(r"('[^']*')", r'<span class="s">\1</span>', code)
    code = re.sub(r'\b(import|from|const|export)\b', r'<span class="k">\1</span>', code)
    code = re.sub(r'\b(express|authRouter|routes|app|process)\b', r'<span class="v">\1</span>', code)
    code = re.sub(r'\.(use|listen)\(', r'.<span class="f">\1</span>(', code)
    code = re.sub(r'\b(3000)\b', r'<span style="color:#b5cea8">\1</span>', code)
    return code
LEFT = [(1, "import express from 'express';", ''), (2, "import { authRouter } from './auth';", ''), (None, '', 'fill'),
        (3, '', ''), (4, 'const app = express();', ''), (5, "app.use('/auth', authRouter);", ''), (None, '', 'fill'),
        (6, '', ''), (7, 'app.listen(3000);', 'del')]
RIGHT = [(1, "import express from 'express';", ''), (2, "import { authRouter } from './auth';", ''), (3, "import { routes } from './routes';", 'add'),
         (4, '', ''), (5, 'const app = express();', ''), (6, "app.use('/auth', authRouter);", ''), (7, "app.use('/api', routes);", 'add'),
         (8, '', ''), (9, 'app.listen(process.env.PORT ?? 3000);', 'add')]
def pane(lines, kind):
    out = ''
    for n, code, cls in lines:
        bg = {'add': 'background:rgba(155,185,85,.18)', 'del': 'background:rgba(255,0,0,.16)',
              'fill': 'background:repeating-linear-gradient(-45deg,transparent 0 6px,rgba(204,204,204,.08) 6px 8px)', '': ''}[cls]
        sign = {'add': '+', 'del': '−'}.get(cls, '')
        c = tsl(code)
        if n == 9 and kind == 'r':
            c = c.replace('<span class="v">process</span>.env.PORT ?? ', '<span style="background:rgba(155,185,85,.45)"><span class="v">process</span>.env.PORT ?? </span>')
        out += (f'<div style="{bg};display:flex;height:19px"><span class="ln" style="width:34px;margin-right:6px">{n or ""}</span>'
                f'<span style="width:14px;color:{"#81b88b" if cls=="add" else "#f48771"}">{sign}</span><span style="white-space:pre">{c}</span></div>')
    return out
DIFF_EDITOR = ('<div class="tabs"><div class="tab" style="font-style:italic">' + TS + ' index.ts (Working Tree)</div></div>'
    '<div class="crumbs">services ' + ci('chevron-right') + ' api-gateway ' + ci('chevron-right') + ' src ' + ci('chevron-right') + ' index.ts</div>'
    '<div style="display:grid;grid-template-columns:1fr 1fr;font:13px/19px Menlo,monospace;color:#cccccc;flex:1">'
    '<div style="border-right:1px solid #2b2b2b;padding-top:4px">' + pane(LEFT, 'l') + '</div>'
    '<div style="padding-top:4px">' + pane(RIGHT, 'r') + '</div></div>')
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + '<div class="sec"><span class="tw">' + ci('chevron-down') + '</span>' + PROJECT + '<span class="acts">' + ci('new-file') + ci('new-folder') + FILTER_ON + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all') + '</span></div>'
    + '<div style="padding:6px 20px 8px;color:#9d9d9d;font-size:12px">Showing changed files · 5 of 299 repos</div>'
    + row(0, 'open', 'services', '4 repos · !2 ●2')
    + row(1, 'open', 'api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
    + row(2, 'open', 'src')
    + frow(3, 'index.ts', 'M').replace('class="row "', 'class="row sel"').replace('<div class="row" style="padding-left:32px">', '<div class="row sel" style="padding-left:32px">')
    + frow(3, 'routes.ts', 'A', 'staged')
    + frow(2, 'NOTES.md', 'U')
    + frow(2, 'README.md', 'M')
    + row(1, 'closed', 'billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
    + row(1, 'closed', 'catalog', '⎇ topic · REBASING 1/2 · ✕1', '!', 'rd')
    + row(1, 'closed', 'reports', '⎇ main · ?12', '9+', 'am'))
html = chrome('420px', side, DIFF_EDITOR, STATUS_LEFT, STATUS_RIGHT, 'index.ts (Working Tree) — sample-ws — Visual Studio Code')
caps = ('<div class="cap" style="left:735px;top:66px">← Left: last commit (HEAD)</div>'
        '<div class="cap" style="left:1075px;top:66px">Right: your working copy →</div>')
open('diff.html', 'w').write(html.replace('</body>', caps + '</body>'))

def menu_html(left, top, groups, highlight):
    """A right-click menu. Items are names, or (name, shortcut), and 'Paste' shows as disabled."""
    m = f'<div class="menu" style="left:{left}px;top:{top}px">'
    for gi, g in enumerate(groups):
        if gi: m += '<div class="msep"></div>'
        for it in g:
            name, kb = it if isinstance(it, tuple) else (it, '')
            cls = ' hl' if name == highlight else ' dis' if name == 'Paste' else ''
            m += f'<div class="mi{cls}">{name}' + (f'<span class="kb">{kb}</span>' if kb else '') + '</div>'
    return m + '</div>'

# The menu items every row in the file tree gets, after its own ones.
FILE_GROUPS = [
    ['Reveal in Finder', 'Open in Integrated Terminal', 'Reveal in Explorer View'],
    [('Cut', '⌘X'), ('Copy', '⌘C'), ('Paste', '⌘V')],
    [('Copy Path', '⌥⌘C'), ('Copy Relative Path', '⇧⌥⌘C')],
    ['Copy Remote File URL', 'Open on Remote (Web)'],
    [('Rename...', 'F2'), ('Delete', '⌘⌫')],
]
FILE_GROUPS[0][0] = ('Reveal in Finder', '⌥⌘R')

# 5. Sending files to Claude Code or Codex
menu = menu_html(250, 190, [
    ['Add to Claude Chat', 'Add to Codex Chat', 'Copy to AI Chat'],
    ['Open Changes', 'Open File', ('Open to the Side', '⌘⏎')],
    FILE_GROUPS[0],
    ['Select for Compare', 'Compare Selected', 'Open Timeline'],
] + FILE_GROUPS[1:], 'Add to Claude Chat')
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + '<div class="sec"><span class="tw">' + ci('chevron-down') + '</span>' + PROJECT + '<span class="acts">' + ci('new-file') + ci('new-folder') + FILTER_ON + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all') + '</span></div>'
    + '<div style="padding:6px 20px 8px;color:#9d9d9d;font-size:12px">Showing changed files · 5 of 299 repos</div>'
    + row(0, 'open', 'services', '4 repos · !2 ●2')
    + row(1, 'open', 'api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
    + row(2, 'open', 'src')
    + frow(3, 'index.ts', 'M').replace('<div class="row"', '<div class="row sel"', 1)
    + frow(3, 'routes.ts', 'A', 'staged').replace('<div class="row"', '<div class="row sel"', 1)
    + frow(2, 'NOTES.md', 'U')
    + frow(2, 'README.md', 'M')
    + row(1, 'closed', 'billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
    + row(1, 'closed', 'reports', '⎇ main · ?12', '9+', 'am')
    + menu)
chat = ('<div class="tabs"><div class="tab">Claude Code</div></div>'
    '<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:16px">'
    '<div style="color:#9d9d9d;font-size:12px;margin:0 0 8px 150px">Files are added to the message box. Nothing is sent until you press Enter.</div>'
    '<div style="border:1px solid #0078d4;border-radius:8px;background:#252526;padding:10px 12px;min-height:84px;font-size:13px;line-height:1.9;margin-left:150px">'
    '<span style="background:#264f78;border-radius:4px;padding:1px 6px;color:#e7e7e7">@services/api-gateway/src/index.ts</span> '
    '<span style="background:#264f78;border-radius:4px;padding:1px 6px;color:#e7e7e7">@services/api-gateway/src/routes.ts</span> '
    '<span style="color:#cccccc">review these changes before I push</span><span style="border-left:1px solid #fff;margin-left:1px">&nbsp;</span>'
    '</div></div>')
html = chrome('470px', side, chat, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
caps = ('<div class="cap" style="left:250px;top:170px">1  Select files, right-click</div>'
        '<div class="cap" style="left:840px;top:712px">2  Files land in the chat box</div>')
open('chat.html', 'w').write(html.replace('</body>', caps + '</body>'))

# 6. Right-click menu on a repo, and the branch picker
REPO_GROUPS = [['Switch Branch...'], ['Copy to AI Chat'],
               ['Open in Source Control', 'View All Changes'], ['Fetch', 'Pull', 'Push'],
               ['Open Repo in New Window', 'Copy Branch Name'], ['New File...', 'New Folder...']]
def repo_menu(left, top, highlight):
    return menu_html(left, top, REPO_GROUPS + FILE_GROUPS[:1] + [[('Find in Folder...', '⇧⌥F')]] + FILE_GROUPS[1:], highlight)
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + sec(PROJECT, '', ci('new-file') + ci('new-folder') + ci('circle-outline') + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all'))
    + repo_explorer() + repo_menu(250, 178, 'Switch Branch...'))
html = chrome('470px', side, EDITOR, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
open('menu.html', 'w').write(html)

def qp_real(icon, label, desc='', hl=False, color=''):
    bg = 'background:#04395e;outline:1px solid #0078d4;outline-offset:-1px;' if hl else ''
    d = f'<span style="color:#9d9d9d;margin-left:10px;font-size:12px">{desc}</span>' if desc else ''
    return (f'<div style="{bg}height:24px;display:flex;align-items:center;padding:0 10px;font-size:13px">'
            f'<span style="width:22px;{color}">{ci(icon)}</span><span>{label}</span>{d}</div>')
def qp_group(text):
    return (f'<div style="display:flex;align-items:center;gap:8px;padding:0 10px;height:20px;color:#9d9d9d;font-size:11px">'
            f'<span style="flex:1;border-top:1px solid #3c3c3c"></span>{text}</div>')
picker = ('<div style="position:absolute;left:520px;top:6px;width:600px;background:#252526;border:1px solid #454545;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.6);z-index:20;padding-bottom:6px">'
    '<div style="text-align:center;font-size:12px;color:#cccccc;padding:6px 0 4px">Switch branch in services/auth-service</div>'
    '<div style="margin:0 8px 6px;height:26px;border:1px solid #0078d4;background:#313131;border-radius:2px;display:flex;align-items:center;padding:0 6px;color:#989898;font-size:13px">Pick a branch or type to search · current: feat/sso</div>'
    + qp_real('plus', 'Create new branch…')
    + qp_real('plus', 'Create new branch from…')
    + qp_group('local branches')
    + qp_real('check', 'feat/sso', 'current · ↑2 · 2 hours ago')
    + qp_real('git-branch', 'main', '↓4 behind origin/main · 3 days ago', hl=True)
    + qp_real('git-branch', 'fix/timeout', '1 week ago')
    + qp_group('remote branches')
    + qp_real('cloud', 'origin/feat/payments', 'not checked out · 5 hours ago')
    + qp_real('cloud', 'origin/release/2.4', 'not checked out · 2 weeks ago')
    + '</div>')
side = ('<div class="vt">MULTI-REPO EXPLORER</div>'
    + sec(PROJECT, '', ci('new-file') + ci('new-folder') + ci('circle-outline') + ci('arrow-up') + ci('arrow-down') + ci('refresh') + ci('collapse-all'))
    + row(0, 'closed', 'archive', '287 repos · all clean')
    + row(0, 'closed', 'frontend', '3 repos · ●1')
    + row(0, 'open', 'services', '9 repos · !2 ●2 ↑2 ↓2')
    + row(1, 'closed', 'api-gateway', '⎇ main · ●2 +1 ?1', '4', 'am')
    + row(1, 'closed', 'auth-service', '⎇ feat/sso · ↑2 · ≡1', '↑2', 'bl', extra='sel')
    + row(1, 'closed', 'billing', '⎇ main · MERGING · ✕1 · ↑1', '!', 'rd')
    + row(1, 'closed', 'catalog', '⎇ topic · REBASING 1/2 · ✕1', '!', 'rd')
    + row(1, 'closed', 'mobile-api', '⎇ fix/login · no upstream', '↑', 'bl')
    + row(1, 'closed', 'notification', '⎇ main')
    + row(1, 'closed', 'payments', '⎇ main · ↑2 ↓3', '↕', 'pu')
    + picker)
html = chrome('470px', side, EDITOR, STATUS_LEFT, STATUS_RIGHT, 'sample-ws — Visual Studio Code')
html = html.replace('grid-template-rows:30px 1fr 22px', 'grid-template-rows:30px minmax(0,1fr) 22px')
open('switch-branch.html', 'w').write(html)
