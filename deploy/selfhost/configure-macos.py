import os
import secrets
import subprocess
import plistlib
import time
from pathlib import Path

base = Path.home() / '.bang-online'
runtime = base / 'runtime'
pg = runtime / 'Postgres.app/Contents/Versions/18/bin'
release = base / 'releases' / '2026-10-08'
release.mkdir(parents=True, exist_ok=True)
subprocess.run(['tar', '-xzf', str(Path.home() / 'bang-selfhost-release.tar.gz'), '-C', str(release)], check=True)
env = dict(os.environ, PATH=str(runtime / 'node/bin') + ':' + os.environ['PATH'])
subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=release, env=env, check=True)
current = base / 'current'
if current.is_symlink():
    current.unlink()
current.symlink_to(release, target_is_directory=True)
config = base / 'config'
config.mkdir(mode=0o700, exist_ok=True)
db_password_file = config / 'db-password'
if not db_password_file.exists():
    db_password_file.write_text(secrets.token_hex(32))
    db_password_file.chmod(0o600)
password = db_password_file.read_text().strip()
data = base / 'postgres'
admin_password_file = config / 'db-admin-password'
if not admin_password_file.exists():
    admin_password = secrets.token_hex(32)
    if data.exists():
        # Upgrade the initial installation that used the app password for bootstrap.
        admin_env = dict(os.environ, PGPASSWORD=password)
        subprocess.run([str(pg / 'psql'), '-h', '127.0.0.1', '-p', '55432', '-U', 'bang_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input="ALTER ROLE bang_admin PASSWORD '" + admin_password + "';\n", text=True, env=admin_env, check=True, stdout=subprocess.DEVNULL)
    admin_password_file.write_text(admin_password)
    admin_password_file.chmod(0o600)
if not data.exists():
    subprocess.run([str(pg / 'initdb'), '-D', str(data), '-U', 'bang_admin', '--pwfile', str(admin_password_file), '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'], check=True)
    with (data / 'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses = '127.0.0.1'\nport = 55432\nunix_socket_directories = '/Users/rkdwoals159/.bang-online'\n")
    subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-l', str(base / 'logs/postgres-bootstrap.log'), '-w', 'start'], check=True)
    subprocess.run([str(pg / 'psql'), '-h', str(base), '-p', '55432', '-U', 'bang_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input="CREATE ROLE bang_app LOGIN PASSWORD '" + password + "';\nCREATE DATABASE bang_online OWNER bang_app;\n", text=True, check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', 'stop'], check=True)
    (data / 'pg_hba.conf').write_text('local all all scram-sha-256\nhost all all 127.0.0.1/32 scram-sha-256\n')

app_env = config / 'server.env'
app_env.write_text(f'DATABASE_URL=postgresql://bang_app:{password}@127.0.0.1:55432/bang_online\nHOST=127.0.0.1\nPORT=3080\nWEB_ORIGIN=https://bang-online.site\nNODE_ENV=production\n')
app_env.chmod(0o600)
caddyfile = config / 'Caddyfile'
caddyfile.write_text('''{
  admin off
  auto_https off
}
http://:8088 {
  bind 127.0.0.1
  encode zstd gzip
  @backend path /api/* /socket.io /socket.io/* /healthz
  handle @backend {
    reverse_proxy 127.0.0.1:3080
  }
  handle {
    root * /Users/rkdwoals159/.bang-online/current/web
    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"
    @html path / /index.html /rooms/*
    header @html Cache-Control "no-cache"
    try_files {path} /index.html
    file_server
  }
}
''')
subprocess.run([str(runtime / 'caddy'), 'validate', '--config', str(caddyfile), '--adapter', 'caddyfile'], check=True)
agents = Path.home() / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
services = {
    'postgres': [str(pg / 'postgres'), '-D', str(data)],
    'server': [str(runtime / 'node/bin/node'), '--env-file=' + str(app_env), str(release / 'server/storage/main.mjs')],
    'web': [str(runtime / 'caddy'), 'run', '--config', str(caddyfile), '--adapter', 'caddyfile'],
}
for name, args in services.items():
    label = 'site.bang-online.' + name
    path = agents / (label + '.plist')
    loaded = subprocess.run(['launchctl', 'print', 'gui/502/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if loaded:
        with path.open('rb') as f:
            if plistlib.load(f)['ProgramArguments'] == args:
                continue
        subprocess.run(['launchctl', 'bootout', 'gui/502/' + label], check=True)
        for _ in range(20):
            if subprocess.run(['launchctl', 'print', 'gui/502/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
                break
            time.sleep(0.5)
    with path.open('wb') as f:
        plistlib.dump({'Label': label, 'ProgramArguments': args, 'WorkingDirectory': str(current), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'StandardOutPath': str(base / 'logs' / (name + '.log')), 'StandardErrorPath': str(base / 'logs' / (name + '.error.log'))}, f)
    path.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', 'gui/502', str(path)], check=True)
print('PostgreSQL, game server and web proxy services installed.')
