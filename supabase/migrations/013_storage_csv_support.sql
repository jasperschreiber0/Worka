-- Ensure the plans bucket exists and accepts CSV files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'plans',
  'plans',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/webp',
    'application/octet-stream',
    'text/csv',
    'application/csv',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit    = EXCLUDED.file_size_limit;
