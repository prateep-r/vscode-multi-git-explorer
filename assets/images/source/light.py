"""Re-themes a page drawn by draw.py as VS Code's Light Modern theme: light.py <in.html> <out.html>"""
import re, sys
LIGHT = """
<style>
body{background:#ffffff!important;color:#3b3b3b!important}
.title,.act,.side,.tabs,.status{background:#f8f8f8!important;color:#3b3b3b!important;border-color:#e5e5e5!important}
.title{color:#3b3b3b!important}
.act .a{color:#616161!important}.act .a.on{color:#1f1f1f!important;border-left-color:#005fb8!important}
.ed{background:#ffffff!important}.tab{background:#ffffff!important;color:#3b3b3b!important;border-top-color:#005fb8!important;border-right-color:#e5e5e5!important}
.vt,.sec,.row .tw,.sec .acts{color:#3b3b3b!important}.sec{border-top-color:#e5e5e5!important}
.row .ds,.sec .d,.crumbs{color:#717171!important}
.sel{background:#e4e6f1!important;outline-color:#005fb8!important}.hov{background:#f2f2f2!important}
.am{color:#895503!important}.rd{color:#ad0707!important}.gr{color:#007100!important}.bl{color:#1a6fd1!important}.pu{color:#a31ba3!important}.mu{color:#8e8e90!important}
.code,.code div{color:#3b3b3b!important}.ln{color:#6e7681!important}
.k{color:#0000ff!important}.s{color:#a31515!important}.f{color:#795e26!important}.t{color:#267f99!important}.v{color:#001080!important}
.status .it{color:#3b3b3b!important}
.tip{background:#f8f8f8!important;border-color:#c8c8c8!important;color:#3b3b3b!important;box-shadow:0 2px 8px rgba(0,0,0,.16)!important}
.menu{background:#ffffff!important;border-color:#cecece!important;box-shadow:0 4px 14px rgba(0,0,0,.18)!important}
.mi{color:#3b3b3b!important}.mi.hl{background:#005fb8!important;color:#fff!important}.msep{background:#e5e5e5!important}
.lb[style*="line-through"]{color:#ad0707!important}
</style>"""
src, dst = sys.argv[1], sys.argv[2]
html = open(src).read()
# Diff panes and quick pick use inline dark colors.
html = html.replace('rgba(155,185,85,.18)', 'rgba(156,204,44,.25)').replace('rgba(255,0,0,.16)', 'rgba(255,0,0,.18)')
html = html.replace('rgba(155,185,85,.45)', 'rgba(156,204,44,.5)').replace('rgba(204,204,204,.08)', 'rgba(0,0,0,.06)')
html = html.replace('border-right:1px solid #2b2b2b', 'border-right:1px solid #e5e5e5').replace('color:#cccccc', 'color:#3b3b3b')
html = html.replace('<span style="color:#ffffff">', '<span style="color:#1f1f1f">')
html = html.replace('color:#b5cea8', 'color:#098658')
html = html.replace('</head>', LIGHT + '</head>')
open(dst, 'w').write(html)
