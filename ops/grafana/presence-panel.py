"""Add one native presence panel to a private current Grafana V2 resource; never deploy."""

import argparse
import copy
import hashlib
import json
from pathlib import Path


TEMPERATURE_VIEWS = ('home_server_temperature_samples', 'home_phone_temperature_samples', 'home_host_health_temperature_samples')
DESCRIPTION = ('每个已登记的可见物理设备一行，使用全局时间范围，不受温度分类影响。'
               '绿＝新鲜在线证据且观察链路、父依赖有效；红＝已观察离线或在有效观察期间心跳超时/直接读取失败。'
               '失联不等于关机；灰＝未知，包括未采集的历史、缓存数据、接收链路缺口和父依赖未知。'
               '固定安装切点之前，绿色仅为正常直接上报向前TTL的“历史上报推断”，空档保持未知，不推测精确离线或旧实例；之后只用实时presence。'
               '悬停显示截至该区间结束的最后已知心跳、观察与实例；历史推断单独显示读取/接收时间，时间注明 UTC，不是光标时刻的新读数。'
               '数据源或 SQL 查询失败请查看面板错误，不能当成设备离线。')
QUERY = """WITH intervals AS MATERIALIZED (
  SELECT * FROM iot.home_presence_display_timeline($__timeFrom()::timestamptz,$__timeTo()::timestamptz)
), names AS (
  SELECT device_name,count(DISTINCT physical_device_id) AS devices FROM intervals GROUP BY device_name
)
SELECT p.start_time_utc AS "time",p.end_time_utc AS time_end,
  CASE WHEN n.devices>1 THEN p.device_name||' ['||p.physical_device_id||']' ELSE p.device_name END AS device_name,
  concat(
    CASE WHEN p.state='online' THEN CASE WHEN p.basis='历史上报推断' THEN '在线（历史推断）' ELSE '在线' END WHEN p.state='offline' THEN
      CASE WHEN p.basis IN('heartbeat_expired','read_failed') THEN '失联' ELSE '离线' END ELSE '未知' END,
    E'\\n依据：',CASE p.basis
      WHEN 'fresh_heartbeat' THEN '新鲜心跳' WHEN 'fresh_direct_read' THEN '新鲜直接读取'
      WHEN 'heartbeat_expired' THEN '有效观察期间心跳超时' WHEN 'lwt_observed' THEN '已观察当前会话遗嘱'
      WHEN 'shutdown_observed' THEN '已观察当前会话主动退出' WHEN 'read_failed' THEN '直接读取失败'
      WHEN 'no_observation' THEN '无历史证据' WHEN 'observer_unknown' THEN '接收观察链路未知'
      WHEN 'cached_only' THEN '仅有缓存，不能证明在线' WHEN 'parent_unknown' THEN '父依赖未知'
      WHEN 'parent_session_changed' THEN '父依赖实例已变化' WHEN 'dependency_cycle' THEN '依赖关系异常'
      WHEN 'pending_reporter_session' THEN '等待新报告实例的后续新鲜心跳'
      WHEN 'pending_candidate_session' THEN '等待候选实例的后续新鲜心跳'
      WHEN 'pending_retained_session' THEN '保留快照不能证明在线，等待实时心跳'
      WHEN 'before_observer_coverage' THEN '证据早于本次有效观察覆盖'
      ELSE coalesce(p.basis,'无证据') END,
    CASE WHEN p.basis IN('历史上报推断','历史无直接证据') THEN concat(
      E'\\n历史最后直接读取（UTC）：',coalesce(to_char(p.history_read_time_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'无直接证据'),
      E'\\n该历史报文首次接收（UTC）：',coalesce(to_char(p.history_receive_time_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'无直接证据'),
      E'\\n历史实例：未记录，不推断')
    ELSE concat(
      E'\\n截至区间结束的最后心跳（UTC）：',coalesce(to_char(p.last_heartbeat_time_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'无证据'),
      E'\\n心跳源时间（UTC）：',coalesce(to_char(p.last_heartbeat_source_time_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'无证据'),
      E'\\n最后观察（UTC）：',coalesce(to_char(p.last_observed_time_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'无证据'),
      E'\\n报告实例：',coalesce(p.reporter_id,'未知'),' / ',coalesce(p.boot_id,'未知'),' / ',coalesce(p.session_id::text,'未知'),
      E'\\n观察实例：',coalesce(p.observer_client_id,'未知'),' / ',coalesce(p.observer_session_id::text,'未知')) END,
    CASE WHEN p.parent_id IS NULL THEN '' ELSE E'\\n父依赖（配置）：'||p.parent_id END
  ) AS presence
FROM intervals p JOIN names n ON n.device_name=p.device_name
ORDER BY device_name,p.start_time_utc;"""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def queries(panel):
    return panel.get('spec', {}).get('data', {}).get('spec', {}).get('queries', [])


