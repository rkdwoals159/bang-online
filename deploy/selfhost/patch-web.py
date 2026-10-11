"""Publish validated hashed frontend files without restarting the game process."""
from pathlib import Path
import os, shutil, tarfile, sys, json, time
base = Path.home() / '.bang-online'
archive, commit = sys.argv[1:]
stage = base / ('web-stage-' + commit[:12])
stage.mkdir(exist_ok=False)
with tarfile.open(Path(archive).expanduser()) as bundle:
    for member in bundle.getmembers():
        target = (stage / member.name).resolve()
        if (target != stage.resolve() and stage.resolve() not in target.parents) or not (member.isfile() or member.isdir()):
            raise ValueError('Unsafe archive member')
    bundle.extractall(stage)
web = (base / 'current/web').resolve(strict=True)
for source in stage.rglob('*'):
    if not source.is_file() or source.name == 'index.html':
        continue
    destination = web / source.relative_to(stage)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        shutil.copy2(source, destination)
previous_index = web / ('index-before-' + commit[:12] + '.html')
shutil.copy2(web / 'index.html', previous_index)
temporary = web / 'index.html.next'
shutil.copy2(stage / 'index.html', temporary)
os.replace(temporary, web / 'index.html')
metadata = {'webSourceCommit': commit, 'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'serverRestarted': False, 'reason': 'Restore active match after unchanged recovered room response'}
(base / 'current/web-patch-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata))
