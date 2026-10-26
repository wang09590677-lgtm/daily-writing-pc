# -*- coding: utf-8 -*-
"""核实 Profile 1 里本应用的访问记录到底是谁产生的：
  · 若是用户手动打开 → 说明用户确实在用普通 Chrome（根因成立）
  · 若是我的测试污染 → 说明我的测试用了真实 profile（要修测试，且根因需重判）
只读 History，不导出无关数据。"""
import os
import shutil
import sqlite3
import tempfile
import datetime

PATH = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data\Profile 1\History")
tmp = os.path.join(tempfile.gettempdir(), "h_prof1.sqlite")
shutil.copy2(PATH, tmp)
con = sqlite3.connect(tmp)
cur = con.cursor()


def when(t):
    return datetime.datetime.fromtimestamp(t / 1e6 - 11644473600).strftime("%m-%d %H:%M:%S") if t else "?"


print("=== Profile 1 最近 25 条访问记录（看是否有测试特征）===")
cur.execute("SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 25")
for url, title, vc, t in cur.fetchall():
    print("  [%s] x%-3d %s" % (when(t), vc, url[:95]))

print()
print("=== 本应用的全部访问记录 ===")
cur.execute("""SELECT url, title, visit_count, last_visit_time FROM urls
               WHERE url LIKE '%daily-writing-pc%' ORDER BY last_visit_time DESC""")
rows = cur.fetchall()
for url, title, vc, t in rows:
    print("  [%s] x%-3d %s" % (when(t), vc, url[:95]))
print("  共 %d 条记录" % len(rows))

print()
print("=== Profile 1 里有没有任何测试痕迹？(about:blank / data: / 我们的测试页) ===")
cur.execute("""SELECT COUNT(*) FROM urls WHERE url LIKE 'data:%' OR url LIKE '%__setPerson%'
               OR url LIKE 'about:%'""")
print("  data:/about: 类记录数 =", cur.fetchone()[0])

con.close()
os.remove(tmp)
