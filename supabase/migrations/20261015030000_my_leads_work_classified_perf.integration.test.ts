// A1.2 (20261015030000) replaces my_leads_work_classified with a faster body that must give the same output. The decision-table
// oracle lives in the A1 and B1 suites, which each re-apply their own migration inside a rolled-back transaction; this file runs
// both of them again, unchanged, with the migration chain extended through 20261015030000, so the shipped body is what they test.
const A1_THEN = '20261015020200_my_leads_work_facts_zip_signed_touch.sql,20261015030000_my_leads_work_classified_perf.sql';
const B1_THEN = '20261015030000_my_leads_work_classified_perf.sql';

process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = A1_THEN;
await import('./20261015010000_my_leads_work_queue_classifier.integration.test');
process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = B1_THEN;
await import('./20261015020200_my_leads_work_facts_zip_signed_touch.integration.test');
delete process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS;

export {};
