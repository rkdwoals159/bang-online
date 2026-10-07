import plistlib
import subprocess
from pathlib import Path

base = Path.home() / '.bang-online'
label = 'site.bang-online.tunnel'
agent = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
token = base / 'config/tunnel.token'
if not token.is_file():
    raise RuntimeError('Tunnel token file missing')
token.chmod(0o600)
with agent.open('wb') as f:
    plistlib.dump({'Label': label, 'ProgramArguments': [str(base / 'runtime/cloudflared'), '--no-autoupdate', 'tunnel', 'run', '--token-file', str(token)], 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'StandardOutPath': str(base / 'logs/tunnel.log'), 'StandardErrorPath': str(base / 'logs/tunnel.error.log')}, f)
agent.chmod(0o600)
subprocess.run(['launchctl', 'bootstrap', 'gui/502', str(agent)], check=True)
backup_label = 'site.bang-online.backup'
backup_agent = agent.with_name(backup_label + '.plist')
with backup_agent.open('wb') as f:
    plistlib.dump({'Label': backup_label, 'ProgramArguments': ['/usr/bin/python3', str(base / 'backup.py')], 'StartCalendarInterval': {'Hour': 4, 'Minute': 0}, 'StandardOutPath': str(base / 'logs/backup.log'), 'StandardErrorPath': str(base / 'logs/backup.error.log')}, f)
backup_agent.chmod(0o600)
subprocess.run(['launchctl', 'bootstrap', 'gui/502', str(backup_agent)], check=True)
print('Tunnel connector and daily database backup service installed.')
