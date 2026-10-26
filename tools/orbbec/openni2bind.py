# -*- coding: utf-8 -*-
"""
OpenNI2 的极简 ctypes 绑定（不依赖任何 pip 包）

把探测脚本、调参脚本、后面要写的深度桥接服务都统一到这里，避免各写一份。
结构体字段顺序严格照抄：
    Win64-Release/sdk/Include/OniCTypes.h
    Win64-Release/sdk/Include/OniCEnums.h
    Win64-Release/sdk/Include/OniCProperties.h
"""

import os
import ctypes

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_ROOT = os.path.normpath(os.path.join(
    HERE, "..", "openni",
    "OpenNI_2.3.0.86_202210111950_4c8f5aa4_beta6_windows", "Win64-Release"))
# 优先用 tools/orbbec/runtime（里面放着为训练场景调过的 orbbec.ini），
# 找不到再退回 SDK 原始目录。改配置请改 runtime 那份，不要动 SDK。
RUNTIME_DIR = os.path.join(HERE, "runtime")
RUNTIME_DLL = os.path.join(RUNTIME_DIR, "OpenNI2.dll")
LIB_DIR = RUNTIME_DIR if os.path.isfile(RUNTIME_DLL) else os.path.join(SDK_ROOT, "sdk", "libs")
DLL_PATH = os.path.join(LIB_DIR, "OpenNI2.dll")

# ONI_CREATE_API_VERSION(major, minor) == major*1000 + minor
ONI_API_VERSION = 2 * 1000 + 3

ONI_SENSOR_IR = 1
ONI_SENSOR_COLOR = 2
ONI_SENSOR_DEPTH = 3

ONI_PIXEL_FORMAT_DEPTH_1_MM = 100
ONI_PIXEL_FORMAT_RGB888 = 200
ONI_PIXEL_FORMAT_GRAY16 = 203

# ---- 属性 ----
ONI_DEVICE_PROPERTY_FIRMWARE_VERSION = 0
ONI_DEVICE_PROPERTY_HARDWARE_VERSION = 2
ONI_DEVICE_PROPERTY_SERIAL_NUMBER = 3
ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION = 5

# Orbbec 私有扩展（OniCProperties.h）
OBEXTENSION_ID_IR_GAIN = 11
OBEXTENSION_ID_IR_EXP = 12
OBEXTENSION_ID_LDP_EN = 13        # 激光散斑投影器开关 —— 结构光深度就靠它
OBEXTENSION_ID_CAM_PARAMS = 14
OBEXTENSION_ID_LASER_EN = 15
OBEXTENSION_ID_SERIALNUMBER = 16
OBEXTENSION_ID_DEVICETYPE = 17

ONI_STREAM_PROPERTY_VIDEO_MODE = 3
ONI_STREAM_PROPERTY_MIRRORING = 7

SENSOR_NAMES = {ONI_SENSOR_IR: "IR", ONI_SENSOR_COLOR: "Color", ONI_SENSOR_DEPTH: "Depth"}
PIXEL_NAMES = {
    100: "DEPTH_1_MM", 101: "DEPTH_100_UM", 102: "SHIFT_9_2", 103: "SHIFT_9_3",
    200: "RGB888", 201: "YUV422", 202: "GRAY8", 203: "GRAY16", 204: "JPEG", 205: "YUYV",
}


class OniVideoMode(ctypes.Structure):
    _fields_ = [("pixelFormat", ctypes.c_int),
                ("resolutionX", ctypes.c_int),
                ("resolutionY", ctypes.c_int),
                ("fps", ctypes.c_int)]


class OniSensorInfo(ctypes.Structure):
    _fields_ = [("sensorType", ctypes.c_int),
                ("numSupportedVideoModes", ctypes.c_int),
                ("pSupportedVideoModes", ctypes.POINTER(OniVideoMode))]


class OniDeviceInfo(ctypes.Structure):
    _fields_ = [("uri", ctypes.c_char * 256),
                ("vendor", ctypes.c_char * 256),
                ("name", ctypes.c_char * 256),
                ("serialNumber", ctypes.c_char * 256),
                ("usbVendorId", ctypes.c_uint16),
                ("usbProductId", ctypes.c_uint16)]


