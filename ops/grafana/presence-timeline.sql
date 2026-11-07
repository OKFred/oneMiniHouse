-- Owner-run, additive. Requires the exact private registry and both restricted reader views.
-- The function is SECURITY INVOKER: Grafana needs only these views, never the base table.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE FUNCTION iot.home_presence_timeline(p_from timestamptz,p_to timestamptz)
RETURNS TABLE(
  start_time_utc timestamptz,end_time_utc timestamptz,physical_device_id text,device_name text,kind text,state text,basis text,
  last_heartbeat_time_utc timestamptz,last_heartbeat_source_time_utc timestamptz,last_observed_time_utc timestamptz,
  reporter_id text,boot_id text,session_id uuid,observer_client_id text,observer_session_id uuid,parent_id text
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,iot AS $function$
DECLARE
  registry jsonb; visible_ids text[]; registry_count integer; unique_count integer;
  latest_device jsonb:='{}'; latest_coverage jsonb:='{}'; spans jsonb:='{}';
  item record; at_time timestamptz:=p_from; id text; node_id text; visited text[];
  own_config jsonb; node_config jsonb; own_event jsonb; node_event jsonb; coverage jsonb; parent_event jsonb;
  node_state text; own_state text; own_basis text; parent_key text; coverage_key text;
  signature jsonb; previous jsonb; current_span jsonb; invalid_parent boolean;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to THEN
    RAISE EXCEPTION 'Presence requires a finite increasing UTC range' USING ERRCODE='22023';
  END IF;
  SELECT count(*),count(DISTINCT r.physical_device_id),coalesce(jsonb_object_agg(r.physical_device_id,to_jsonb(r)),'{}'),
    coalesce(array_agg(r.physical_device_id ORDER BY r.physical_device_id) FILTER(WHERE r.visible),ARRAY[]::text[])
    INTO registry_count,unique_count,registry,visible_ids FROM iot.home_presence_registry r;
  IF registry_count<>unique_count OR registry_count>256 THEN
    RAISE EXCEPTION 'Presence registry identities must be unique and bounded' USING ERRCODE='22023';
  END IF;

  -- Event/lease boundaries only. No minute grid and no temperature table or JSON metric expansion.
  FOR item IN
    WITH raw_device_events AS MATERIALIZED(
      SELECT e.physical_device_id,e.site_id,e.kind,e.observer_client_id,e.observer_session_id,e.observed_time_utc,e.observation_order,
        e.state_after,e.reason,e.decision,e.reporter_id,e.boot_id,e.session_id,e.valid_until_utc
      FROM iot.home_presence_registry r CROSS JOIN LATERAL(
        SELECT e.* FROM iot.home_device_presence_events e
        WHERE e.site_id=r.site_id AND e.physical_device_id=r.physical_device_id AND e.applied AND NOT e.retained AND e.observed_time_utc<p_from
        ORDER BY e.observed_time_utc DESC,e.observation_order DESC LIMIT 1
      ) e
      UNION ALL
      SELECT e.physical_device_id,e.site_id,e.kind,e.observer_client_id,e.observer_session_id,e.observed_time_utc,e.observation_order,
        e.state_after,e.reason,e.decision,e.reporter_id,e.boot_id,e.session_id,e.valid_until_utc
      FROM iot.home_device_presence_events e JOIN iot.home_presence_registry r
        ON e.site_id=r.site_id AND e.physical_device_id=r.physical_device_id
      WHERE e.applied AND NOT e.retained AND e.observed_time_utc>=p_from AND e.observed_time_utc<p_to
    ), device_points AS(
      -- All receipts at one millisecond are applied in intake order; only the final frozen state spans time.
      SELECT DISTINCT ON(e.physical_device_id,e.observed_time_utc) e.*,
        jsonb_build_array(e.kind,e.state_after,CASE WHEN e.state_after='offline' THEN e.reason WHEN e.state_after='unknown' THEN e.decision END,
          e.reporter_id,e.boot_id,e.session_id,e.observer_client_id,e.observer_session_id) AS signature
      FROM raw_device_events e ORDER BY e.physical_device_id,e.observed_time_utc,e.observation_order DESC
    ), device_breaks AS(
      SELECT e.*,CASE WHEN lag(e.signature) OVER w IS DISTINCT FROM e.signature
        OR (e.state_after='online' AND (lag(e.valid_until_utc) OVER w IS NULL OR e.observed_time_utc>lag(e.valid_until_utc) OVER w)) THEN 1 ELSE 0 END AS begins
      FROM device_points e WINDOW w AS(PARTITION BY e.physical_device_id ORDER BY e.observed_time_utc,e.observation_order)
    ), device_groups AS(
      SELECT e.*,sum(e.begins) OVER(PARTITION BY e.physical_device_id ORDER BY e.observed_time_utc,e.observation_order) AS run_id FROM device_breaks e
    ), device_events AS MATERIALIZED(
      -- Consecutive heartbeats have one state interval. Keep TTL holes, instance changes and unknown decisions.
      SELECT e.physical_device_id,min(e.site_id) AS site_id,min(e.observer_client_id) AS observer_client_id,
        min(e.observed_time_utc) AS observed_time_utc,(array_agg(e.observation_order ORDER BY e.observed_time_utc,e.observation_order))[1] AS observation_order,
        (array_agg(e.valid_until_utc ORDER BY e.observed_time_utc DESC,e.observation_order DESC))[1] AS valid_until_utc,
        jsonb_build_object('physical_device_id',e.physical_device_id,'site_id',min(e.site_id),'kind',min(e.kind),
          'observer_client_id',min(e.observer_client_id),'observer_session_id',min(e.observer_session_id::text),
          'observed_time_utc',min(e.observed_time_utc),'state_after',min(e.state_after),'reason',min(e.reason),'decision',min(e.decision),
          'reporter_id',min(e.reporter_id),'boot_id',min(e.boot_id),'session_id',min(e.session_id::text),
          'valid_until_utc',(array_agg(e.valid_until_utc ORDER BY e.observed_time_utc DESC,e.observation_order DESC))[1]) AS payload
      FROM device_groups e GROUP BY e.physical_device_id,e.run_id
    ), observer_keys AS(
      SELECT r.site_id,r.observer_client_id FROM iot.home_presence_registry r
      UNION SELECT e.site_id,e.observer_client_id FROM device_events e
    ), raw_coverage_events AS(
      SELECT c.* FROM observer_keys k CROSS JOIN LATERAL(
        SELECT c.* FROM iot.home_presence_observer_coverage c
        WHERE c.site_id=k.site_id AND c.observer_client_id=k.observer_client_id AND c.observed_time_utc<p_from
        ORDER BY c.observed_time_utc DESC,c.observation_order DESC LIMIT 1
      ) c
      UNION ALL
      SELECT c.* FROM iot.home_presence_observer_coverage c JOIN observer_keys k
        ON c.site_id=k.site_id AND c.observer_client_id=k.observer_client_id
      WHERE c.observed_time_utc>=p_from AND c.observed_time_utc<p_to
    ), coverage_points AS(
      SELECT DISTINCT ON(c.site_id,c.observer_client_id,c.observed_time_utc) c.* FROM raw_coverage_events c
      ORDER BY c.site_id,c.observer_client_id,c.observed_time_utc,c.observation_order DESC
    ), coverage_breaks AS(
      SELECT c.*,CASE WHEN lag(c.observer_session_id) OVER w IS DISTINCT FROM c.observer_session_id
        OR (c.event='coverage_end') IS DISTINCT FROM (lag(c.event) OVER w='coverage_end')
        OR (c.event<>'coverage_end' AND (lag(c.coverage_until_utc) OVER w IS NULL OR c.observed_time_utc>lag(c.coverage_until_utc) OVER w)) THEN 1 ELSE 0 END AS begins
      FROM coverage_points c WINDOW w AS(PARTITION BY c.site_id,c.observer_client_id ORDER BY c.observed_time_utc,c.observation_order)
    ), coverage_groups AS(
      SELECT c.*,sum(c.begins) OVER(PARTITION BY c.site_id,c.observer_client_id ORDER BY c.observed_time_utc,c.observation_order) AS run_id FROM coverage_breaks c
    ), coverage_events AS MATERIALIZED(
      SELECT c.site_id,c.observer_client_id,min(c.observed_time_utc) AS observed_time_utc,
        (array_agg(c.observation_order ORDER BY c.observed_time_utc,c.observation_order))[1] AS observation_order,
        (array_agg(c.coverage_until_utc ORDER BY c.observed_time_utc DESC,c.observation_order DESC))[1] AS coverage_until_utc,
        jsonb_build_object('site_id',c.site_id,'observer_client_id',c.observer_client_id,'observer_session_id',min(c.observer_session_id::text),
          'event',CASE WHEN bool_and(c.event='coverage_end') THEN 'coverage_end' ELSE 'coverage_heartbeat' END,
          'coverage_until_utc',(array_agg(c.coverage_until_utc ORDER BY c.observed_time_utc DESC,c.observation_order DESC))[1]) AS payload
      FROM coverage_groups c GROUP BY c.site_id,c.observer_client_id,c.run_id
    ), boundaries AS(
      SELECT greatest(e.observed_time_utc,p_from) AS boundary,e.observed_time_utc AS original_time,e.observation_order,'device'::text AS action,e.payload FROM device_events e
      UNION ALL SELECT greatest(c.observed_time_utc,p_from),c.observed_time_utc,c.observation_order,'observer',c.payload FROM coverage_events c
      UNION ALL SELECT e.valid_until_utc,e.valid_until_utc,0,'tick','{}'::jsonb FROM device_events e WHERE e.valid_until_utc>p_from AND e.valid_until_utc<p_to
      UNION ALL SELECT c.coverage_until_utc,c.coverage_until_utc,0,'tick','{}'::jsonb FROM coverage_events c WHERE c.coverage_until_utc>p_from AND c.coverage_until_utc<p_to
      UNION ALL SELECT p_from,p_from,0,'tick','{}'::jsonb
      UNION ALL SELECT p_to,p_to,0,'tick','{}'::jsonb
    ) SELECT * FROM boundaries ORDER BY boundary,original_time,observation_order,action
  LOOP
    IF item.boundary>at_time THEN
      FOREACH id IN ARRAY visible_ids LOOP
        own_config:=registry->id;own_event:=latest_device->id;node_id:=id;visited:=ARRAY[]::text[];
        own_state:='unknown';own_basis:='no_observation';invalid_parent:=false;
        LOOP
          IF node_id=ANY(visited) OR cardinality(visited)>=256 THEN
            invalid_parent:=true;own_basis:='dependency_cycle';EXIT;
          END IF;
          visited:=array_append(visited,node_id);node_config:=registry->node_id;node_event:=latest_device->node_id;
          node_state:='unknown';
          IF node_config IS NULL OR node_event IS NULL THEN
            IF node_id=id THEN own_basis:='no_observation';ELSE invalid_parent:=true;own_basis:='parent_unknown';END IF;
          ELSE
            coverage_key:=(node_event->>'site_id')||'/'||(node_event->>'observer_client_id');coverage:=latest_coverage->coverage_key;
            IF coverage IS NULL OR coverage->>'event'='coverage_end'
              OR coverage->>'observer_session_id' IS DISTINCT FROM node_event->>'observer_session_id'
              OR (coverage->>'coverage_until_utc')::timestamptz<=at_time THEN
              IF node_id=id THEN own_basis:='observer_unknown';END IF;
            ELSIF node_config->>'kind'='cached' OR node_event->>'kind'='cached' THEN
              IF node_id=id THEN own_basis:='cached_only';END IF;
            ELSE
              node_state:=node_event->>'state_after';
              IF node_state='online' AND ((node_event->>'valid_until_utc') IS NULL OR (node_event->>'valid_until_utc')::timestamptz<=at_time) THEN
                node_state:='offline';IF node_id=id THEN own_basis:='heartbeat_expired';END IF;
              ELSIF node_id=id THEN
                own_basis:=CASE WHEN node_state='online' THEN CASE WHEN node_config->>'kind'='proxy' THEN 'fresh_direct_read' ELSE 'fresh_heartbeat' END
                  WHEN node_state='offline' THEN CASE node_event->>'reason' WHEN 'lwt' THEN 'lwt_observed' WHEN 'shutdown' THEN 'shutdown_observed' ELSE 'read_failed' END
                  ELSE coalesce(node_event->>'decision','upstream_unknown') END;
              END IF;
            END IF;
          END IF;
          IF node_id=id THEN own_state:=node_state;
          ELSIF node_state<>'online' THEN invalid_parent:=true;own_basis:='parent_unknown';EXIT;END IF;
          parent_key:=node_config->>'parent_id';IF parent_key IS NULL THEN EXIT;END IF;
          parent_event:=latest_device->parent_key;
          IF node_event IS NOT NULL AND parent_event IS NOT NULL
            AND node_event->>'reporter_id'=parent_event->>'reporter_id'
            AND node_event->>'session_id' IS DISTINCT FROM parent_event->>'session_id' THEN
            invalid_parent:=true;own_basis:='parent_session_changed';EXIT;
          END IF;
          node_id:=parent_key;
        END LOOP;
        IF invalid_parent THEN own_state:='unknown';END IF;
        signature:=jsonb_build_object('state',own_state,'basis',own_basis,'reporter_id',own_event->>'reporter_id','boot_id',own_event->>'boot_id',
          'session_id',own_event->>'session_id','observer_client_id',own_event->>'observer_client_id','observer_session_id',own_event->>'observer_session_id',
          'parent_id',own_config->>'parent_id');
        previous:=spans->id;
        IF previous IS NOT NULL AND previous->'signature' IS DISTINCT FROM signature THEN
          start_time_utc:=(previous->>'start')::timestamptz;end_time_utc:=at_time;physical_device_id:=id;device_name:=own_config->>'device_name';kind:=own_config->>'kind';
          state:=previous#>>'{signature,state}';basis:=previous#>>'{signature,basis}';
          reporter_id:=previous#>>'{signature,reporter_id}';boot_id:=previous#>>'{signature,boot_id}';
          session_id:=(previous#>>'{signature,session_id}')::uuid;observer_client_id:=previous#>>'{signature,observer_client_id}';
          observer_session_id:=(previous#>>'{signature,observer_session_id}')::uuid;parent_id:=previous#>>'{signature,parent_id}';
          IF start_time_utc<end_time_utc THEN
            SELECT e.observed_time_utc,e.source_time_utc INTO last_heartbeat_time_utc,last_heartbeat_source_time_utc
              FROM iot.home_device_presence_events e WHERE e.site_id=own_config->>'site_id' AND e.physical_device_id=id
                AND e.online AND e.state_after='online' AND e.observed_time_utc<end_time_utc
              ORDER BY e.observed_time_utc DESC,e.observation_order DESC LIMIT 1;
            SELECT e.observed_time_utc INTO last_observed_time_utc FROM iot.home_device_presence_events e
              WHERE e.site_id=own_config->>'site_id' AND e.physical_device_id=id AND e.observed_time_utc<end_time_utc
              ORDER BY e.observed_time_utc DESC,e.observation_order DESC LIMIT 1;
            RETURN NEXT;
          END IF;
        END IF;
        current_span:=jsonb_build_object('signature',signature,'start',CASE WHEN previous IS NOT NULL AND previous->'signature'=signature THEN previous->>'start' ELSE at_time::text END);
        spans:=jsonb_set(spans,ARRAY[id],current_span,true);
      END LOOP;
      at_time:=item.boundary;
    END IF;
    IF item.action='device' THEN
      latest_device:=jsonb_set(latest_device,ARRAY[item.payload->>'physical_device_id'],item.payload,true);
    ELSIF item.action='observer' THEN
      latest_coverage:=jsonb_set(latest_coverage,ARRAY[(item.payload->>'site_id')||'/'||(item.payload->>'observer_client_id')],item.payload,true);
    END IF;
  END LOOP;
  FOREACH id IN ARRAY visible_ids LOOP
    previous:=spans->id;IF previous IS NULL THEN CONTINUE;END IF;own_config:=registry->id;
    start_time_utc:=(previous->>'start')::timestamptz;end_time_utc:=p_to;physical_device_id:=id;device_name:=own_config->>'device_name';kind:=own_config->>'kind';
    state:=previous#>>'{signature,state}';basis:=previous#>>'{signature,basis}';
    reporter_id:=previous#>>'{signature,reporter_id}';boot_id:=previous#>>'{signature,boot_id}';
    session_id:=(previous#>>'{signature,session_id}')::uuid;observer_client_id:=previous#>>'{signature,observer_client_id}';
    observer_session_id:=(previous#>>'{signature,observer_session_id}')::uuid;parent_id:=previous#>>'{signature,parent_id}';
    IF start_time_utc<end_time_utc THEN
      SELECT e.observed_time_utc,e.source_time_utc INTO last_heartbeat_time_utc,last_heartbeat_source_time_utc
        FROM iot.home_device_presence_events e WHERE e.site_id=own_config->>'site_id' AND e.physical_device_id=id
          AND e.online AND e.state_after='online' AND e.observed_time_utc<end_time_utc
        ORDER BY e.observed_time_utc DESC,e.observation_order DESC LIMIT 1;
      SELECT e.observed_time_utc INTO last_observed_time_utc FROM iot.home_device_presence_events e
        WHERE e.site_id=own_config->>'site_id' AND e.physical_device_id=id AND e.observed_time_utc<end_time_utc
        ORDER BY e.observed_time_utc DESC,e.observation_order DESC LIMIT 1;
      RETURN NEXT;
    END IF;
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION iot.home_presence_timeline(timestamptz,timestamptz) FROM PUBLIC;
COMMENT ON FUNCTION iot.home_presence_timeline(timestamptz,timestamptz) IS '受限在线时间轴：只消费首次冻结决定与实时观察覆盖，按事件及TTL边界归并；无事件、缓存、观察缺口或父依赖未知保留unknown，隐藏逻辑节点不计物理设备。';
DO $grant$
DECLARE reader text:=nullif(current_setting('one_min_house.grafana_role',true),'');
BEGIN
  IF reader IS NULL THEN RAISE EXCEPTION 'Set one_min_house.grafana_role before presence timeline migration';END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA iot TO %I',reader);
  EXECUTE format('GRANT SELECT ON iot.home_presence_registry,iot.home_device_presence_events,iot.home_presence_observer_coverage TO %I',reader);
  EXECUTE format('GRANT EXECUTE ON FUNCTION iot.home_presence_timeline(timestamptz,timestamptz) TO %I',reader);
END $grant$;
COMMIT;
