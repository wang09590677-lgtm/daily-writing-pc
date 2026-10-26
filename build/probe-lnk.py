# -*- coding: utf-8 -*-
"""只读解析桌面快捷方式指向什么，用来确认用户平时是双击 bat 还是 html。"""
import re, sys, os

p = r"C:\Users\lixue\Desktop\AI儿童每日写作训练.lnk"
data = open(p, "rb").read()
print("size", len(data))

found = []
# 1) LinkTargetIDList / 环境变量数据 里常以 ASCII 出现
for m in re.finditer(rb"[ -~]{3,}", data):
    found.append(("A", m.group().decode("ascii", "replace")))
# 2) UTF-16LE
s = data.decode("utf-16-le", errors="ignore")
for m in re.finditer(r"[ -~]{3,}", s):
    found.append(("U", m.group()))
# 3) GBK 硬解整段，找中文路径
try:
    g = data.decode("gbk", errors="ignore")
    for m in re.finditer(r"[ -~]{3,}", g):
        found.append(("G", m.group()))
except Exception as e:
    print("gbk fail", e)

seen = set()
for tag, txt in found:
    if txt in seen:
        continue
    seen.add(txt)
    print(tag, repr(txt))
