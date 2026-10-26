# -*- coding: utf-8 -*-
"""文章补写素材库 · 取材可行性探针（只读，不改产品）
统计维基文库「公版中文散文」里，篇幅 ≤600 字（可扩写到 1300 字以内、满足"隐藏≥250后再补写≥300"）
且适合小学中高年级的候选篇目有多少。
用法: python build/_probe-articles-pool.py
"""
import urllib.request, urllib.parse, json, time, re, html, sys, io, os

H = {'User-Agent': 'KidsWritingApp/1.0 (offline study tool)'}
API = 'https://zh.wikisource.org/w/api.php'

def get(**p):
    p.setdefault('format', 'json'); p.setdefault('formatversion', '2')
    u = API + '?' + urllib.parse.urlencode(p)
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=40) as r:
                return json.load(r)
        except Exception:
            if i == 3: raise
            time.sleep(2 + 3 * i)

def clean(h):
    m = re.search(r'class="prp-pages-output"[^>]*>(.*)', h, re.S)
    body = m.group(1) if m else h
    body = re.sub(r'<span[^>]*ws-pagenum[^>]*>.*?</span></span>', '', body, flags=re.S)
    body = re.sub(r'<style.*?</style>', '', body, flags=re.S)
    body = re.sub(r'<[^>]+>', '\n', body)
    body = html.unescape(body)
    paras = [re.sub(r'[ \t\u3000]+', '', p).strip() for p in body.split('\n')]
    paras = [p for p in paras if len(p) >= 20]
    return paras

CATS = ['写景游记类散文', '叙事性散文', '议论性散文', '抒情性散文']

def main():
    titles = set()
    for c in CATS:
        d = get(action='query', list='categorymembers', cmtitle='Category:' + c,
                cmlimit='500', cmnamespace='0')
        for x in d['query']['categorymembers']:
            titles.add(x['title'])
        time.sleep(1.2)
    print('分类候选条目合计: %d' % len(titles), flush=True)

    rows = []
    for i, t in enumerate(sorted(titles)):
        try:
            d = get(action='parse', page=t, prop='text')
            paras = clean(d['parse']['text'])
            n = sum(len(p) for p in paras)
            rows.append((n, len(paras), t))
            print('[%3d/%d] %4d 字 %2d 段  %s' % (i + 1, len(titles), n, len(paras), t), flush=True)
        except Exception as e:
            rows.append((-1, 0, t + ' !!' + str(e)[:30]))
            print('[%3d/%d] FAIL %s -> %s' % (i + 1, len(titles), t, type(e).__name__), flush=True)
        time.sleep(1.0)

    ok = [r for r in rows if 150 <= r[0] <= 600]
    print('全部取到正文: %d 篇（失败 %d）' % (len([r for r in rows if r[0] > 0]),
                                        len([r for r in rows if r[0] < 0])), flush=True)
    print('★ 篇幅 150~600 字（可直接扩写进 1300 字）: %d 篇' % len(ok), flush=True)
    for n, pc, t in sorted(ok, reverse=True):
        print('  %4d 字 %2d 段  %s' % (n, pc, t), flush=True)
    print('--- 超 600 字（长文，需节选）: %d 篇' % len([r for r in rows if r[0] > 600]), flush=True)
    for n, pc, t in sorted([r for r in rows if r[0] > 600], reverse=True)[:20]:
        print('  %4d 字 %2d 段  %s' % (n, pc, t), flush=True)

main()
