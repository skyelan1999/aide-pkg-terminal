"""Convert the fixed 24-bit Xvfb test capture to a PNG; no external image tool."""
import binascii
from pathlib import Path
import struct
import sys
import zlib

raw = Path(sys.argv[1]).read_bytes()
header = struct.unpack('>25I', raw[:100])
size, version, fmt, depth, width, height = header[:6]
order, bits, stride = header[7], header[11], header[12]
assert version == 7 and fmt == 2 and depth == 24 and bits == 32
assert 0 < width <= 4096 and 0 < height <= 4096
assert header[14:17] == (0xff0000, 0xff00, 0xff)
pixels = raw[size + header[19] * 12:]
assert len(pixels) >= height * stride
scanlines = bytearray()
for y in range(height):
    scanlines.append(0)
    for x in range(width):
        pixel = pixels[y * stride + x * 4:y * stride + x * 4 + 4]
        scanlines.extend((pixel[2], pixel[1], pixel[0]) if order == 0 else pixel[1:4])

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(scanlines))) + chunk(b'IEND', b'')
Path(sys.argv[2]).write_bytes(png)
