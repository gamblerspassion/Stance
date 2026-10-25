#!/usr/bin/env python3
"""Expand checked-in ASCII snapshot parts into SIGNAL's real static JSON data.
No internet, tokens, API keys, or third-party Python packages required.
"""
from __future__ import annotations
import argparse,base64,hashlib,io,json,pathlib,tarfile,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]

def unpack(package,output):
 manifest=json.loads((package/'pack-manifest.json').read_text())
 pieces=sorted(package.glob('signal.part*.txt'))
 if len(pieces)!=manifest['part_count']:raise RuntimeError(f'missing snapshot chunks; found {len(pieces)}/{manifest["part_count"]}')
 encoded=''.join(p.read_text(encoding='ascii').strip() for p in pieces)
 if len(encoded)!=manifest['base64_length']:raise RuntimeError('snapshot length mismatch')
 blob=base64.b64decode(encoded,validate=True)
 if hashlib.sha256(blob).hexdigest()!=manifest['archive_sha256']:raise RuntimeError('snapshot digest mismatch')
 # Extract from trusted archive using strict expected path prefix; no traversal/symlink.
 output.mkdir(parents=True,exist_ok=True)
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tf:
  entries=tf.getmembers()
  for member in entries:
   relative=pathlib.PurePosixPath(member.name)
   if not relative.parts or relative.parts[0]!='signal-v1' or '..' in relative.parts or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
    raise RuntimeError(f'unsafe tar entry: {member.name}')
  for member in entries:
   relative=pathlib.PurePosixPath(member.name)
   path=output.joinpath(*relative.parts[1:])
   if member.isdir():path.mkdir(parents=True,exist_ok=True);continue
   path.parent.mkdir(parents=True,exist_ok=True)
   with tf.extractfile(member) as src,path.open('wb') as dst:
    while chunk:=src.read(1024*1024):dst.write(chunk)
 got=json.loads((output/'manifest.json').read_text())
 if got['zip_records']!=manifest['expected_market_count'] or got['website_routes']!=manifest['expected_website_routes']:
  raise RuntimeError('snapshot metadata failed integrity check')
 return got

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--package',type=pathlib.Path,default=ROOT/'snapshot-pack');p.add_argument('--output',type=pathlib.Path,default=ROOT/'data/signal-v1');p.add_argument('--public',type=pathlib.Path,default=None)
 a=p.parse_args();m=unpack(a.package,a.output)
 if a.public:
  import shutil
  shutil.copytree(a.output,a.public,dirs_exist_ok=True)
 print(json.dumps({'status':'ready','data_directory':str(a.output),'website_public_directory':str(a.public) if a.public else None,'markets':m['zip_records'],'routes':m['website_routes'],'fcc_rows':m['fcc_rows_read']}))