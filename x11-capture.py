"""Read a Terminal-managed X display and save a PNG or a VP8 WebM recording."""
import io
import json
import os
import signal
import struct
import sys
import time

from PIL import Image, ImageGrab

VIDEO_LIMIT = 15 * 1024 * 1024
PNG_LIMIT = 2 * 1024 * 1024
FRAME_INTERVAL = 1 / 8
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


def uint(value):
    return value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big")


def size(value, width=None):
    if width is None:
        width = max(1, (value.bit_length() + 6) // 7)
        if value == (1 << (width * 7)) - 1:
            width += 1
    return ((1 << (width * 7)) | value).to_bytes(width, "big")


def element(tag, data):
    return bytes.fromhex(tag) + size(len(data)) + data


def ebml_uint(tag, value):
    return element(tag, uint(value))


def vp8_frame(frame):
    buffer = io.BytesIO()
    frame.save(buffer, "WEBP", lossless=False, quality=62, method=2)
    raw = buffer.getvalue()
    offset = 12
    while offset + 8 <= len(raw):
        tag, length = struct.unpack_from("<4sI", raw, offset)
        start = offset + 8
        if tag == b"VP8 " and start + length <= len(raw):
            return raw[start : start + length]
        offset = start + length + (length & 1)
    raise ValueError("未生成有效的 VP8 帧")


def write_header(output, width, height):
    output.write(element("1a45dfa3", b"".join((
        ebml_uint("4286", 1), ebml_uint("42f7", 1), ebml_uint("42f2", 4),
        ebml_uint("42f3", 8), element("4282", b"webm"),
        ebml_uint("4287", 2), ebml_uint("4285", 2),
    ))))
    output.write(bytes.fromhex("18538067"))
    segment_size = output.tell()
    output.write(b"\x01" + b"\xff" * 7)
    segment_start = output.tell()
    info = b"".join((
        ebml_uint("2ad7b1", 1_000_000), element("4d80", b"Aide Terminal"),
        element("5741", b"Aide Terminal"), element("4489", struct.pack(">d", 0)),
    ))
    output.write(element("1549a966", info))
    duration_offset = output.tell() - 8
    video = element("e0", ebml_uint("b0", width) + ebml_uint("ba", height))
    track = b"".join((
        ebml_uint("d7", 1), ebml_uint("73c5", 1), ebml_uint("83", 1),
        ebml_uint("9c", 0), element("86", b"V_VP8"), video,
        ebml_uint("23e383", round(FRAME_INTERVAL * 1_000_000_000)),
    ))
    output.write(element("1654ae6b", element("ae", track)))
    return segment_size, segment_start, duration_offset


def screenshot(output, grab):
    image = grab()
    image.thumbnail((1600, 1000), Image.Resampling.LANCZOS)
    while True:
        buffer = io.BytesIO()
        image.save(buffer, "PNG", compress_level=3)
        if buffer.tell() <= PNG_LIMIT:
            output.write(buffer.getbuffer())
            return {"width": image.width, "height": image.height}
        image.thumbnail((image.width * 3 // 4, image.height * 3 // 4), Image.Resampling.LANCZOS)


def record(output, grab, seconds):
    original = grab()
    original.thumbnail((1120, 840), Image.Resampling.BILINEAR)
    dimensions = original.size
    segment_size, segment_start, duration_offset = write_header(output, *dimensions)
    started = time.monotonic()
    frames = 0
    timestamp = 0
    frame = original
    reason = "duration"
    while True:
        cluster_time = time.monotonic() - started
        timestamp_next = max(timestamp + (1 if frames else 0), round(cluster_time * 1000))
        block = element("a3", b"\x81\x00\x00\x80" + vp8_frame(frame))
        cluster = element("1f43b675", ebml_uint("e7", timestamp_next) + block)
        if output.tell() + len(cluster) > VIDEO_LIMIT:
            reason = "size"
            break
        output.write(cluster)
        frames += 1
        timestamp = timestamp_next
        if frames == 1:
            print("ready", flush=True)
        if stopping:
            reason = "stopped"
            break
        elapsed = time.monotonic() - started
        if elapsed + FRAME_INTERVAL > seconds:
            break
        time.sleep(max(0, FRAME_INTERVAL - (elapsed - cluster_time)))
        if os.getppid() == 1:
            raise RuntimeError("终端工作进程已退出")
        if stopping:
            reason = "stopped"
            break
        try:
            frame = grab().resize(dimensions, Image.Resampling.BILINEAR)
        except OSError:
            reason = "display-ended"
            break
    if not frames:
        raise ValueError("录制没有产生画面")
    duration = timestamp + round(FRAME_INTERVAL * 1000)
    end = output.tell()
    output.seek(segment_size)
    output.write(size(end - segment_start, 8))
    output.seek(duration_offset)
    output.write(struct.pack(">d", duration))
    return {"width": dimensions[0], "height": dimensions[1], "frames": frames,
            "durationMs": duration, "reason": reason}


def main():
    kind, destination, seconds = sys.argv[1:]
    signal.signal(signal.SIGTERM, stop)
    display = os.environ["DISPLAY"]

    def grab():
        # An explicit xdisplay keeps Pillow from falling back to the host desktop.
        return ImageGrab.grab(xdisplay=display).convert("RGB")

    fd = os.open(destination, os.O_WRONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "wb") as output:
        result = screenshot(output, grab) if kind == "png" else record(output, grab, int(seconds))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
