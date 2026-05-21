-- Create storage bucket for plan files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'plans',
  'plans',
  false,
  52428800,  -- 50MB limit per file
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- RLS: builders can only upload to their own folder (builder_id/job_id/filename)
DROP POLICY IF EXISTS "builders_upload_own" ON storage.objects;
DROP POLICY IF EXISTS "builders_read_own"   ON storage.objects;
DROP POLICY IF EXISTS "builders_delete_own" ON storage.objects;

CREATE POLICY "builders_upload_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'plans' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "builders_read_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'plans' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "builders_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'plans' AND (storage.foldername(name))[1] = auth.uid()::text);
