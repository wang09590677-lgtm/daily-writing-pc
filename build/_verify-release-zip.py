# -*- coding: utf-8 -*-
"""zip 出厂验收：把压缩包**真的完整解压一遍**，逐文件比对源目录。

为什么不能只看 `testzip()`：
  `testzip()` 只校验 CRC，它证明"数据没坏"，但**不证明"解出来和原目录一样"** ——
  条目名写错、路径层级错、同名文件互相覆盖、少打包文件，它全都不报。
  而用户拿到的是 zip，他解压出来的东西**必须逐字节等于**我们验收过的那份目录
  （那份目录已经过了 verify-release.py 的 52/52）。

所以这里做的是**最笨也最可靠**的比对：解压到全新临时目录 → 递归对比
文件名集合 + 每个文件的字节数（外加关键文件的内容哈希）。
"""

import hashlib
import io
import os
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
RELEASE_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "release")
SRC = os.path.join(RELEASE_DIR, "AI学习训练助手")
ZIP = os.path.join(RELEASE_DIR, "AI学习训练助手.zip")

PASS = 0
FAIL = 0


def ck(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s%s" % (name, ("  -> " + str(extra)) if extra else ""))


def sha256(fp, limit=None):
    h = hashlib.sha256()
    with open(fp, "rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
            if limit and f.tell() > limit:
                break
    return h.hexdigest()


def main():
    if not os.path.isfile(ZIP):
        print("[X] 找不到 zip：%s" % ZIP)
        return 2

    print("zip    : %s (%.1f MB)" % (ZIP, os.path.getsize(ZIP) / 1048576.0))
    print("参照源 : %s" % SRC)
    print()

    work = tempfile.mkdtemp(prefix="ziptest-")
    try:
        print("=" * 60)
        print(" 一、解压到全新目录")
        print("=" * 60)
        print("  解到：%s" % work)
        with zipfile.ZipFile(ZIP) as z:
            z.extractall(work)
        root = os.path.join(work, "AI学习训练助手")
        ck("解压出顶层目录 AI学习训练助手/", os.path.isdir(root))
        ck("顶层没有散落文件（解压出来就是一个文件夹）",
           all(os.path.isdir(os.path.join(work, n)) or n.startswith("AI学习训练助手")
               for n in os.listdir(work)))

        print()
        print("=" * 60)
        print(" 二、逐文件比对（相对路径 + 字节数 + 内容哈希）")
        print("=" * 60)

        def scan(base):
            m = {}
            for r, _, fs in os.walk(base):
                for f in fs:
                    fp = os.path.join(r, f)
                    rel = os.path.relpath(fp, base).replace(os.sep, "/")
                    m[rel] = fp
            return m

        src_map = scan(SRC)
        out_map = scan(root)
        print("  源 %d 个文件 / 解出 %d 个文件" % (len(src_map), len(out_map)))

        missing = sorted(set(src_map) - set(out_map))
        extra = sorted(set(out_map) - set(src_map))
        ck("没有漏掉的文件", not missing, missing[:5])
        ck("没有多出来的文件", not extra, extra[:5])

        # 字节数全比 + 内容哈希抽样（全量哈希 674MB 太慢，抽样覆盖每类）
        size_bad = []
        for rel in sorted(set(src_map) & set(out_map)):
            if os.path.getsize(src_map[rel]) != os.path.getsize(out_map[rel]):
                size_bad.append(rel)
        ck("每个文件字节数都一致", not size_bad, size_bad[:5])

        # 抽样做内容哈希：覆盖 代码/页面/样式/数据/音频/图片/视频/模型/启动脚本
        SAMPLES = [
            "index.html", "app.js", "styles.css", "coach-timer.js",
            "data/tasks.js", "data/fitness-plan.js",
            "assets/coach/count-go.mp3",
            "assets/pictures/pic001.jpg", "assets/pictures/pic210.jpg",
            "vendor/mediapipe/pose_landmark_lite.tflite",
            "体能训练动作演示/开合跳.mp4",
            "体能训练动作演示/体感跟练模型.glb",
            "启动.bat", "README.txt",
        ]
        hash_bad = []
        for rel in SAMPLES:
            if rel not in src_map or rel not in out_map:
                hash_bad.append(rel + " (缺失)")
                continue
            if sha256(src_map[rel]) != sha256(out_map[rel]):
                hash_bad.append(rel)
        ck("抽样内容哈希一致（%d 个代表文件）" % len(SAMPLES), not hash_bad, hash_bad)

        print()
        print("=" * 60)
        print(" 三、解出来的包能直接用吗")
        print("=" * 60)
        # 启动脚本仍然是 GBK 无 BOM（过一遍 zip 不能改变它）
        bat = os.path.join(root, "启动.bat")
        raw = open(bat, "rb").read()
        ck("启动.bat 无 BOM", raw[:3] != b"\xef\xbb\xbf")
        try:
            raw.decode("gbk")
            ck("启动.bat 仍是合法 GBK（cmd 能读）", True)
        except UnicodeDecodeError as e:
            ck("启动.bat 仍是合法 GBK（cmd 能读）", False, e)
        ck("启动.bat 内容完整（>3000 字节）", len(raw) > 3000, len(raw))

        # 解压出来的目录跑一遍出厂自检（引用可达性）
        sys.path.insert(0, HERE)
        import importlib.util
        spec = importlib.util.spec_from_file_location("mr", os.path.join(HERE, "make-release.py"))
        mr = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mr)
        problems = []
        n_pic, n_img = mr.verify(root, problems)
        ck("解压后出厂自检通过（配图 %d 张）" % n_img, not problems, problems[:3])

        print()
        print("=" * 60)
        print(" 合计 %d/%d" % (PASS, PASS + FAIL))
        print("=" * 60)
        return 1 if FAIL else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
