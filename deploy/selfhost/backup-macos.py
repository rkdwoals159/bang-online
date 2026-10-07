import os
import secrets
import subprocess
from pathlib import Path
from datetime import datetime, timezone

base = Path.home() / '.bang-online'
target = base / 'backups' / ('bang-online-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3) + '.dump')
password = (base / 'config/db-password').read_text().strip()
env = dict(os.environ, PGPASSWORD=password)
subprocess.run([str(base / 'runtime/Postgres.app/Contents/Versions/18/bin/pg_dump'), '-h', '127.0.0.1', '-p', '55432', '-U', 'bang_app', '-d', 'bang_online', '-Fc', '-f', str(target)], env=env, check=True)
target.chmod(0o600)
print('Database backup completed: ' + target.name)
