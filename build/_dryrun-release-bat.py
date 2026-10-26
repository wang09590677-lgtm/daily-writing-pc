# -*- coding: utf-8 -*-
"""Dry-run：把启动 bat 里带副作用的命令（start / del / wait）换成 echo，
再真跑一遍，验证"分支判断"是否按预期走到。
为什么需要：cmd 的 if/else 分支走错了**不会报错**，只会静默打印提示。
上一轮就是靠这个 30 秒发现 `.bat` 在括号块内读 `%PY%` 永远读到旧值。
用法: python build/_dryrun-release-bat.py <目标目录>
"""
import os, sys, io, re, subprocess, tempfile

def dry(src, dst):
    txt = io.open(src, encoding="gbk", errors="replace").read()
    out = []
    for line in txt.splitlines():
        s = line.strip().lower()
        if s.startswith("start ") or s == "start":
            out.append("echo [DRYRUN] " + line)
        elif s.startswith("del ") or s.startswith("rd ") or s.startswith("rmdir "):
            out.append("echo [DRYRUN] " + line)
        else:
            out.append(line)
    io.open(dst, "w", encoding="gbk", newline="\r\n").write("\r\n".join(out) + "\r\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    print("用法: python build/_dryrun-release-bat.py <release目录>")
    if target:
        print("目标: " + target)
