-- Quintara, migration 0035: photographs in object storage.
-- The bytes of a photograph may now live in an S3-compatible bucket instead of the database: its media row (and its
-- variants) then keep the details but no data. Photographs stored before keep their bytes here and are served as before.
ALTER TABLE media ALTER COLUMN data_base64 DROP NOT NULL;
ALTER TABLE media_variants ALTER COLUMN data_base64 DROP NOT NULL;

-- Every photograph deleted (a replaced picture, an erased account, a removed product photograph), whoever deletes it,
-- is queued here so its files are removed from the bucket too. Housekeeping empties the queue.
CREATE TABLE media_purge (
  media_id    UUID PRIMARY KEY,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION media_queue_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media_purge (media_id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER media_purge_on_delete AFTER DELETE ON media FOR EACH ROW EXECUTE FUNCTION media_queue_purge();
