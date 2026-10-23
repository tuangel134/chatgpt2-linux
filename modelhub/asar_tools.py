"""Lector/empaquetador mínimo de .asar (extract / pack) sin dependencias.

pack conserva del asar original los ficheros marcados `unpacked` (viven en
app.asar.unpacked) y las banderas de ejecutable; solo reescribe offsets.
"""
import json
import os
import struct
import sys


def _open(path):
    f = open(path, "rb")
    _, _, _, jl = struct.unpack("<IIII", f.read(16))
    hdr = json.loads(f.read(jl))
    return f, hdr, 16 + ((jl + 3) & ~3)


def extract(path, out):
    f, hdr, base = _open(path)

    def walk(n, p):
        for k, v in n["files"].items():
            q = os.path.join(p, k)
            if "files" in v:
                os.makedirs(q, exist_ok=True)
                walk(v, q)
            elif "link" in v or v.get("unpacked"):
                continue
            else:
                f.seek(base + int(v["offset"]))
                os.makedirs(os.path.dirname(q), exist_ok=True)
                with open(q, "wb") as o:
                    o.write(f.read(v["size"]))
                if v.get("executable"):
                    os.chmod(q, 0o755)

    walk(hdr, out)


def pack(orig, src, out):
    _, oh, _ = _open(orig)
    blobs = []
    offset = 0

    def build(onode, d):
        nonlocal offset
        node = {"files": {}}
        ofiles = (onode or {}).get("files", {})
        names = set(os.listdir(d)) | {k for k, v in ofiles.items() if v.get("unpacked") or "files" in v}
        for name in sorted(names):
            p = os.path.join(d, name)
            o = ofiles.get(name)
            if not os.path.lexists(p):
                # fichero `unpacked`: vive en app.asar.unpacked, se conserva tal cual
                if o:
                    node["files"][name] = o
                continue
            if os.path.islink(p):
                node["files"][name] = {"link": os.readlink(p)}
            elif os.path.isdir(p):
                node["files"][name] = build(o if o and "files" in o else None, p)
            else:
                size = os.path.getsize(p)
                ent = {"size": size}
                if o and o.get("unpacked"):
                    ent["unpacked"] = True
                else:
                    ent["offset"] = str(offset)
                    blobs.append(p)
                    offset += size
                if (o and o.get("executable")) or os.access(p, os.X_OK):
                    ent["executable"] = True
                node["files"][name] = ent
        return node

    header = build(oh, src)
    hj = json.dumps(header, separators=(",", ":")).encode()
    pad = (4 - len(hj) % 4) % 4
    with open(out, "wb") as f:
        f.write(struct.pack("<IIII", 4, len(hj) + pad + 8, len(hj) + pad + 4, len(hj)))
        f.write(hj + b"\0" * pad)
        for p in blobs:
            with open(p, "rb") as g:
                while True:
                    c = g.read(1 << 20)
                    if not c:
                        break
                    f.write(c)


if __name__ == "__main__":
    if sys.argv[1] == "pack":
        pack(*sys.argv[2:5])
    elif sys.argv[1] == "extract":
        extract(*sys.argv[2:4])
