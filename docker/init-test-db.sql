-- Runs once, only on first container initialisation (empty data volume).
-- POSTGRES_DB (compose.yaml) creates safwa_dev; this creates the sibling
-- disposable test database integration tests reset freely.
CREATE DATABASE safwa_test;