def query_sql(panel_query):
    return panel_query.get('spec', {}).get('query', {}).get('spec', {}).get('rawSql', '')


def references(value):
    if isinstance(value, dict):
        if value.get('kind') == 'ElementReference':
            yield value['name']
        for child in value.values():
            yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)


def temperature_context(resource):
    if resource.get('kind') != 'Dashboard' or not isinstance(resource.get('spec', {}).get('elements'), dict):
        raise ValueError('Expected the current Grafana V2 Dashboard resource')
    elements = resource['spec']['elements']
    if any(any(function in query_sql(query) for function in ('home_presence_timeline', 'home_presence_display_timeline'))
           for panel in elements.values() for query in queries(panel)):
        raise ValueError('Presence panel already exists; refresh the baseline instead of adding a duplicate')
    matching = [(name, panel) for name, panel in elements.items()
                if any(all(view in query_sql(query) for view in TEMPERATURE_VIEWS) for query in queries(panel))]
    if len(matching) != 1:
        raise ValueError('Expected one existing three-source device-temperature element')
    name, panel = matching[0]
    if panel.get('kind') != 'Panel' or len(queries(panel)) != 1:
        raise ValueError('Unsupported existing temperature query group')
    query = queries(panel)[0]
    data_query = query.get('spec', {}).get('query', {})
    if data_query.get('kind') != 'DataQuery' or data_query.get('group') != 'grafana-postgresql-datasource' or not data_query.get('datasource', {}).get('name'):
        raise ValueError('Expected the existing PostgreSQL datasource reference')
    layout = resource['spec'].get('layout', {})
    if layout.get('kind') != 'TabsLayout':
        raise ValueError('Expected the existing top-level tabs')
    tabs = layout['spec']['tabs']
    indices = [index for index, tab in enumerate(tabs) if name in list(references(tab))]
    if len(indices) != 1:
        raise ValueError('Temperature element must occur in exactly one tab')
    index = indices[0]
    tab = tabs[index]
    current_layout = tab['spec']['layout']
    variables = tab['spec'].get('variables', [])
    if current_layout.get('kind') != 'AutoGridLayout' or list(references(current_layout)) != [name]:
        raise ValueError('Expected the original single-panel temperature auto grid')
    if len(variables) != 1 or variables[0].get('spec', {}).get('name') != 'temperature_category':
        raise ValueError('Expected the original tab-scoped temperature-category control')
    if any(key in tab['spec'] for key in ('repeat', 'conditionalRendering', 'annotations')):
        raise ValueError('Unsupported Devices tab scope; preserve it explicitly before rewriting')
    return name, panel, index


