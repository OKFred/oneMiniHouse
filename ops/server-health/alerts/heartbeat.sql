server_id: "example-host" |
SELECT count(*) AS fresh_count
FROM log
WHERE to_unixtime(from_iso8601_timestamp(generate_time_utc))
  BETWEEN to_unixtime(now()) - 900 AND to_unixtime(now()) + 60
