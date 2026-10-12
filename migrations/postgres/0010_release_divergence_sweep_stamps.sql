-- Older dirty or interrupted reconciles left stamps that no later run could
-- claim. Removing a stamp only prevents a delete; it cannot authorize one.
-- During a rolling deploy, an in-flight run simply clears nothing for these
-- rows, leaving the gaps visible until a later reconcile captures them again.
UPDATE native_write_failures SET sweep_token = NULL WHERE sweep_token IS NOT NULL;
