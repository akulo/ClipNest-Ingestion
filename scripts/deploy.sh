#!/bin/bash
set -e

echo "Deploying Edge Functions..."

supabase functions deploy ingest-router
supabase functions deploy scrape-youtube
supabase functions deploy scrape-tiktok
supabase functions deploy scrape-instagram
supabase functions deploy enrich-video

echo "All functions deployed."
