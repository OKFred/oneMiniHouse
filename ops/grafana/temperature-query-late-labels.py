"""Generate a read-only late-label query from private, current view/dashboard snapshots.

Only the existing three safe temperature views are read. Unknown projection or
identity shapes fail closed; generated SQL containing private names stays local.
"""

import argparse
import hashlib
import importlib.util
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


spec = importlib.util.spec_from_file_location('temperature_optimizer', Path(__file__).with_name('optimize-temperature-view.py'))
optimizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimizer)
LITERAL = optimizer.LITERAL
VIEWS = ('home_server_temperature_samples', 'home_phone_temperature_samples', 'home_host_health_temperature_samples')
TEXT = re.compile(LITERAL)


def text_value(literal):
    if not re.fullmatch(LITERAL, literal):
        raise ValueError('Expected a text literal')
    return literal[:-6][1:-1].replace("''", "'")


def quote(value):
    return 'NULL::text' if value is None else "'" + value.replace("'", "''") + "'::text"


def expression(expression):
    references = {'t.device_id': 'device_id', 'metric.key': 'sensor_id'}
    result = re.sub(r"'(?:''|[^'])*'|\b(?:t\.device_id|metric\.key)\b",
                    lambda match: references.get(match.group(), match.group()), expression.strip())
    bare = re.sub(r"'(?:''|[^'])*'", '', result)
    if re.search(r';|--|/\*|\b(?:SELECT|FROM|JOIN|UNION|INSERT|UPDATE|DELETE|CREATE|GRANT|COPY)\b|\b\w+\.\w+\b', bare, re.I):
        raise ValueError('Unsupported label expression')
    allowed = {'device_id', 'sensor_id', 'case', 'when', 'then', 'else', 'end', 'null', 'text', 'substring', 'in', 'or', 'and', 'true', 'false'}
    if any(token.lower() not in allowed for token in re.findall(r'\b[a-z_][a-z_0-9]*\b', bare, re.I)):
        raise ValueError('Unsupported label identifier or function')
    return result


def label(branch):
    pieces = optimizer.split_top_level(branch, 'AS')
    matches = [re.fullmatch(r'\s*sensor_id\s*,(.*)', part, re.I | re.S) for index, part in enumerate(pieces[:-1])
               if re.match(r'\s*sensor_name\b', pieces[index + 1], re.I)]
    matches = [matched for matched in matches if matched]
    if len(matches) != 1:
        raise ValueError('Expected adjacent sensor_id/sensor_name projections')
    return expression(matches[0].group(1))


def source_identity(branch):
    where = optimizer.split_top_level(branch, 'WHERE')
    if len(where) != 2:
        raise ValueError('Expected one source WHERE')
    source = re.search(r'\bt\.site_id\s*=\s*' + LITERAL + r'\s+AND\s*\(', where[1])
    if not source:
        raise ValueError('Expected the indexed source identity')
    opening = source.end() - 1
    identity = where[1][opening + 1:optimizer.closing_parenthesis(where[1], opening)]
    device = re.findall(r'\bt\.device_id\s*=\s*(' + LITERAL + ')', identity)
    if len(device) != 1:
        raise ValueError('Expected one expanded source device')
    return text_value(device[0])


