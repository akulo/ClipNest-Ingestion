-- PGMQ Queue + Status Tracking Migration
-- Run this in the Supabase SQL Editor before deploying the new worker functions.

-- ── 1. Enable PGMQ ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgmq;

-- ── 2. Create queues ──────────────────────────────────────────────────────────

SELECT pgmq.create('scrape_jobs');
SELECT pgmq.create('enrich_jobs');

-- ── 3. Add status columns to clipnest_videos ──────────────────────────────────

ALTER TABLE public.clipnest_videos
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'scraping', 'enriching', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS processing_error text;

CREATE INDEX IF NOT EXISTS idx_clipnest_videos_processing_status
  ON public.clipnest_videos (processing_status);

-- ── 4. Public RPC wrappers (SECURITY DEFINER) ─────────────────────────────────
-- Edge Functions call pgmq via supabase.rpc() using these wrappers.

CREATE OR REPLACE FUNCTION public.queue_send(queue_name text, message jsonb)
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pgmq
AS $$
  SELECT pgmq.send(queue_name, message);
$$;

CREATE OR REPLACE FUNCTION public.queue_read(queue_name text, vt_seconds integer, qty integer DEFAULT 1)
  RETURNS TABLE (
    msg_id      bigint,
    read_ct     integer,
    enqueued_at timestamptz,
    vt          timestamptz,
    message     jsonb
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pgmq
AS $$
  SELECT msg_id, read_ct, enqueued_at, vt, message
  FROM pgmq.read(queue_name, vt_seconds, qty);
$$;

CREATE OR REPLACE FUNCTION public.queue_archive(queue_name text, msg_id bigint)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pgmq
AS $$
  SELECT pgmq.archive(queue_name, msg_id);
$$;

-- ── 5. Grant execute permissions ──────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.queue_send(text, jsonb)           TO service_role, anon;
GRANT EXECUTE ON FUNCTION public.queue_read(text, integer, integer) TO service_role, anon;
GRANT EXECUTE ON FUNCTION public.queue_archive(text, bigint)        TO service_role, anon;
