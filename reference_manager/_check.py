#!/usr/bin/env python3
"""Throwaway harness: serve the built app outside the portal on the real document.

`vite build` wipes dist/, so run this after every build:
    python3 _check.py && open http://127.0.0.1:8124/_check.html
Not part of the app.
"""
import base64, glob, json, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
css = os.path.basename(sorted(glob.glob('dist/assets/*.css'))[0])
js = os.path.basename(sorted(glob.glob('dist/assets/*.js'))[0])
DOC = json.load(open('/Users/jungwoo/web_service/data/reference_manager/projects/papers/data.json'))

open('dist/_check.html', 'w').write('''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>check</title>
<link rel="stylesheet" href="assets/%s">
<script>
  window.__PORTAL_BASE__ = '/pp/reference_manager/check';
  var ROLE = new URLSearchParams(location.search).get('role') || 'manager';
  var b64 = function (o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o))))
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, ''); };
  localStorage.setItem('lilak_portal_token', 'x.' + b64({ email: 'check@local', role: ROLE }) + '.y');
  const DOC = %s;
  const real = window.fetch;
  const json = (v, status) => Promise.resolve(new Response(JSON.stringify(v),
    { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (u, o) => {
    if (!String(u).includes('/api/data')) return real(u, o);
    if ((o && o.method || 'GET').toUpperCase() !== 'PUT') return json(DOC);
    const b = JSON.parse(o.body);
    if (b.baseVersion !== DOC.version) return json({ detail: 'conflict', current: DOC }, 409);
    for (const k of ['references', 'journals', 'authors', 'settings'])
      if (b[k] != null) DOC[k] = b[k];
    DOC.version += 1;
    return json(DOC);
  };
</script>
</head><body><div id="root"></div><script type="module" src="assets/%s"></script></body></html>
''' % (css, json.dumps(DOC, ensure_ascii=False), js))
print('harness ready:', css, js, len(DOC['references']), 'refs')
