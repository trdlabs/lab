CREATE OR REPLACE FUNCTION agent_event_notify() RETURNS trigger AS $$
BEGIN
  -- Minimal, safe wake-up signal on a service-scoped channel: id + created_at only.
  -- No payload, user text, or secrets. The read process re-reads the canonical row by keyset.
  PERFORM pg_notify('trading_lab_agent_event', NEW.id || '|' || extract(epoch from NEW.created_at)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_event_notify_tr ON agent_event;
--> statement-breakpoint
CREATE TRIGGER agent_event_notify_tr
  AFTER INSERT ON agent_event
  FOR EACH ROW EXECUTE FUNCTION agent_event_notify();