def server_label(definition):
    branches = optimizer.split_top_level(definition.strip().removesuffix(';'), 'UNION ALL')
    if len(branches) != 3:
        raise ValueError('Expected the current three server source branches')
    expanded, count, _ = optimizer.source_branches(definition)
    first_name = re.search(r'\bt\.device_id\s*,(.*?)\bAS\s+device_name\b', branches[0], re.I | re.S)
    if not first_name or not re.fullmatch(r'\s*CASE\s+t\.device_id(?:\s+WHEN\s+' + LITERAL + r'\s+THEN\s+' + LITERAL + r')+\s+ELSE\s+NULL::text\s+END\s*', first_name.group(1), re.I | re.S):
        raise ValueError('Unsupported primary device-name CASE')
    entries = re.findall(r'\bWHEN\s+(' + LITERAL + r')\s+THEN\s+(' + LITERAL + ')', first_name.group(1), re.I)
    names = {text_value(key): text_value(value) for key, value in entries}
    if len(names) != len(entries):
        raise ValueError('Duplicate device-name CASE identities')
    domains = [{(source_identity(branch), names.get(source_identity(branch))) for branch in expanded[:count]}]
    pairs = re.search(r'\(t\.gateway_id,\s*t\.device_id\)\s+IN\s*\(\s*VALUES(.*?)\)\s*\)', branches[1], re.I | re.S)
    if not pairs:
        raise ValueError('Unsupported secondary source identities')
    pair_pattern = r'\(\s*(' + LITERAL + r')\s*,\s*(' + LITERAL + r')\s*\)'
    entries = re.findall(pair_pattern, pairs.group(1) + ')')
    if not entries or re.sub(pair_pattern + r'|\s|,', '', pairs.group(1) + ')'):
        raise ValueError('Empty secondary source identities')
    domains.append({(text_value(device), text_value(gateway)) for gateway, device in entries})
    third_device = re.findall(r'\bt\.device_id\s*=\s*(' + LITERAL + ')', optimizer.split_top_level(branches[2], 'WHERE')[-1])
    third_name = re.search(r'\bt\.device_id\s*,\s*(' + LITERAL + r')\s+AS\s+device_name\b', branches[2], re.I)
    if len(third_device) != 1 or not third_name:
        raise ValueError('Unsupported constant server identity')
    domains.append({(text_value(third_device[0]), text_value(third_name.group(1)))})
    if any(left & right for index, left in enumerate(domains) for right in domains[index + 1:]):
        raise ValueError('Overlapping output identities cannot determine the original label branch')
    terms = []
    for branch, identities in zip(branches, domains):
        predicate = ' OR '.join('(device_id,device_name) IS NOT DISTINCT FROM (' + quote(device) + ',' + quote(name) + ')' for device, name in sorted(identities))
        terms.append('WHEN ' + predicate + ' THEN ' + label(branch))
    return 'CASE\n' + '\n'.join(terms) + '\nELSE NULL::text END'


def dashboard_template(dashboard):
    candidates = []
    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get('rawSql'), str) and all(view in value['rawSql'] for view in VIEWS):
                candidates.append(value['rawSql'])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(dashboard)
    if len(candidates) != 1:
        raise ValueError('Expected one current three-view temperature query')
    if not re.match(r'\s*SELECT\s+\$__timeGroupAlias\(\s*read_time_utc\s*,\s*\$__interval\s*,\s*NULL\s*\)', candidates[0], re.I):
        raise ValueError('Expected the existing epoch-aligned NULL-fill time grouping')
    source = optimizer.split_top_level(candidates[0], 'FROM')
    metric = re.fullmatch(r'\s*SELECT\s+\$__timeGroupAlias\(\s*read_time_utc\s*,\s*\$__interval\s*,\s*NULL\s*\)\s*,\s*device_name\s*\|\|\s*(\'(?:\'\'|[^\'])*\')\s*\|\|\s*sensor_name\s+AS\s+metric\s*,\s*avg\(temperature_c\)\s+AS\s+value\s*', source[0], re.I)
    if len(source) != 2 or not source[1].lstrip().startswith('('):
        raise ValueError('Unsupported current safe-view source')
    body = source[1].strip()
    closing = optimizer.closing_parenthesis(body, 0)
    branches = optimizer.split_top_level(body[1:closing], 'UNION ALL')
    if len(branches) != len(VIEWS) or any(not re.fullmatch(r'\s*SELECT\s+read_time_utc\s*,\s*device_name\s*,\s*sensor_name\s*,\s*sensor_id\s*,\s*temperature_c\s+FROM\s+iot\.' + view + r'\s*', branch, re.I) for view, branch in zip(VIEWS, branches)):
        raise ValueError('Expected the unchanged three safe-view projections')
    where = optimizer.split_top_level(candidates[0], 'WHERE')
    if not metric or len(where) != 2:
        raise ValueError('Unsupported current metric or outer filter')
    filters = optimizer.split_top_level(where[1], 'GROUP BY')[0].strip()
    matched = re.fullmatch(r'\$__timeFilter\(read_time_utc\)(?:\s+AND\s+(.*))?', filters, re.I | re.S)
    if not matched:
        raise ValueError('Unsupported current time filter')
    category = matched.group(1) or 'TRUE'
    expression(category.replace('${temperature_category:sqlstring}', "'synthetic'"))
    bare = re.sub(r"'(?:''|[^'])*'", '', category.replace('${temperature_category:sqlstring}', "'synthetic'"))
    if re.search(r'\b(?:device_id|device_name|temperature_c|read_time_utc|sensor_name)\b|\$', bare):
        raise ValueError('Category must depend only on sensor_id')
    all_value = re.search(r"\$\{temperature_category:sqlstring\}\s*=\s*('(?:''|[^'])*')\s+OR\b", category, re.I)
    if category != 'TRUE' and not all_value:
        raise ValueError('Expected the existing all-category selector')
    return metric.group(1), category, all_value.group(1) if all_value else "'all'"