class OniFrame(ctypes.Structure):
    _fields_ = [("dataSize", ctypes.c_int),
                ("data", ctypes.c_void_p),
                ("sensorType", ctypes.c_int),
                ("timestamp", ctypes.c_uint64),
                ("frameIndex", ctypes.c_int),
                ("width", ctypes.c_int),
                ("height", ctypes.c_int),
                ("videoMode", OniVideoMode),
                ("croppingEnabled", ctypes.c_int),
                ("cropOriginX", ctypes.c_int),
                ("cropOriginY", ctypes.c_int),
                ("stride", ctypes.c_int)]


def dec(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace").rstrip("\x00").strip()
    return str(value)


class OpenNI2(object):
    """对 OpenNI2 C API 的一层薄封装"""

    def __init__(self, dll_path=None, lib_dir=None):
        self.dll_path = dll_path or DLL_PATH
        self.lib_dir = lib_dir or LIB_DIR
        if not os.path.isfile(self.dll_path):
            raise RuntimeError("找不到 OpenNI2.dll：%s" % self.dll_path)
        # Windows 上要让 OpenNI2.dll 找到 <自己所在目录>/OpenNI2/Drivers
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(self.lib_dir)
        os.environ["PATH"] = self.lib_dir + os.pathsep + os.environ.get("PATH", "")
        self.lib = ctypes.CDLL(self.dll_path)
        self._bind()
        self.dev = None

    # ---------------- 底层绑定 ----------------
    def _bind(self):
        L = self.lib
        L.oniInitialize.argtypes = [ctypes.c_int]
        L.oniInitialize.restype = ctypes.c_int
        L.oniShutdown.argtypes = []
        L.oniGetExtendedError.argtypes = []
        L.oniGetExtendedError.restype = ctypes.c_char_p

        L.oniGetDeviceList.argtypes = [ctypes.POINTER(ctypes.POINTER(OniDeviceInfo)),
                                       ctypes.POINTER(ctypes.c_int)]
        L.oniGetDeviceList.restype = ctypes.c_int
        L.oniReleaseDeviceList.argtypes = [ctypes.POINTER(OniDeviceInfo)]

        L.oniDeviceOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        L.oniDeviceOpen.restype = ctypes.c_int
        L.oniDeviceClose.argtypes = [ctypes.c_void_p]
        L.oniDeviceClose.restype = ctypes.c_int
        L.oniDeviceGetSensorInfo.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.oniDeviceGetSensorInfo.restype = ctypes.POINTER(OniSensorInfo)

        L.oniDeviceGetProperty.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        L.oniDeviceGetProperty.restype = ctypes.c_int
        L.oniDeviceSetProperty.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                           ctypes.c_void_p, ctypes.c_int]
        L.oniDeviceSetProperty.restype = ctypes.c_int
        L.oniDeviceIsPropertySupported.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.oniDeviceIsPropertySupported.restype = ctypes.c_int

        L.oniDeviceCreateStream.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                            ctypes.POINTER(ctypes.c_void_p)]
        L.oniDeviceCreateStream.restype = ctypes.c_int
        L.oniStreamDestroy.argtypes = [ctypes.c_void_p]
        L.oniStreamStart.argtypes = [ctypes.c_void_p]
        L.oniStreamStart.restype = ctypes.c_int
        L.oniStreamStop.argtypes = [ctypes.c_void_p]
        L.oniStreamReadFrame.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(OniFrame))]
        L.oniStreamReadFrame.restype = ctypes.c_int
        L.oniFrameRelease.argtypes = [ctypes.POINTER(OniFrame)]
        L.oniWaitForAnyStream.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_int), ctypes.c_int]
        L.oniWaitForAnyStream.restype = ctypes.c_int
        L.oniStreamGetProperty.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        L.oniStreamGetProperty.restype = ctypes.c_int
        L.oniStreamSetProperty.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                           ctypes.c_void_p, ctypes.c_int]
        L.oniStreamSetProperty.restype = ctypes.c_int

    def err(self):
        try:
            return dec(self.lib.oniGetExtendedError())
        except Exception:
            return ""

    # ---------------- 设备 ----------------
    def initialize(self):
        return self.lib.oniInitialize(ONI_API_VERSION)

    def list_devices(self):
        lst = ctypes.POINTER(OniDeviceInfo)()
        n = ctypes.c_int(0)
        st = self.lib.oniGetDeviceList(ctypes.byref(lst), ctypes.byref(n))
        out = []
        if st == 0 and n.value > 0:
            for i in range(n.value):
                d = lst[i]
                out.append({
                    "uri": d.uri,
                    "vendor": dec(d.vendor),
                    "name": dec(d.name),
                    "serial": dec(d.serialNumber),
                    "vid": d.usbVendorId,
                    "pid": d.usbProductId,
                })
        self._dev_list = lst
        return out

    def open_first(self):
        devs = self.list_devices()
        if not devs:
            return None
        h = ctypes.c_void_p()
        st = self.lib.oniDeviceOpen(devs[0]["uri"], ctypes.byref(h))
        if st != 0:
            return None
        self.dev = h
        return devs[0]

    def close(self):
        if self.dev:
            self.lib.oniDeviceClose(self.dev)
            self.dev = None
        if getattr(self, "_dev_list", None):
            self.lib.oniReleaseDeviceList(self._dev_list)
            self._dev_list = None

    def shutdown(self):
        self.close()
        self.lib.oniShutdown()

    # ---------------- 属性 ----------------
    def get_string_property(self, prop_id, size=256):
        buf = ctypes.create_string_buffer(size)
        n = ctypes.c_int(size)
        st = self.lib.oniDeviceGetProperty(self.dev, prop_id, buf, ctypes.byref(n))
        return (dec(buf.value) if st == 0 else None)

    def get_int_property(self, prop_id):
        v = ctypes.c_int(0)
        n = ctypes.c_int(4)
        st = self.lib.oniDeviceGetProperty(self.dev, prop_id, ctypes.byref(v), ctypes.byref(n))
        return (v.value if st == 0 else None)

    def set_int_property(self, prop_id, value):
        v = ctypes.c_int(int(value))
        return self.lib.oniDeviceSetProperty(self.dev, prop_id, ctypes.byref(v), 4)

    def supports(self, prop_id):
        try:
            return bool(self.lib.oniDeviceIsPropertySupported(self.dev, prop_id))
        except Exception:
            return False

    def sensor_modes(self, sensor_type):
        info = self.lib.oniDeviceGetSensorInfo(self.dev, sensor_type)
        if not info:
            return []
        out = []
        for i in range(info.contents.numSupportedVideoModes):
            m = info.contents.pSupportedVideoModes[i]
            out.append({"w": m.resolutionX, "h": m.resolutionY,
                        "fps": m.fps, "pixelFormat": m.pixelFormat})
        return out


