"""Split a pg_get_viewdef snapshot into disjoint indexed source branches.

Only the known leading host-source OR predicate is rewritten and specialized.
Unsupported or overlapping predicates fail closed; other projections are kept.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path


VIEW = 'home_server_temperature_samples'
LITERAL = r"'(?:''|[^'])*'::text"
CHANNEL_PATTERN = '^(cpu_core_[0-9]{1,2}|mainboard_channel_[1-9]|acpi_zone_[1-9])_temperature_c$'
CHANNEL_KEYS = ([f'cpu_core_{number}_temperature_c' for number in range(10)]
                + [f'cpu_core_{number:02d}_temperature_c' for number in range(100)]
                + [f'{prefix}_{number}_temperature_c' for prefix in ('mainboard_channel', 'acpi_zone') for number in range(1, 10)])


def code_ranges(sql):
    """Locate unquoted SQL, keeping doubled single/double quotes untouched."""
    start, index = 0, 0
    while index < len(sql):
        if sql[index] not in ("'", '"'):
            index += 1
            continue
        yield start, index
        quote = sql[index]
        index += 1
        while index < len(sql):
            if sql[index] == quote:
                index += 1
                if index < len(sql) and sql[index] == quote:
                    index += 1
                    continue
                break
            index += 1
        else:
            raise ValueError('Unbalanced view definition')
        start = index
    yield start, len(sql)


def replace_code(sql, pattern, replacement):
    result, previous = [], 0
    for start, end in code_ranges(sql):
        result.extend((sql[previous:start], re.sub(pattern, replacement, sql[start:end])))
        previous = end
    return ''.join(result)


def specialize_source(prefix, suffix, device):
    # Keep the actual indexed source predicate and original SELECT t.device_id column.
    prefix = replace_code(prefix, r'\b(CASE\s+)t\.device_id\b', lambda match: match[1] + device)
    suffix = replace_code(suffix, r'\bt\.device_id\b', lambda _match: device)
    pattern = re.compile(r'(?P<code>\bmetric\.key\s*~\s*)' + re.escape("'" + CHANNEL_PATTERN + "'::text"))
    ranges = list(code_ranges(suffix))
    replacement = 'metric.key = ANY (ARRAY[' + ','.join("'" + key + "'::text" for key in CHANNEL_KEYS) + '])'
    suffix = pattern.sub(lambda match: replacement if any(start <= match.start() and match.end('code') <= end
                                                        for start, end in ranges) else match[0], suffix)
    return prefix, suffix


def split_top_level(sql, keyword):
    pieces, start, depth, quote, index = [], 0, 0, None, 0
    while index < len(sql):
        character = sql[index]
        if quote:
            if character == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif character in ("'", '"'):
            quote = character
        elif character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
            if depth < 0:
                raise ValueError('Unbalanced view definition')
        elif depth == 0 and sql[index:index + len(keyword)].upper() == keyword:
            before = sql[index - 1] if index else ' '
            after = sql[index + len(keyword):index + len(keyword) + 1] or ' '
            if not (before.isalnum() or before == '_') and not (after.isalnum() or after == '_'):
                pieces.append(sql[start:index])
                index += len(keyword)
                start = index
                continue
        index += 1
    if quote or depth:
        raise ValueError('Unbalanced view definition')
    return pieces + [sql[start:]]


def closing_parenthesis(sql, opening):
    depth, quote, index = 0, None, opening
    while index < len(sql):
        character = sql[index]
        if quote:
            if character == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif character in ("'", '"'):
            quote = character
        elif character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError('Unclosed source predicate')


def source_branches(definition):
    original = definition.rstrip().removesuffix(';')
    if not original.lstrip().upper().startswith('SELECT '):
        raise ValueError('Expected a pg_get_viewdef SELECT snapshot')
    branches = split_top_level(original, 'UNION ALL')
    first = branches[0]
    source = re.search(r'\bWHERE\s+t\.site_id\s*=\s*' + LITERAL + r'\s+AND\s*\(', first)
    if not source or len(re.findall(r'\bFROM\s+iot\.telemetry\s+t\b', first)) != 1:
        raise ValueError('Unsupported leading temperature projection')
    opening = source.end() - 1
    closing = closing_parenthesis(first, opening)
    predicate = first[opening + 1:closing]
    terms = split_top_level(predicate, 'OR')
    if len(terms) < 2:
        raise ValueError('Expected the original disjunction, not an already rewritten view')
    identities, expanded = set(), []
    for term in terms:
        gateways = list(re.finditer(r't\.gateway_id\s*=\s*(' + LITERAL + ')', term))
        if len(gateways) != 1:
            raise ValueError('Every branch must have one gateway equality')
        direct = list(re.finditer(r't\.device_id\s*=\s*(' + LITERAL + ')', term))
        array = re.search(r't\.device_id\s*=\s*ANY\s*\(ARRAY\[(.*?)\]\)', term, re.S)
        if array and not direct:
            literals = re.findall(LITERAL, array.group(1))
            if not literals or re.sub(LITERAL + r'|\s|,', '', array.group(1)):
                raise ValueError('Unsupported device array')
            alternatives = [(value, term[:array.start()] + 't.device_id = ' + value + term[array.end():]) for value in literals]
        elif len(direct) == 1 and not array:
            alternatives = [(direct[0].group(1), term)]
        else:
            raise ValueError('Every branch must have one explicit device equality or array')
        for device, alternative in alternatives:
            identity = (gateways[0].group(1), device)
            if identity in identities:
                raise ValueError('Overlapping source identities would duplicate temperature rows')
            identities.add(identity)
            prefix, suffix = specialize_source(first[:opening + 1], first[closing:], device)
            expanded.append(prefix + alternative.strip() + suffix)
    return expanded + branches[1:], len(identities), branches


def render(view, definition):
    options = view.get('options') or []
    if any(not re.fullmatch(r'(security_barrier|security_invoker)=(true|false)', item) for item in options):
        raise ValueError('Unsupported view option; preserve it explicitly before rewriting')
    if 'security_barrier=true' not in options:
        raise ValueError('Refusing a snapshot without the existing security barrier')
    clause = ' WITH (' + ','.join(options) + ')' if options else ''
    return ('BEGIN;\nSET LOCAL lock_timeout=\'3s\';\nSET LOCAL statement_timeout=\'15s\';\n'
            + 'CREATE OR REPLACE VIEW iot.' + VIEW + clause + ' AS\n'
            + definition.rstrip().removesuffix(';') + ';\nCOMMIT;\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--rollback', type=Path, required=True)
    arguments = parser.parse_args()
    snapshot = json.loads(arguments.snapshot.read_text(encoding='utf-8-sig'))
    view = next(item for item in snapshot['views'] if item['name'] == VIEW)
    branches, identities, _ = source_branches(view['definition'])
    candidate = render(view, '\nUNION ALL\n'.join(branches))
    rollback = render(view, view['definition'])
    arguments.candidate.write_text(candidate, encoding='utf-8', newline='\n')
    arguments.rollback.write_text(rollback, encoding='utf-8', newline='\n')
    print(json.dumps({'sourceIdentities': identities, 'outputBranches': len(branches),
                      'candidateSha256': hashlib.sha256(candidate.encode()).hexdigest(),
                      'viewMetadataMustBeCheckedAfterApply': True}))


if __name__ == '__main__':
    main()