def render(snapshot, dashboard, interval_seconds=None, start=None, end=None):
    delimiter, category, all_value = dashboard_template(dashboard)
    views = {view['name']: view for view in snapshot['views']}
    labels = []
    for name in VIEWS:
        view = views[name]
        if 'security_barrier=true' not in (view.get('options') or []):
            raise ValueError('Refusing a view snapshot without the existing security barrier')
        labels.append(server_label(view['definition']) if name == VIEWS[0] else label(view['definition']))
    if interval_seconds is not None and (type(interval_seconds) is not int or interval_seconds <= 0):
        raise ValueError('Interval seconds must be a positive integer')
    stride = str(interval_seconds) if interval_seconds is not None else '($__interval_ms)::double precision / 1000.0'
    time_filter = '$__timeFilter(read_time_utc)'
    if start is not None or end is not None:
        if start is None or end is None or start >= end or start.utcoffset() != timedelta(0) or end.utcoffset() != timedelta(0):
            raise ValueError('Expected a finite increasing UTC benchmark window')
        time_filter = "read_time_utc BETWEEN TIMESTAMPTZ '" + start.isoformat() + "' AND TIMESTAMPTZ '" + end.isoformat() + "'"
        category = category.replace('${temperature_category:sqlstring}', all_value)
    aggregated, labeled = [], []
    for index, (name, sensor_name) in enumerate(zip(VIEWS, labels)):
        alias = 'temperature_buckets_' + str(index)
        aggregated.append(alias + ' AS MATERIALIZED (\nSELECT date_bin(make_interval(secs => ' + stride + "),read_time_utc,TIMESTAMPTZ '1970-01-01T00:00:00Z') AS bucket,\n"
            + 'device_id,device_name,sensor_id,sum(temperature_c) AS temperature_sum,count(temperature_c) AS temperature_count\n'
            + 'FROM iot.' + name + '\nWHERE ' + time_filter + '\nGROUP BY 1,2,3,4\n)')
        labeled.append('SELECT bucket,device_name || ' + delimiter + ' || (' + sensor_name + ') AS metric,temperature_sum,temperature_count\nFROM ' + alias + '\nWHERE ' + category)
    output_time = 'bucket AS "time"' if interval_seconds is not None else '$__timeGroupAlias(bucket,$__interval,NULL)'
    return 'WITH\n' + ',\n'.join(aggregated) + ',\ntemperature_labels AS (\n' + '\nUNION ALL\n'.join(labeled) + '\n)\n' + \
        'SELECT ' + output_time + ',metric,sum(temperature_sum)/NULLIF(sum(temperature_count),0)::double precision AS value\nFROM temperature_labels\nGROUP BY 1,2\nORDER BY 1,2;\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--dashboard', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--benchmark', type=Path)
    parser.add_argument('--interval-seconds', type=int, default=600)
    args = parser.parse_args()
    local = Path(__file__).resolve().parents[2] / '.local'
    if any(not output.resolve().is_relative_to(local) for output in [args.candidate, args.benchmark] if output):
        parser.error('Private query candidates must be inside this checkout .local directory')
    snapshot = json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
    dashboard = json.loads(args.dashboard.read_text(encoding='utf-8-sig'))
    outputs = [(args.candidate, render(snapshot, dashboard))]
    if args.benchmark:
        end = datetime(2026, 11, 7, 20, 16, 51, tzinfo=timezone.utc)
        outputs.append((args.benchmark, render(snapshot, dashboard, args.interval_seconds, end - timedelta(days=7), end)))
    for path, query in outputs:
        with path.open('x', encoding='utf-8', newline='\n') as output:
            output.write(query)
    print(json.dumps({'candidateSha256': hashlib.sha256(outputs[0][1].encode()).hexdigest(),
                      'snapshotSha256': hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
                      'readOnly': True, 'safeViews': len(VIEWS), 'actualPostgresVerificationRequired': True}))


if __name__ == '__main__':
    main()
