BEGIN;UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;COMMIT;
-- Preserve retained heads, epochs, worksets, receipts and capture. Never drop/reset them as routine rollback.
