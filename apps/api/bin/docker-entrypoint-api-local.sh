#!/bin/bash
set -e
python manage.py wait_for_db
# Wait for migrations
python manage.py wait_for_migrations

# Initialize the local instance record
python manage.py ensure_instance
# Load the configuration variable
python manage.py configure_instance

# Create the default bucket
python manage.py create_bucket

# Clear Cache before starting to remove stale values
python manage.py clear_cache

# --noreload: source stays volume-mounted, but the running service only picks
# up code changes when the container is recreated (deploy.sh --backend).
# Editing files on the host must never affect the live process.
python manage.py runserver 0.0.0.0:8000 --settings=plane.settings.local --noreload