def presence_panel(temperature, panel_id):
    query = copy.deepcopy(queries(temperature)[0])
    query['spec'].update(hidden=False, refId='A')
    query['spec']['query']['spec'] = {'editorMode': 'code', 'format': 'table', 'rawQuery': True, 'rawSql': QUERY}
    mappings = [{'type': 'regex', 'options': {'pattern': '^' + status + r'[\s\S]*$', 'result': {'color': color}}}
                for status, color in [('在线', '#73BF69'), ('离线', '#F2495C'), ('失联', '#F2495C'), ('未知', '#8E8E8E')]]
    return {'kind': 'Panel', 'spec': {
        'id': panel_id, 'title': '物理设备在线状态', 'description': DESCRIPTION, 'links': [],
        'data': {'kind': 'QueryGroup', 'spec': {'queries': [query], 'queryOptions': {}, 'transformations': [
            {'kind': 'Transformation', 'group': 'partitionByValues', 'spec': {'options': {
                'fields': ['device_name'], 'keepFields': False, 'naming': {'asLabels': True}}}}]}},
        'vizConfig': {'kind': 'VizConfig', 'group': 'state-timeline', 'version': temperature['spec']['vizConfig']['version'], 'spec': {
            'fieldConfig': {'defaults': {'color': {'mode': 'fixed', 'fixedColor': '#8E8E8E'}, 'mappings': mappings,
                                         'noValue': '暂无状态证据，请检查面板查询',
                                         'custom': {'lineWidth': 0, 'fillOpacity': 90, 'axisPlacement': 'left',
                                                    'hideFrom': {'legend': False, 'tooltip': False, 'viz': False}}},
                            'overrides': [{'matcher': {'id': 'byName', 'options': 'presence'}, 'properties': [
                                {'id': 'displayName', 'value': '${__field.labels.device_name}'}, {'id': 'unit', 'value': 'string'}]}]},
            'options': {'mergeValues': False, 'showValue': 'never', 'rowHeight': 0.8, 'perPage': 0,
                        'legend': {'showLegend': False, 'displayMode': 'list', 'placement': 'bottom', 'calcs': []},
                        'tooltip': {'mode': 'single', 'sort': 'none', 'maxHeight': 480, 'maxWidth': 520}}
        }}}}


def section_layout(original_layout, variables, name, height):
    return {'kind': 'RowsLayout', 'spec': {'rows': [
        {'kind': 'RowsLayoutRow', 'spec': {'title': '在线状态', 'collapse': False, 'hideHeader': True,
            'layout': {'kind': 'GridLayout', 'spec': {'items': [{'kind': 'GridLayoutItem', 'spec': {
                'element': {'kind': 'ElementReference', 'name': name}, 'height': height, 'width': 24, 'x': 0, 'y': 0}}]}}}},
        {'kind': 'RowsLayoutRow', 'spec': {'title': '设备温度', 'collapse': False, 'hideHeader': False,
            'variables': copy.deepcopy(variables), 'layout': copy.deepcopy(original_layout)}}
    ]}}


def render(resource, height=18):
    if type(height) is not int or not 12 <= height <= 40:
        raise ValueError('Presence height must be 12..40 grid rows')
    temperature_name, temperature, tab_index = temperature_context(resource)
    candidate = copy.deepcopy(resource)
    elements = candidate['spec']['elements']
    ids = [element.get('spec', {}).get('id') for element in elements.values() if element.get('kind') == 'Panel']
    if any(type(value) is not int or value < 0 for value in ids) or len(ids) != len(set(ids)):
        raise ValueError('Existing panel IDs must be unique nonnegative integers')
    panel_id = max(ids, default=0) + 1
    while 'panel-' + str(panel_id) in elements:
        panel_id += 1
    name = 'panel-' + str(panel_id)
    elements[name] = presence_panel(temperature, panel_id)
    tab_spec = candidate['spec']['layout']['spec']['tabs'][tab_index]['spec']
    original_layout, variables = tab_spec['layout'], tab_spec.pop('variables')
    tab_spec['layout'] = section_layout(original_layout, variables, name, height)
    scope = verify_scope(resource, candidate, name, temperature_name, tab_index, height)
    return candidate, scope