class Stream(object):
    """一个 OpenNI2 流的开/读/关"""

    def __init__(self, oni, sensor_type, mode=None):
        self.oni = oni
        self.sensor = sensor_type
        self.handle = ctypes.c_void_p()
        st = oni.lib.oniDeviceCreateStream(oni.dev, sensor_type, ctypes.byref(self.handle))
        if st != 0:
            raise RuntimeError("创建流失败(%-6s) status=%d %s"
                               % (SENSOR_NAMES.get(sensor_type), st, oni.err()))
        if mode:
            vm = OniVideoMode()
            vm.pixelFormat = mode["pixelFormat"]
            vm.resolutionX = mode["w"]
            vm.resolutionY = mode["h"]
            vm.fps = mode["fps"]
            st = oni.lib.oniStreamSetProperty(self.handle, ONI_STREAM_PROPERTY_VIDEO_MODE,
                                              ctypes.byref(vm), ctypes.sizeof(vm))
            if st != 0:
                print("   [!] 设置分辨率失败 status=%d（沿用默认）" % st)
        st = oni.lib.oniStreamStart(self.handle)
        if st != 0:
            raise RuntimeError("启动流失败 status=%d %s" % (st, oni.err()))
        self.frame_ptr = ctypes.POINTER(OniFrame)()
        self.streams = (ctypes.c_void_p * 1)(self.handle)
        self.idx = ctypes.c_int(0)

    def read(self, timeout_ms=2000):
        """返回 (像素数组, 宽, 高, 元信息)；读不到返回 None"""
        st = self.oni.lib.oniWaitForAnyStream(self.streams, 1, ctypes.byref(self.idx), timeout_ms)
        if st != 0:
            return None
        st = self.oni.lib.oniStreamReadFrame(self.handle, ctypes.byref(self.frame_ptr))
        if st != 0 or not self.frame_ptr:
            return None
        f = self.frame_ptr.contents
        w, h = f.width, f.height
        fmt = f.videoMode.pixelFormat
        pixel_bytes = 2 if fmt in (100, 101, 102, 103, 203) else (3 if fmt == 200 else 2)
        n = w * h
        buf = (ctypes.c_uint16 if pixel_bytes == 2 else ctypes.c_uint8 * 0)
        data = (ctypes.c_uint16 * n).from_buffer_copy(
            ctypes.string_at(f.data, n * pixel_bytes)) if pixel_bytes == 2 else None
        meta = {"w": w, "h": h, "fmt": fmt, "index": f.frameIndex,
                "timestamp": f.timestamp, "stride": f.stride}
        self.oni.lib.oniFrameRelease(self.frame_ptr)
        return (data, w, h, meta)

    def stop(self):
        self.oni.lib.oniStreamStop(self.handle)
        self.oni.lib.oniStreamDestroy(self.handle)


