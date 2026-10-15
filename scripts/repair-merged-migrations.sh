#!/usr/bin/env bash
# One-off repair for the database after merging fyk_dev.
#
# Context: this server had already applied the pre-merge branch's
# 0172/0173/0174 (agent tables dropped, flag dropped, credential columns
# added). The merged migration chain re-introduces those tables via the
# fyk_dev migrations 0172–0176, which expect the pre-deletion schema to
# exist. This script restores the missing baseline objects, runs the merged
# chain, and fakes 0177 (its changes are already present).
set -euo pipefail

API=plane-api-1

echo "==> Step 1: recreate the pre-deletion agent schema baseline"
docker exec "$API" python manage.py shell -c "
from django.db import connection

SQL = '''
CREATE TABLE \"research_agent_sessions\" (\"id\" uuid NOT NULL PRIMARY KEY, \"created_at\" timestamp with time zone NOT NULL, \"updated_at\" timestamp with time zone NOT NULL, \"deleted_at\" timestamp with time zone NULL, \"session_id\" uuid NOT NULL UNIQUE, \"run_id\" uuid NOT NULL UNIQUE, \"status\" varchar(24) NOT NULL, \"last_error\" varchar(255) NOT NULL, \"request_id\" varchar(128) NOT NULL UNIQUE, \"payload_hash\" varchar(64) NOT NULL, \"chain_node_id\" uuid NOT NULL, \"context_grant_id\" uuid NOT NULL UNIQUE, \"created_by_id\" uuid NULL, \"project_id\" uuid NOT NULL, \"updated_by_id\" uuid NULL, \"user_id\" uuid NOT NULL, \"workspace_id\" uuid NOT NULL);
CREATE INDEX \"rsch_agent_ws_user_idx\" ON \"research_agent_sessions\" (\"workspace_id\", \"user_id\", \"status\");
CREATE TABLE \"research_agent_run_events\" (\"id\" uuid NOT NULL PRIMARY KEY, \"created_at\" timestamp with time zone NOT NULL, \"run_id\" uuid NOT NULL, \"seq\" integer NOT NULL CHECK (\"seq\" >= 0), \"event_type\" varchar(64) NOT NULL, \"payload\" jsonb NOT NULL, \"request_id\" varchar(128) NOT NULL UNIQUE, \"session_id\" uuid NOT NULL);
ALTER TABLE \"research_agent_run_events\" ADD CONSTRAINT \"rsch_agent_event_uq_seq\" UNIQUE (\"run_id\", \"seq\");
CREATE INDEX \"rsch_agent_event_type_idx\" ON \"research_agent_run_events\" (\"run_id\", \"event_type\");
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessi_chain_node_id_1eac8f31_fk_research_\" FOREIGN KEY (\"chain_node_id\") REFERENCES \"research_chain_nodes\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessi_context_grant_id_04db7dda_fk_research_\" FOREIGN KEY (\"context_grant_id\") REFERENCES \"research_context_grants\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessions_created_by_id_a529e0b2_fk_users_id\" FOREIGN KEY (\"created_by_id\") REFERENCES \"users\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessions_project_id_3e9d9a08_fk_projects_id\" FOREIGN KEY (\"project_id\") REFERENCES \"projects\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessions_updated_by_id_1cdffdb2_fk_users_id\" FOREIGN KEY (\"updated_by_id\") REFERENCES \"users\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessions_user_id_2043496b_fk_users_id\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE \"research_agent_sessions\" ADD CONSTRAINT \"research_agent_sessions_workspace_id_6d2cf9e6_fk_workspaces_id\" FOREIGN KEY (\"workspace_id\") REFERENCES \"workspaces\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX \"research_agent_sessions_request_id_5b13d163_like\" ON \"research_agent_sessions\" (\"request_id\" varchar_pattern_ops);
CREATE INDEX \"research_agent_sessions_chain_node_id_1eac8f31\" ON \"research_agent_sessions\" (\"chain_node_id\");
CREATE INDEX \"research_agent_sessions_created_by_id_a529e0b2\" ON \"research_agent_sessions\" (\"created_by_id\");
CREATE INDEX \"research_agent_sessions_project_id_3e9d9a08\" ON \"research_agent_sessions\" (\"project_id\");
CREATE INDEX \"research_agent_sessions_updated_by_id_1cdffdb2\" ON \"research_agent_sessions\" (\"updated_by_id\");
CREATE INDEX \"research_agent_sessions_user_id_2043496b\" ON \"research_agent_sessions\" (\"user_id\");
CREATE INDEX \"research_agent_sessions_workspace_id_6d2cf9e6\" ON \"research_agent_sessions\" (\"workspace_id\");
ALTER TABLE \"research_agent_run_events\" ADD CONSTRAINT \"research_agent_run_e_session_id_c59b5733_fk_research_\" FOREIGN KEY (\"session_id\") REFERENCES \"research_agent_sessions\" (\"id\") DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX \"research_agent_run_events_created_at_fd008931\" ON \"research_agent_run_events\" (\"created_at\");
CREATE INDEX \"research_agent_run_events_run_id_1bfa425c\" ON \"research_agent_run_events\" (\"run_id\");
CREATE INDEX \"research_agent_run_events_request_id_b117f294_like\" ON \"research_agent_run_events\" (\"request_id\" varchar_pattern_ops);
CREATE INDEX \"research_agent_run_events_session_id_c59b5733\" ON \"research_agent_run_events\" (\"session_id\");
ALTER TABLE \"research_agent_sessions\" ADD COLUMN \"assembly\" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE \"research_agent_sessions\" ADD COLUMN \"delegated_subject\" varchar(255) DEFAULT '' NOT NULL;
ALTER TABLE \"research_agent_sessions\" ADD COLUMN \"synlora_session_id\" varchar(128) DEFAULT '' NOT NULL;
ALTER TABLE \"research_agent_sessions\" ADD COLUMN \"synlora_run_id\" varchar(128) DEFAULT '' NOT NULL;
ALTER TABLE \"workspace_research_settings\" ADD COLUMN \"research_agent_enabled\" boolean DEFAULT false NOT NULL;
'''