def verify_scope(before, after, new_name, temperature_name, tab_index, height):
    old_elements, new_elements = before['spec']['elements'], after['spec']['elements']
    if set(new_elements) != set(old_elements) | {new_name} or new_name in old_elements:
        raise ValueError('Only one new element is allowed')
    if any(canonical(panel) != canonical(new_elements[name]) for name, panel in old_elements.items()):
        raise ValueError('An existing element changed')
    old_tab = before['spec']['layout']['spec']['tabs'][tab_index]
    new_tab = after['spec']['layout']['spec']['tabs'][tab_index]
    expected_tab = copy.deepcopy(old_tab)
    expected_tab['spec'].pop('variables')
    expected_tab['spec']['layout'] = copy.deepcopy(new_tab['spec']['layout'])
    if expected_tab != new_tab:
        raise ValueError('Devices tab changed beyond its layout and category-control scope')
    if new_tab['spec']['layout'] != section_layout(old_tab['spec']['layout'], old_tab['spec']['variables'], new_name, height):
        raise ValueError('Unexpected Devices section position, size or control placement')
    rows = new_tab['spec']['layout']['spec']['rows']
    if len(rows) != 2 or rows[1]['spec']['layout'] != old_tab['spec']['layout'] or rows[1]['spec']['variables'] != old_tab['spec']['variables']:
        raise ValueError('Original temperature layout/control was not preserved exactly')
    if list(references(rows[0])) != [new_name] or list(references(rows[1])) != [temperature_name] or 'variables' in rows[0]['spec']:
        raise ValueError('Presence must precede the temperature control and original panel')
    if new_elements[new_name] != presence_panel(old_elements[temperature_name], new_elements[new_name]['spec']['id']):
        raise ValueError('Unexpected presence-panel configuration')
    projection = copy.deepcopy(after)
    del projection['spec']['elements'][new_name]
    projection['spec']['layout']['spec']['tabs'][tab_index] = copy.deepcopy(old_tab)
    if canonical(projection) != canonical(before):
        raise ValueError('Dashboard changed outside the approved element and Devices tab')
    return {'new_element': new_name, 'before_elements': len(old_elements), 'after_elements': len(new_elements),
            'existing_elements_unchanged': len(old_elements), 'existing_elements_sha256': digest(old_elements),
            'other_spec_and_metadata_unchanged': True, 'other_tabs_unchanged': len(before['spec']['layout']['spec']['tabs']) - 1,
            'temperature_element_unchanged': temperature_name, 'temperature_query_unchanged': True,
            'devices_tab_index': tab_index, 'height_grid_rows': height, 'global_time_only': True,
            'temperature_category_control_moved_unchanged_to_temperature_row': True,
            'allowed_changed_paths': ['/spec/elements/' + new_name,
                f'/spec/layout/spec/tabs/{tab_index}/spec/layout', f'/spec/layout/spec/tabs/{tab_index}/spec/variables'],
            'baseline_canonical_sha256': digest(before), 'candidate_canonical_sha256': digest(after),
            'browser_and_datasource_acceptance_required': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--scope-diff', type=Path, required=True)
    parser.add_argument('--height-rows', type=int, default=18)
    args = parser.parse_args()
    local = Path(__file__).resolve().parents[2] / '.local'
    if any(not path.resolve().is_relative_to(local.resolve()) for path in (args.candidate, args.scope_diff)):
        parser.error('Private dashboard outputs must stay within this checkout .local directory')
    if args.candidate.resolve() == args.scope_diff.resolve() or any(path.exists() for path in (args.candidate, args.scope_diff)):
        parser.error('Use distinct new output files; existing evidence is never overwritten')
    resource = json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
    candidate, scope = render(resource, args.height_rows)
    for path, value in ((args.candidate, candidate), (args.scope_diff, scope)):
        with path.open('x', encoding='utf-8', newline='\n') as output:
            output.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'before_elements': scope['before_elements'], 'after_elements': scope['after_elements'],
                      'existing_elements_unchanged': scope['existing_elements_unchanged'],
                      'other_spec_and_metadata_unchanged': True, 'candidate_canonical_sha256': scope['candidate_canonical_sha256'],
                      'deployed': False}))


if __name__ == '__main__':
    main()
