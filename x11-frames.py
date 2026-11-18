"""Extract chronological frames from a finalized Terminal X11 WebM recording."""
import base64
from bisect import bisect_left
import io
import json
import math
import os
import stat
import struct
import sys

from PIL import Image


VIDEO_LIMIT = 15 * 1024 * 1024
PNG_LIMIT = 900 * 1024
MAX_DURATION_MS = 130_000
MAX_REQUEST_MS = 150_000
MAX_FRAMES = 1024
INVALID_RECORDING = "不是有效的 Terminal X11 录像，或录像尚未完成"


class NoFramesError(ValueError):
    pass


def vint(data, offset, limit, keep_marker=False):
    if offset >= len(data) or data[offset] == 0:
        raise ValueError(INVALID_RECORDING)
    width = 9 - data[offset].bit_length()
    end = offset + width
    if width > limit or end > len(data):
        raise ValueError(INVALID_RECORDING)
    value = int.from_bytes(data[offset:end], "big")
    if not keep_marker:
        marker = 1 << (7 * width)
        value ^= marker
        if value == marker - 1:
            raise ValueError(INVALID_RECORDING)
    return value, end


def elements(data):
    offset = 0
    while offset < len(data):
        tag, offset = vint(data, offset, 4, keep_marker=True)
        length, offset = vint(data, offset, 8)
        end = offset + length
        if end > len(data):
            raise ValueError(INVALID_RECORDING)
        yield tag, data[offset:end]
        offset = end


def expect(rows, tag):
    row = next(rows, None)
    if row is None or row[0] != tag:
        raise ValueError(INVALID_RECORDING)
    return row[1]


def fields(data):
    result = {}
    for tag, body in elements(data):
        if tag in result or len(result) >= 16:
            raise ValueError(INVALID_RECORDING)
        result[tag] = body
    return result


def number(data):
    if not 1 <= len(data) <= 8:
        raise ValueError(INVALID_RECORDING)
    return int.from_bytes(data, "big")


def recording_frames(recording):
    """Index the single VP8 track and unlaced keyframes emitted by x11-capture.py."""
    outer = elements(memoryview(recording))
    header = fields(expect(outer, 0x1A45DFA3))
    segment = elements(expect(outer, 0x18538067))
    if header.get(0x4282) != b"webm" or next(outer, None) is not None:
        raise ValueError(INVALID_RECORDING)

    info = fields(expect(segment, 0x1549A966))
    duration_data = info.get(0x4489, b"")
    if (number(info.get(0x2AD7B1, b"")) != 1_000_000 or len(duration_data) != 8 or
            info.get(0x4D80) != b"Aide Terminal" or info.get(0x5741) != b"Aide Terminal"):
        raise ValueError(INVALID_RECORDING)
    duration = struct.unpack(">d", duration_data)[0]
    if not math.isfinite(duration) or not 1 <= duration <= MAX_DURATION_MS or not duration.is_integer():
        raise ValueError(INVALID_RECORDING)

    tracks = elements(expect(segment, 0x1654AE6B))
    track = fields(expect(tracks, 0xAE))
    if (number(track.get(0xD7, b"")) != 1 or number(track.get(0x83, b"")) != 1 or
            track.get(0x86) != b"V_VP8" or next(tracks, None) is not None):
        raise ValueError(INVALID_RECORDING)
    video = fields(track.get(0xE0, b""))
    width = number(video.get(0xB0, b""))
    height = number(video.get(0xBA, b""))
    if not (1 <= width <= 1120 and 1 <= height <= 840):
        raise ValueError(INVALID_RECORDING)

    frames = []
    prior = -1
    for tag, data in segment:
        if tag != 0x1F43B675 or len(frames) >= MAX_FRAMES:
            raise ValueError(INVALID_RECORDING)
        cluster = fields(data)
        timestamp = number(cluster.get(0xE7, b""))
        block = cluster.get(0xA3, b"")
        if len(cluster) != 2 or len(block) < 14 or block[:4] != b"\x81\x00\x00\x80":
            raise ValueError(INVALID_RECORDING)
        vp8 = block[4:]
        encoded_width, encoded_height = (v & 0x3FFF for v in struct.unpack_from("<HH", vp8, 6))
        if (not prior < timestamp < duration or vp8[0] & 1 or vp8[3:6] != b"\x9d\x01\x2a" or
                (encoded_width, encoded_height) != (width, height)):
            raise ValueError(INVALID_RECORDING)
        frames.append((timestamp, vp8))
        prior = timestamp
    if not frames:
        raise ValueError(INVALID_RECORDING)
    return int(duration), frames


def sample(frames, count):
    if count == 1 or len(frames) <= count:
        return frames[:count]
    timestamps = [time for time, _ in frames]
    first, last = timestamps[0], timestamps[-1]
    indices = [0]
    for i in range(1, count - 1):
        target = first + (last - first) * i / (count - 1)
        index = bisect_left(timestamps, target)
        if target - timestamps[index - 1] <= timestamps[index] - target:
            index -= 1
        # Preserve distinct frames and reserve enough positions for later samples.
        indices.append(max(indices[-1] + 1, min(index, len(frames) - count + i)))
    return [frames[i] for i in (*indices, len(frames) - 1)]


def png_frame(timestamp, vp8):
    # WebP uses the same still-image VP8 bitstream. A local RIFF wrapper lets
    # Pillow decode one keyframe without launching a player or reading other files.
    padding = b"\x00" if len(vp8) & 1 else b""
    webp = b"RIFF" + struct.pack("<I", 12 + len(vp8) + len(padding))
    webp += b"WEBPVP8 " + struct.pack("<I", len(vp8)) + vp8.tobytes() + padding
    with Image.open(io.BytesIO(webp), formats=["WEBP"]) as image:
        frame = image.convert("RGB")
    while True:
        with io.BytesIO() as output:
            frame.save(output, "PNG", compress_level=3)
            if output.tell() <= PNG_LIMIT:
                return {"timeMs": timestamp, "width": frame.width, "height": frame.height,
                        "dataBase64": base64.b64encode(output.getbuffer()).decode("ascii")}
        frame.thumbnail((max(1, 3 * frame.width // 4), max(1, 3 * frame.height // 4)),
                        Image.Resampling.LANCZOS)


def extract(path, count, start, end):
    if not os.path.isabs(path) or not path.endswith(".webm"):
        raise ValueError(INVALID_RECORDING)
    if not 1 <= count <= 4 or not 0 <= start <= MAX_REQUEST_MS or not (end == -1 or start <= end <= MAX_REQUEST_MS):
        raise ValueError("抽帧的数量或时间范围无效")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= VIDEO_LIMIT:
            raise ValueError(INVALID_RECORDING)
        data = handle.read(VIDEO_LIMIT + 1)
        if len(data) != info.st_size:
            raise ValueError(INVALID_RECORDING)
    duration, frames = recording_frames(data)
    upper = duration if end == -1 else min(end, duration)
    selected = sample([frame for frame in frames if start <= frame[0] <= upper], count)
    if not selected:
        raise NoFramesError()
    return {"durationMs": duration, "frames": [png_frame(time, vp8) for time, vp8 in selected]}


def main():
    try:
        path, count, start, end = sys.argv[1:]
        print(json.dumps(extract(path, int(count), int(start), int(end)), separators=(",", ":")))
    except NoFramesError:
        print("no-frames", file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    except (OSError, Image.DecompressionBombError):
        print(INVALID_RECORDING, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
