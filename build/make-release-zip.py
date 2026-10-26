# -*- coding: utf-8 -*-
"""把发行版目录打成一个 zip，方便整包拷到另一台电脑。

用法：python build/make-release-zip.py

设计要点：

1) **按文件类型分别处理压缩**：
   jpg/mp3/mp4/glb 这些**本来就是压缩过的**，再 DEFLATE 一遍只会白烧 CPU
   （几乎压不动），所以直接 STORED；js/css/html/json 是文本，压得动，用 DEFLATE。
   674MB 的包里绝大多数是媒体，这样能把打包时间从几分钟压到几十秒。

2) **中文文件名必须能被资源管理器正确解开**：
   zip 规范里非 ASCII 名要置 UTF-8 标志位（bit 11），Python 的 zipfile 会自动做。
   打完必须**回读验证**（列出条目 + 试读一个中文路径的条目），不能只看"没报错"。

3) **包内保留一层顶层目录**（`AI学习训练助手/`），解压出来是一个文件夹，
   而不是把 2133 个文件直接倒进用户的桌面。

4) 顺带算 SHA256，方便拷贝后校验有没有传坏。
"""

import hashlib
import io
import os
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
# ⚠️ 要退**两层**：HERE = <root>/daily-writing-pc/build，
#    退一层是 daily-writing-pc，release/ 在**工作区根目录**下（和 daily-writing-pc 平级）。
RELEASE_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "release")
SRC = os.path.join(RELEASE_DIR, "AI学习训练助手")
OUT = os.path.join(RELEASE_DIR, "AI学习训练助手.zip")

# 已经压缩过的格式：不要再压，直接存
STORED_EXT = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
    ".mp3", ".mp4", ".m4a", ".aac", ".ogg", ".wav",
    ".glb", ".gltf", ".zip", ".7z", ".rar",
    ".wasm", ".tflite", ".woff", ".woff2", ".ttf",
    ".exe", ".dll", ".dylib", ".so",
}

TOP = "AI学习训练助手"          # zip 内的顶层目录名


def human(n):
    return "%.1f MB" % (n / 1024.0 / 1024.0)


def main():
    if not os.path.isdir(SRC):
        print("[X] 找不到发行包：%s\n    先跑 build/make-release.py" % SRC)
        return 2

    files = []
    total = 0
    for root, dirs, fs in os.walk(SRC):
        dirs.sort()
        for f in sorted(fs):
            fp = os.path.join(root, f)
            rel = os.path.relpath(fp, SRC).replace(os.sep, "/")
            files.append((fp, TOP + "/" + rel))
            total += os.path.getsize(fp)

    print("源目录 : %s" % SRC)
    print("输出   : %s" % OUT)
    print("待打包 : %d 个文件，%s" % (len(files), human(total)))
    print()

    if os.path.exists(OUT):
        os.remove(OUT)

    t0 = time.time()
    n_stored = n_deflated = 0
    with zipfile.ZipFile(OUT, "w", allowZip64=True) as z:
        for i, (fp, arc) in enumerate(files, 1):
            ext = os.path.splitext(fp)[1].lower()
            if ext in STORED_EXT:
                z.write(fp, arc, compress_type=zipfile.ZIP_STORED)
                n_stored += 1
            else:
                # 文本用 6 级：压缩率已接近最优，再高只慢不划算
                z.write(fp, arc, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
                n_deflated += 1
            if i % 300 == 0:
                pct = i * 100.0 / len(files)
                print("  ... %d/%d (%.0f%%)  已用 %.0fs" % (i, len(files), pct, time.time() - t0))
    dt = time.time() - t0
    size = os.path.getsize(OUT)
    print()
    print("打包完成：%s  (%.1fs)" % (human(size), dt))
    print("  直存 %d 个 / 压缩 %d 个" % (n_stored, n_deflated))

    # ---------- 回读验证（不能只看"没报错"） ----------
    print()
    print("回读验证：")
    problems = []
    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        if bad:
            problems.append("条目损坏：%s" % bad)
        names = z.namelist()
        if len(names) != len(files):
            problems.append("条目数对不上：zip 里 %d，源目录 %d" % (len(names), len(files)))

        # 1) 中文目录名（UTF-8 标志位）真的能读
        zh_dir = TOP + "/体能训练动作演示/"
        zh_entries = [n for n in names if n.startswith(zh_dir)]
        if not zh_entries:
            problems.append("中文目录 %s 在 zip 里找不到" % zh_dir)
        else:
            print("  中文目录条目：%d 个（例：%s）" % (len(zh_entries), zh_entries[0].split("/")[-1]))

        # 2) 启动脚本在，且真能解出内容
        for key in (TOP + "/启动.bat", TOP + "/index.html", TOP + "/README.txt"):
            if key not in names:
                problems.append("缺条目：%s" % key)
        try:
            data = z.read(TOP + "/启动.bat")
            if len(data) < 1000:
                problems.append("启动.bat 解出来只有 %d 字节" % len(data))
            if b"\xef\xbb\xbf" in data[:3]:
                problems.append("启动.bat 带 BOM")
        except Exception as e:
            problems.append("读 启动.bat 失败：%s" % e)

        # 3) 3D 模型要能解出完整大小
        glb = TOP + "/体能训练动作演示/体感跟练模型.glb"
        if glb not in names:
            problems.append("缺 3D 模型：%s" % glb)
        else:
            info = z.getinfo(glb)
            raw = z.read(glb)
            if len(raw) != info.file_size or len(raw) < 100 * 1024:
                problems.append("3D 模型解出异常：%d 字节" % len(raw))
            else:
                print("  3D 模型解出：%d 字节 OK" % len(raw))

    if problems:
        print()
        for p in problems:
            print("  [X] %s" % p)
        print("!! zip 验证未通过 !!")
        return 1
    print("  [OK] 条目数一致、无损坏、中文名与关键文件均可正常解出")

    # ---------- SHA256（拷贝后校验用） ----------
    h = hashlib.sha256()
    with open(OUT, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    digest = h.hexdigest()
    print()
    print("SHA256 : %s" % digest)
    # ⚠️ 这里**不能**用 ascii 编码写 —— 文件名是中文，ascii 编不出来会直接抛
    #    UnicodeEncodeError（本轮踩过）。用 utf-8：`sha256sum -c` 在 Git Bash /
    #    Linux 下按 UTF-8 读，能正确匹配中文文件名。
    with io.open(OUT + ".sha256.txt", "w", encoding="utf-8", newline="\n") as f:
        f.write("%s  AI学习训练助手.zip\n" % digest)

    print()
    print("完成：%s" % OUT)
    print("      %s（压缩前 %s，省 %.1f%%）" % (human(size), human(total), (1 - size * 1.0 / total) * 100))
    return 0


if __name__ == "__main__":
    sys.exit(main())
