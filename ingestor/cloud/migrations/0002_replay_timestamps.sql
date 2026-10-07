-- Recovery may import the same immutable source into a new local archive.
-- Keep the original cloud receive/store/expiry values; changed copy timestamps
-- do not turn identical source content into a conflict or extend retention.
DROP TRIGGER raw_message_immutable;
CREATE TRIGGER raw_message_immutable BEFORE INSERT ON raw_message
WHEN EXISTS (SELECT 1 FROM raw_message WHERE raw_id=NEW.raw_id AND
  (raw_data_sha256<>NEW.raw_data_sha256 OR topic<>NEW.topic OR source_kind<>NEW.source_kind OR source_id<>NEW.source_id
   OR data_kind<>NEW.data_kind OR content_type<>NEW.content_type OR raw_data<>NEW.raw_data
   OR generate_time_utc IS NOT NEW.generate_time_utc
   OR source_message_id IS NOT NEW.source_message_id OR source_site_id IS NOT NEW.source_site_id
   OR source_gateway_id IS NOT NEW.source_gateway_id OR source_device_id IS NOT NEW.source_device_id))
BEGIN SELECT RAISE(ABORT,'RAW_ID_CONFLICT'); END;