with connection.cursor() as cursor:
    cursor.execute(\"SELECT to_regclass('research_agent_sessions')\")
    if cursor.fetchone()[0] is not None:
        print('agent tables already exist; skipping baseline recreation')
    else:
        cursor.execute(SQL)
        print('baseline tables/columns recreated')
    cursor.execute(
        \"DELETE FROM django_migrations WHERE app='db' AND name IN (\"
        \"'0172_delete_research_agent_models',\"
        \"'0173_remove_research_agent_enabled',\"
        \"'0174_integration_credential_storage')\"
    )
    print('orphaned pre-merge migration records removed:', cursor.rowcount)
"

echo "==> Step 2: apply the merged migration chain (fyk_dev 0172-0176)"
docker exec "$API" python manage.py migrate db 0176_allow_duplicate_project_names

echo "==> Step 3: fake 0177 (credential columns already applied pre-merge)"
docker exec "$API" python manage.py migrate db 0177_integration_credential_storage --fake

echo "==> Step 4: verify"
docker exec "$API" python manage.py shell -c "
from django.db import connection
with connection.cursor() as cursor:
    cursor.execute(\"SELECT to_regclass('research_agent_sessions'), to_regclass('research_agentbackendconnection'::text)\")
    cursor.execute(\"SELECT count(*) FROM django_migrations WHERE app='db' AND name LIKE '017%' AND name NOT LIKE '0170%' AND name NOT LIKE '0171%'\")
    print('applied 0172+ migrations:', cursor.fetchone()[0])
"
echo "Repair complete. Now run: ./scripts/deploy.sh --skip-pull --backend"
