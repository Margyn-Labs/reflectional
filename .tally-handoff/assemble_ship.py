import base64,zlib,hashlib,pathlib,json,sys
meta=json.load(open("/tmp/chunks_meta.json"))
parts=[]
for i,m in enumerate(meta["chunks"]):
    t=pathlib.Path(f"/tmp/safe_part{i}.txt").read_text()
    h=hashlib.sha256(t.encode()).hexdigest()
    assert h==m["sha256"], (i,h,m["sha256"])
    parts.append(t)
payload="".join(parts)
assert hashlib.sha256(payload.encode()).hexdigest()==meta["full_sha256"]
data=zlib.decompress(base64.b64decode(payload))
assert hashlib.sha256(data).hexdigest()==meta["html_sha256"]
pathlib.Path("index.html").write_bytes(data)
print("OK", len(data))
