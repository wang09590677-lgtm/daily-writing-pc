# 把 build/_frames2/<ascii>/f*.jpg 转成引擎离线复算要用的灰度裸数据
# 输出：build/_tmp/<ascii>.gray （每帧 W*H 字节，uint8，按抽取时的分辨率）
#       build/_tmp/_dims.json （每个动作的 w/h/帧数/fps）
# 目的：让纯 Node 脚本能逐帧喂真实动作帧给真实 motion-engine.js（不开浏览器）
import cv2, os, json, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FR = os.path.join(ROOT, "build", "_frames2")
OUT = os.path.join(ROOT, "build", "_tmp")
os.makedirs(OUT, exist_ok=True)

ACTS = ["jumpingJacks", "squat", "jumpRope", "highKnees", "burpee"]
dims = {}
for act in ACTS:
    d = os.path.join(FR, act)
    if not os.path.isdir(d):
        print("skip", act); continue
    files = sorted(f for f in os.listdir(d) if f.startswith("f") and f.endswith(".jpg"))
    if not files:
        print("empty", act); continue
    first = cv2.imread(os.path.join(d, files[0]))
    h, w = first.shape[:2]
    buf = bytearray()
    for f in files:
        im = cv2.imread(os.path.join(d, f))
        g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
        assert g.shape == (h, w), (f, g.shape, (h, w))
        buf += g.tobytes()
    open(os.path.join(OUT, act + ".gray"), "wb").write(bytes(buf))
    dims[act] = {"w": w, "h": h, "frames": len(files), "fps": 24}
    print("%s: %d frames %dx%d -> %.1f MB" % (act, len(files), w, h, len(buf) / 1e6))

json.dump(dims, open(os.path.join(OUT, "_dims.json"), "w"), ensure_ascii=False, indent=1)
print("done -> build/_tmp/")
