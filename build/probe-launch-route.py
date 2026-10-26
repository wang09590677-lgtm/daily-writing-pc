# -*- coding: utf-8 -*-
"""只读检查：用户平时是用哪条路径打开本应用的？
这决定了「为什么还会被反复问摄像头权限」。

思路：Chrome 会把访问过的 URL 记进 History（SQLite）。
  · 若出现在**专用 profile**（%LOCALAPPDATA%\WritingCoachChrome）里
    → 说明用户走的是 start-app.bat（那里面有 --use-fake-ui-for-media-stream，
      理论上不该再弹权限框）。
  · 若出现在**默认 profile**（User Data\Default）里
    → 说明用户直接双击了 index.html 或用了别的快捷方式，没走 bat，
      于是既没有自动允许权限、MediaPipe 也加载不了（file:// 无 flag）。
只查与本应用相关的 URL，不导出无关历史。
"""
import os
import shutil
import sqlite3
import tempfile

APPS = ["daily-writing-pc", "index.html", "WritingCoach", "start-app"]

PROFILES = {
    "专用 profile（走 bat 才会有）": os.path.expandvars(
        r"%LOCALAPPDATA%\WritingCoachChrome\Default\History"),
    "默认 profile（直接开 index.html 落这里）": os.path.expandvars(
        r"%LOCALAPPDATA%\Google\Chrome\User Data\Default\History"),
    "Profile 1": os.path.expandvars(
        r"%LOCALAPPDATA%\Google\Chrome\User Data\Profile 1\History"),
}

for label, path in PROFILES.items():
    print("=" * 72)
    print(label)
    print("  路径:", path)
    if not os.path.exists(path):
        print("  → 不存在（该 profile 从未被用过）")
        continue

    # Chrome 运行时 History 被锁；复制一份到临时文件再读
    tmp = os.path.join(tempfile.gettempdir(), "hist_probe_%d.sqlite" % abs(hash(label)))
    try:
        shutil.copy2(path, tmp)
    except Exception as e:
        print("  → 复制失败:", e)
        continue

    try:
        con = sqlite3.connect(tmp)
        cur = con.cursor()
        # 只看与本应用/本地文件相关的访问
        cur.execute("""
            SELECT url, title, visit_count, last_visit_time
            FROM urls
            WHERE url LIKE '%daily-writing-pc%'
               OR url LIKE '%start-app%'
               OR url LIKE 'file://%index.html%'
            ORDER BY last_visit_time DESC LIMIT 12
        """)
        rows = cur.fetchall()
        if not rows:
            print("  → 没有本应用的访问记录")
        for url, title, vc, t in rows:
            # Chrome 时间戳：1601-01-01 起算的微秒
            ts = (t / 1e6) - 11644473600 if t else 0
            import datetime
            when = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if ts else "?"
            print("  [%s] 访问%d次  %s" % (when, vc, url[:110]))
        con.close()
    except Exception as e:
        print("  → 读取失败:", e)
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
