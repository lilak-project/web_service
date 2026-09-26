#!/usr/bin/env python3
"""Throwaway harness: serve the built app outside the portal with sample rows.

`vite build` wipes dist/, so run this after every build:
    python3 _check.py && open http://127.0.0.1:8123/_check.html
Not part of the app — delete it when the list screen is signed off.
"""
import base64, glob, json, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
css = os.path.basename(sorted(glob.glob('dist/assets/*.css'))[0])
js = os.path.basename(sorted(glob.glob('dist/assets/*.js'))[0])


def A(i, ko_f, ko_g, f, m, l, tag, pos, mail, core):
    return {'id': 'a%d' % i, 'korFamily': ko_f, 'korGiven': ko_g, 'engFirst': f, 'engMiddle': m,
            'engLast': l, 'emails': [mail], 'repEmail': mail,
            'affiliations': [{'tag': tag, 'position': pos, 'email': mail, 'since': '2020-01'}],
            'groups': [{'name': 'CENS', 'core': core}]}


ROWS = [
 ('한', '인식', 'Kevin', 'Insik', 'Hahn', 'CENS', 'Director', 'ihahn@ibs.re.kr', 1),
 ('박', '태선', 'Tae-Sun', '', 'Park', 'CENS', '', 'tspark@ibs.re.kr', 2),
 ('안', '성훈', 'Sunghoon', '', 'Ahn', 'CENS', 'Senior Research Fellow', 'ahnt@ibs.re.kr', 2),
 ('김', '영만', 'Youngman', '', 'Kim', 'CENS', 'Senior Research Fellow', 'ykim@ibs.re.kr', 2),
 ('김', '용희', 'Yunghee', '', 'Kim', 'CENS', 'Senior Research Fellow', 'yunghee.kim@ibs.re.kr', 2),
 ('유', '병길', 'Yu', '', 'ByungGil', 'KAU', '', 'bgyu@kau.ac.kr', 3),
 ('허', '장용', 'Jangyong', '', 'Huh', 'CENS', 'Technical Stuff', 'jangyong.huh@ibs.re.kr', 4),
 ('이', '혜영', 'Hyeyoung', '', 'LEE', 'CENS', 'Senior Research Fellow', 'hylee@ibs.re.kr', 4),
 ('하', '정수', 'Jeongsu', '', 'HA', 'CENS', 'Young Scientist Fellow', 'jeongsu.ha@ibs.re.kr', 5),
 ('김', '선지', 'Sunji', '', 'Kim', 'CENS', 'Senior Research Fellow', 'sunjikim@ibs.re.kr', 6),
 ('문', '별', 'Byul', '', 'Moon', 'CENS', 'Senior Research Fellow', 'mb0316@ibs.re.kr', 6),
 ('황', '종원', 'Jongwon', '', 'Hwang', 'CENS', 'Senior Research Fellow', 'jwhwang@ibs.re.kr', 6),
 ('차', '수미', 'Soomi', '', 'CHA', 'CENS', 'Senior Research Fellow', 'soomicha@ibs.re.kr', 6),
 ('김', '명국', 'Myungkuk', '', 'KIM', 'CENS', 'Senior Researcher', 'myung.k.kim@ibs.re.kr', 6),
 ('이', '정우', 'Jung', 'Woo', 'LEE', 'CENS', 'Senior Research Fellow', 'ejungwoo@ibs.re.kr', 6),
 ('원', '준호', 'Junho', '', 'Won', 'CENS', 'Postdoctoral Researcher', 'wonder112@ibs.re.kr', 6),
 ('아루니타', '', 'Arunita', '', 'MUKHERJEE', 'CENS', 'Postdoctoral Researcher', 'arunita@ibs.re.kr', 6),
 ('지펭', '', 'Zifeng', '', 'LUO', 'CENS', 'Senior Research Fellow', 'luozf@ibs.re.kr', 6),
]
DOC = {'version': 1, 'authors': [A(i, *r) for i, r in enumerate(ROWS)],
       'affiliations': [{'name': 'CENS'}, {'name': 'KAU'}],
       'groups': [{'name': 'CENS', 'core': 1}]}
TOK = ('x.' + base64.urlsafe_b64encode(
    json.dumps({'email': 'check@local', 'role': 'manager'}).encode()).decode().rstrip('=') + '.y')

open('dist/_check.html', 'w').write('''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>check</title>
<link rel="stylesheet" href="assets/%s">
<script>
  window.__PORTAL_BASE__ = '/pp/author_manager/check';
  localStorage.setItem('lilak_portal_token', %s);
  const DOC = %s;
  const real = window.fetch;
  window.fetch = (u, o) => (String(u).includes('/api/data')
    ? Promise.resolve(new Response(JSON.stringify(DOC), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : real(u, o));
</script>
</head><body><div id="root"></div><script type="module" src="assets/%s"></script></body></html>
''' % (css, json.dumps(TOK), json.dumps(DOC, ensure_ascii=False), js))
print('harness ready:', css, js)
