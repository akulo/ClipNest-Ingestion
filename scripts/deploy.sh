#!/bin/bash
set -e

# Load local env (not committed to git)
if [ -f .env.local ]; then
  set -a && source .env.local && set +a
fi

echo "Deploying Edge Functions..."

supabase functions deploy ingest-router
supabase functions deploy scrape-worker
supabase functions deploy enrich-worker
supabase functions deploy geo-worker

echo "All functions deployed."
