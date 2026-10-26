import cv2, os, json, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, "体能训练动作演示")
# 用全新的 ASCII-only 目录，彻底绕开 Windows 中文编码不一致
# （cp936/utf-8 混用会把目录名写成乱码，bash ls 与 Node fs 读到的名字对不上）
OUT = os.path.join(ROOT, "build", "_frames2")

# 用纯 ASCII 目录名
VIDEOS = [
    ("jumpingJacks", "开合跳.mp4"),
    ("squat",        "深蹲.mp4"),
    ("jumpRope",     "跳绳.mp4"),
    ("highKnees",    "原地高抬腿跑.mp4"),
    ("burpee",       "波比跳.mp4"),
]

os.makedirs(OUT, exist_ok=True)

meta = {}
for ascii_name, v in VIDEOS:
    p = os.path.join(DEMO, v)
    if not os.path.exists(p):
        print("missing", v); continue
    d = os.path.join(OUT, ascii_name)
    os.makedirs(d, exist_ok=True)
    cap = cv2.VideoCapture(p)
    n = idx = 0
    nw = nh = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        h, w = fr.shape[:2]
        nw = 512
        nh = int(round(h * nw / w))
        small = cv2.resize(fr, (nw, nh), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(d, "f%04d.jpg" % idx), small, [cv2.IMWRITE_JPEG_QUALITY, 85])
        idx += 1; n += 1
    cap.release()
    meta[ascii_name] = {"cn": v, "frames": n, "w": nw, "h": nh}
    print("%s (%s): %d frames -> %dx%d" % (ascii_name, v, n, nw, nh))

json.dump(meta, open(os.path.join(OUT, "_meta.json"), "w"), ensure_ascii=False, indent=1)
print("done")
