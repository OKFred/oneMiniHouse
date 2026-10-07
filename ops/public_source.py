"""Audit/export Git candidate files, excluding history and ignored runtime data.
Private literal rules stay outside Git. Scanning cannot prove absence of all secrets.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_PARTS = {'.git', '.local', 'node_modules', 'secrets', 'evidence', '__pycache__', '.wrangler', '.pnpm-store', 'dist', 'data'}
PATTERNS = [
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('access-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b')),
    ('webhook', re.compile(r'https://open\.feishu\.cn/open-apis/bot/v2/hook/[0-9a-f-]{36}', re.I)),
    ('connection-password', re.compile(r'(?:postgres(?:ql)?|mqtts?)://[^\s/:]+:[^\s/@]+@', re.I)),
    ('private-ip', re.compile(r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b')),
    ('miniapp-id', re.compile(r'\bwx[0-9a-f]{16}\b', re.I)),
    ('mac-address', re.compile(r'(?<![:A-Fa-f0-9])(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}(?![:A-Fa-f0-9])')),
    ('cloud-resource', re.compile(r'\b[a-z0-9]{12,}\.ala\.[a-z-]+\.emqxsl\.cn\b', re.I)),
]

def git_files(root: Path) -> list[str]:
    out = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    names = sorted(set(n.decode('utf-8') for n in out.split(b'\0') if n))
    return [n for n in names if (root / n).exists() or (root / n).is_symlink()]

def unsafe_path(name: str) -> bool:
    p = PurePosixPath(name)
    base = p.name.lower()
    if name in {'gateway/secrets/.gitkeep', 'ingestor/secrets/.gitkeep'}:
        return False
    return (p.is_absolute() or '..' in p.parts or any(c.lower() in PRIVATE_PARTS for c in p.parts)
            or base == 'project.private.config.json' or base.endswith(('.har', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.tgz', '.tar.gz', '.ipk', '.zip'))
            or bool(re.search(r'\.local\.(?:jsonc?|ya?ml|sql)$', base))
            or (base.startswith('.env') and not (base.endswith('.example') or '.example.' in base)))

def private_rules(path: Path | None) -> list[str]:
    if path is None:
        return []
    obj = json.loads(path.read_text(encoding='utf-8-sig'))
    values = obj.get('literals') if isinstance(obj, dict) else None
    if not isinstance(values, list) or not values or any(not isinstance(x, str) or len(x.strip()) < 4 for x in values):
        raise ValueError('Private rules require a nonempty literals array of strings (minimum four characters)')
    return values

def scan(root: Path, names: list[str], literals: list[str], snapshot: dict[str, bytes] | None = None) -> list[dict]:
    findings = []
    for name in names:
        path_patterns = [label for label, pattern in PATTERNS if pattern.search(name)]
        display_name = '[redacted filename]' if path_patterns or any(value.lower() in name.lower() for value in literals) else name
        for label in path_patterns:
            findings.append({'path': display_name, 'rule': 'path-' + label, 'line': 1})
        for index, value in enumerate(literals):
            if value.lower() in name.lower():
                findings.append({'path': '[redacted filename]', 'rule': f'private-path-{index + 1}', 'line': 1})
        path = root / name
        if unsafe_path(name) or path.is_symlink() or not path.is_file():
            findings.append({'path': display_name, 'rule': 'unsafe-path', 'line': 1})
            continue
        data = snapshot[name] if snapshot is not None else path.read_bytes()
        if path.name == '.gitkeep' and data:
            findings.append({'path': display_name, 'rule': 'nonempty-directory-marker', 'line': 1})
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            if path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp'}:
                findings.append({'path': display_name, 'rule': 'unreviewed-binary', 'line': 1})
            text = data.decode('latin-1')
        lower = text.lower()
        for index, value in enumerate(literals):
            match = lower.find(value.lower())
            if match >= 0:
                findings.append({'path': display_name, 'rule': f'private-literal-{index + 1}', 'line': text[:match].count('\n') + 1})
        for label, pattern in PATTERNS:
            # Integrity hashes can coincidentally resemble app IDs; other checks still apply.
            if label == 'miniapp-id' and path.name in {'pnpm-lock.yaml', 'package-lock.json'}:
                continue
            for match in pattern.finditer(text):
                if label == 'miniapp-id' and match.group().lower() == 'wx0000000000000000':
                    continue
                if label == 'mac-address' and (match.group().upper().startswith('02:00:00:00:00:') or match.group().upper() == '00:11:22:33:44:55'):
                    continue
                # Exact synthetic negative-test inputs, not a broad test-directory exemption.
                if label == 'webhook' and name == 'ingestor/test/cpu-core-alert.test.ts' and match.group().endswith('/00000000-0000-4000-a000-000000000000'):
                    continue
                if label == 'connection-password' and name == 'ops/linux-temperature/test_agent.py' and match.group() == 'mqtts://' + 'user:secret@' and text[match.end():].startswith('broker.example.com'):
                    continue
                findings.append({'path': display_name, 'rule': label, 'line': text[:match.start()].count('\n') + 1})
    return findings

def manifest(root: Path, names: list[str]) -> list[dict]:
    return [{'path': n, 'sha256': hashlib.sha256((root / n).read_bytes()).hexdigest(), 'bytes': (root / n).stat().st_size} for n in names]

def export(root: Path, destination: Path, names: list[str], literals: list[str]) -> dict:
    if not literals:
        raise ValueError('Public export requires private rules; generic-only scans cannot authorize export')
    if destination.exists():
        raise ValueError('Export destination must not exist; existing exports are never overwritten')
    if scan(root, names, literals):
        raise ValueError('Export blocked by privacy findings; run scan for redacted locations')
    destination.mkdir(parents=True)
    for name in names:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((root / name).read_bytes())
    if scan(destination, names, literals):
        raise ValueError('Snapshot failed privacy scan; incomplete output must not be published')
    report = {'format': 1, 'history_included': False, 'file_count': len(names), 'files': manifest(destination, names)}
    (destination / 'EXPORT-MANIFEST.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'files': len(names), 'history_included': False, 'output': str(destination)}

def package(root: Path, output: Path, names: list[str], literals: list[str]) -> list[dict]:
    snapshot = {n: (root / n).read_bytes() for n in names if not unsafe_path(n) and (root / n).is_file() and not (root / n).is_symlink()}
    if scan(root, names, literals, snapshot):
        raise ValueError('Packaging blocked by privacy findings; run scan for redacted locations')
    output.mkdir(parents=True, exist_ok=True)
    reports = []
    for component in ('gateway', 'ingestor'):
        wanted = [n for n in names if n.startswith(component + '/') and not n.startswith(component + '/cloud/')]
        extras = [n for n in ('LICENSE', 'THIRD_PARTY_NOTICES.md') if n in names]
        if not wanted:
            raise ValueError(f'No source for {component}')
        entries = {n[len(component) + 1:]: n for n in wanted}
        entries.update({n: n for n in extras})
        archive = output / f'{component}.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            for arcname, n in entries.items():
                info = tarfile.TarInfo(arcname)
                info.size = len(snapshot[n])
                info.mode = 0o755 if arcname.endswith('.sh') else 0o644
                tar.addfile(info, io.BytesIO(snapshot[n]))
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar.getmembers():
                if unsafe_path(component + '/' + member.name) or not member.isfile():
                    raise ValueError('Unsafe member in source archive')
                if tar.extractfile(member).read() != snapshot[entries[member.name]]:
                    raise ValueError('Archive does not match scanned bytes')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (output / f'{component}.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
        reports.append({'component': component, 'files': len(entries), 'sha256': digest, 'path': str(archive)})
    return reports

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['scan', 'export', 'package'])
    parser.add_argument('--private-rules', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        names = git_files(ROOT)
        literals = private_rules(args.private_rules)
        if args.command == 'scan':
            findings = scan(ROOT, names, literals)
            print(json.dumps({'files': len(names), 'private_rules_loaded': bool(literals), 'findings': findings}, ensure_ascii=False, indent=2))
            return 1 if findings else 0
        if args.output is None:
            raise ValueError('--output is required')
        result = export(ROOT, args.output.resolve(), names, literals) if args.command == 'export' else package(ROOT, args.output.resolve(), names, literals)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Public source check failed: {error}', file=sys.stderr)
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
