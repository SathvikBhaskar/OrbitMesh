CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'schedule_audit_log is append-only. Updates and deletes are forbidden.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER enforce_audit_log_append_only_update
BEFORE UPDATE ON schedule_audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();--> statement-breakpoint

CREATE TRIGGER enforce_audit_log_append_only_delete
BEFORE DELETE ON schedule_audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();