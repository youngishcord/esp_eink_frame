"""Writes a big PNG (no PIL needed) so the web UI can be tested with a photo
larger than MAX_SRC_SIDE. Usage: python tools/make_test_png.py path width height
"""

import struct
import sys
import zlib


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data +
            struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def main():
    path = sys.argv[1]
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 2000

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        fy = y / height
        for x in range(width):
            fx = x / width
            raw.append(int(255 * fx))
            raw.append(int(255 * (1 - fx) * fy))
            raw.append(int(128 + 127 * ((x // 60 + y // 60) % 2)))

    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 1)) +
           chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(png)
    print("%s: %dx%d, %.1f MB" % (path, width, height, len(png) / 1048576))


if __name__ == "__main__":
    main()
