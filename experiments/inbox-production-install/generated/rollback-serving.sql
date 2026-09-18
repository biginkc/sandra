BEGIN;UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;UPDATE inbox_control.command_admission SET enabled=false,updated_at=clock_timestamp();COMMIT;
-- Preserve retained heads, epochs, worksets, receipts and capture. Never drop/reset them as routine rollback.
-- Admission is disabled atomically with serving; authenticated receipt/status/recovery authority remains available.
