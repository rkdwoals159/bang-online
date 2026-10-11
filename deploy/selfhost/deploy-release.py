"""One release switch with a database backup, health check and automatic rollback.

Usage on the server: python3 deploy-release.py RELEASE SOURCE_COMMIT ARCHIVE
Prepare and validate the archive locally before running this script.
"""
from pathlib import Path
import os, subprocess, plistlib, time, json, urllib.request, sys, re

release_name, source_commit, archive_arg = sys.argv[1:]
if not re.fullmatch(r'[a-z0-9-]+', release_name) or not re.fullmatch(r'[a-f0-9]{40}', source_commit):
    raise ValueError('Invalid release metadata')
base = Path.home() / '.bang-online'
release = base / 'releases' / release_name
archive = Path(archive_arg).expanduser().resolve(strict=True)
if release.exists():
    raise RuntimeError('Release already exists; inspect before retrying')
release.mkdir()
subprocess.run(['tar', '-xzf', str(archive), '-C', str(release)], check=True)
env = dict(os.environ, PATH=str(base / 'runtime/node/bin') + ':' + os.environ['PATH'])
subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=release, env=env, check=True)
subprocess.run([str(base / 'runtime/node/bin/node'), str(base / 'preflight-state.mjs')], check=True)
subprocess.run(['/usr/bin/python3', str(base / 'backup.py')], check=True)
current = base / 'current'
previous = current.resolve()
agents = Path.home() / 'Library/LaunchAgents'
plist = agents / 'site.bang-online.server.plist'
old_plist = plist.read_bytes()
config = plistlib.loads(old_plist)
config['ProgramArguments'][-1] = str(release / 'server/storage/main.mjs')
caddy = base / 'config/Caddyfile'
old_caddy = caddy.read_bytes()
new_caddy = old_caddy.decode().replace('    @hashed path /assets/*', '''    @hashed {
      path /assets/*
      not path /assets/cards/*
    }
    @cards path /assets/cards/*
    header @cards Cache-Control "public, max-age=3600, must-revalidate"''')
candidate = base / 'config/Caddyfile.candidate'
candidate.write_text(new_caddy)
subprocess.run([str(base / 'runtime/caddy'), 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True)
domain = 'gui/' + str(os.getuid())

def stop(service):
    label = domain + '/site.bang-online.' + service
    subprocess.run(['launchctl', 'bootout', label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if subprocess.run(['launchctl', 'print', label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            break
        time.sleep(0.25)
    time.sleep(1)

def start(service):
    for _ in range(8):
        path = agents / ('site.bang-online.' + service + '.plist')
        if subprocess.run(['launchctl', 'bootstrap', domain, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError('Could not start ' + service)

def switch(target, content, caddy_content):
    temporary = base / ('current-next-' + release_name)
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, current)
    plist.write_bytes(content)
    plist.chmod(0o600)
    caddy.write_bytes(caddy_content)

def healthy():
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8088/healthz', timeout=1) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False

try:
    stop('server')
    stop('web')
    switch(release, plistlib.dumps(config), new_caddy.encode())
    start('server')
    start('web')
    if not healthy():
        raise RuntimeError('Release health check failed')
except Exception:
    stop('server')
    stop('web')
    switch(previous, old_plist, old_caddy)
    start('server')
    start('web')
    print(json.dumps({'rolledBack': True, 'healthy': healthy()}))
    raise

metadata = {'sourceCommit': source_commit, 'previousRelease': str(previous), 'release': str(release),
            'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'change': 'Complete Node/Sites migration parity fixes F01-F12'}
(release / 'release-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({'ok': True, **metadata}))
