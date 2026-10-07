server_id: "example-host" |
SELECT max_by(quality, generate_time_utc) AS latest_quality
FROM log
WHERE to_unixtime(from_iso8601_timestamp(generate_time_utc))
  BETWEEN to_unixtime(now()) - 900 AND to_unixtime(now()) + 60
