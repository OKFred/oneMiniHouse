CREATE TABLE raw_message (
  raw_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  data_kind TEXT NOT NULL CHECK(data_kind IN ('inline','object_ref')),
  content_type TEXT NOT NULL,
  raw_data TEXT NOT NULL,
  raw_data_sha256 TEXT NOT NULL CHECK(length(raw_data_sha256)=64),
  generate_time_utc INTEGER,
  receive_time_utc INTEGER NOT NULL,
  store_time_utc INTEGER NOT NULL,
  expire_time_utc INTEGER NOT NULL,
  source_message_id TEXT,
  source_site_id TEXT,
  source_gateway_id TEXT,
  source_device_id TEXT,
  mirror_store_time_utc INTEGER NOT NULL
);
CREATE INDEX raw_message_expiry ON raw_message(expire_time_utc);
CREATE INDEX raw_message_device_time ON raw_message(source_device_id,generate_time_utc);
-- Prevent conflicting replay atomically, including across concurrent requests.
CREATE TRIGGER raw_message_immutable BEFORE INSERT ON raw_message
WHEN EXISTS (SELECT 1 FROM raw_message WHERE raw_id=NEW.raw_id AND
  (raw_data_sha256<>NEW.raw_data_sha256 OR topic<>NEW.topic OR source_kind<>NEW.source_kind OR source_id<>NEW.source_id
   OR data_kind<>NEW.data_kind OR content_type<>NEW.content_type OR raw_data<>NEW.raw_data
   OR generate_time_utc IS NOT NEW.generate_time_utc OR receive_time_utc<>NEW.receive_time_utc
   OR store_time_utc<>NEW.store_time_utc OR expire_time_utc<>NEW.expire_time_utc
   OR source_message_id IS NOT NEW.source_message_id OR source_site_id IS NOT NEW.source_site_id
   OR source_gateway_id IS NOT NEW.source_gateway_id OR source_device_id IS NOT NEW.source_device_id))
BEGIN SELECT RAISE(ABORT,'RAW_ID_CONFLICT'); END;