def pick_mode(modes, w, h, fps, pixel_format=None):
    """从支持的模式里挑一个最接近的"""
    if not modes:
        return None
    cand = [m for m in modes if m["w"] == w and m["h"] == h]
    if pixel_format:
        same = [m for m in cand if m["pixelFormat"] == pixel_format]
        if same:
            cand = same
    cand.sort(key=lambda m: abs(m["fps"] - fps))
    return cand[0] if cand else None


def ascii_map(buf, width, height, cols=48, rows=18, max_mm=4000):
    """深度图降采样成 ASCII（越近字符越密）"""
    ramp = " .:-=+*#%@"
    out = []
    for r in range(rows):
        line = []
        for c in range(cols):
            x0 = int(c * width / cols)
            x1 = max(x0 + 1, int((c + 1) * width / cols))
            y0 = int(r * height / rows)
            y1 = max(y0 + 1, int((r + 1) * height / rows))
            vals = []
            for y in range(y0, y1, max(1, (y1 - y0) // 4)):
                base = y * width
                for x in range(x0, x1, max(1, (x1 - x0) // 4)):
                    v = buf[base + x]
                    if v > 0:
                        vals.append(v)
            if not vals:
                line.append(" ")
                continue
            k = int(min(1.0, min(vals) / float(max_mm)) * (len(ramp) - 1))
            line.append(ramp[k])
        out.append("".join(line))
    return out


def ascii_map_gray(buf, width, height, cols=48, rows=18, scale=None):
    """灰度图降采样成 ASCII（越亮字符越密）"""
    ramp = " .:-=+*#%@"
    top = scale or 1
    out = []
    for r in range(rows):
        line = []
        for c in range(cols):
            x0 = int(c * width / cols)
            x1 = max(x0 + 1, int((c + 1) * width / cols))
            y0 = int(r * height / rows)
            y1 = max(y0 + 1, int((r + 1) * height / rows))
            vals = []
            for y in range(y0, y1, max(1, (y1 - y0) // 4)):
                base = y * width
                for x in range(x0, x1, max(1, (x1 - x0) // 4)):
                    vals.append(buf[base + x])
            if not vals:
                line.append(" ")
                continue
            k = int(min(1.0, (sum(vals) / len(vals)) / float(top)) * (len(ramp) - 1))
            line.append(ramp[k])
        out.append("".join(line))
    return out
