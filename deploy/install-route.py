from pathlib import Path
from datetime import datetime
import os, shutil, subprocess
domain = os.environ.get('GAME_DOMAIN', '').strip()
if not domain or any(c.isspace() for c in domain) or any(c in domain for c in '/:{}'):
    raise SystemExit('Set GAME_DOMAIN to the exact Caddy site hostname')
p = Path(os.environ.get('CADDYFILE', '/etc/caddy/Caddyfile'))
s = p.read_text()
anchor = f'{domain} {{\n'
route = '\t@pokemon_trainer path /pokemon /pokemon/*\n\thandle @pokemon_trainer {\n\t\treverse_proxy 127.0.0.1:8788\n\t}\n'
if '@pokemon_trainer' in s:
    print('Pokemon route already present; no change')
else:
    if s.count('\n' + anchor) != 1:
        raise SystemExit(f'Expected exactly one standalone {domain} site; no change made')
    candidate = p.with_name('Caddyfile.pokemon-candidate')
    candidate.write_text(s.replace('\n' + anchor, '\n' + anchor + route, 1))
    candidate.chmod(0o600)
    check = subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True)
    if check.returncode:
        raise SystemExit('Candidate validation failed; original config unchanged')
    backup = p.with_name('Caddyfile.before-pokemon-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(p, backup)
    backup.chmod(0o600)
    shutil.copyfile(candidate, p)
    check = subprocess.run(['systemctl','reload','caddy'],capture_output=True)
    if check.returncode:
        shutil.copyfile(backup,p)
        subprocess.run(['systemctl','reload','caddy'],check=True,capture_output=True)
        raise SystemExit('Reload failed; original configuration restored')
    print('Pokemon route installed; backup: ' + str(backup))
