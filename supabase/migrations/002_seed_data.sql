-- ============================================================
-- WorkA — Seed Data Migration 002
-- Idempotent demo data for Session 2 morning brief flow
-- Safe to run multiple times — uses ON CONFLICT DO NOTHING
-- Demo builder UUID: 00000000-0000-0000-0000-000000000001
-- ============================================================

-- ─── Demo Builder ────────────────────────────────────────────

INSERT INTO builders (id, email, name, business_name, state, plan, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'dave@nguyenconstructions.com.au',
  'Dave Nguyen',
  'Nguyen Constructions',
  'VIC',
  'builder',
  NOW() - INTERVAL '180 days'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Workers ─────────────────────────────────────────────────

INSERT INTO workers (id, builder_id, name, role, status, created_at)
VALUES
  (
    '00000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000001',
    'Jack Morrison',
    'carpenter',
    'active',
    NOW() - INTERVAL '90 days'
  ),
  (
    '00000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000001',
    'Mick Tran',
    'plumber',
    'active',
    NOW() - INTERVAL '60 days'
  ),
  (
    '00000000-0000-0000-0000-000000000023',
    '00000000-0000-0000-0000-000000000001',
    'Sarah Chen',
    'painter',
    'invited',
    NOW() - INTERVAL '7 days'
  )
ON CONFLICT (id) DO NOTHING;

-- ─── Clients ─────────────────────────────────────────────────

INSERT INTO clients (id, builder_id, name, email, created_at)
VALUES
  (
    '00000000-0000-0000-0000-000000000031',
    '00000000-0000-0000-0000-000000000001',
    'The Hendersons',
    'henderson@email.com',
    NOW() - INTERVAL '50 days'
  ),
  (
    '00000000-0000-0000-0000-000000000032',
    '00000000-0000-0000-0000-000000000001',
    'Tom Caruso',
    'tom@carusoproperty.com.au',
    NOW() - INTERVAL '15 days'
  )
ON CONFLICT (id) DO NOTHING;

-- ─── Jobs ────────────────────────────────────────────────────

-- Job 1: Fitzroy — active, Hendersons, 45 days old
INSERT INTO jobs (id, builder_id, client_id, address, status, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000031',
  '14 Merri St, Fitzroy VIC 3065',
  'active',
  NOW() - INTERVAL '45 days',
  NOW() - INTERVAL '5 days'
)
ON CONFLICT (id) DO NOTHING;

-- Job 2: Toorak — quoted, Caruso, 12 days old
INSERT INTO jobs (id, builder_id, client_id, address, status, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000032',
  '8 Burnside Rd, Toorak VIC 3142',
  'quoted',
  NOW() - INTERVAL '12 days',
  NOW() - INTERVAL '5 days'
)
ON CONFLICT (id) DO NOTHING;

-- Job 3: Brunswick — quoting, no client, 3 days old
INSERT INTO jobs (id, builder_id, client_id, address, status, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000012',
  '00000000-0000-0000-0000-000000000001',
  NULL,
  '52 Bendigo St, Brunswick VIC 3056',
  'quoting',
  NOW() - INTERVAL '3 days',
  NOW() - INTERVAL '3 days'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Quote ───────────────────────────────────────────────────

-- Quote for Job 2 (Toorak) — sent 5 days ago, no response
INSERT INTO quotes (id, job_id, builder_id, status, total_cost, confidence_score, version, sent_at, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'sent',
  127500,
  82,
  1,
  NOW() - INTERVAL '5 days',
  NOW() - INTERVAL '7 days'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Variations ──────────────────────────────────────────────

-- VAR-001: Kitchen benchtop upgrade — Fitzroy job, 2 days old
INSERT INTO variations (id, job_id, builder_id, title, description, amount, status, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000051',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'VAR-001',
  'Upgrade kitchen benchtop to 40mm Caesarstone',
  3200,
  'pending',
  NOW() - INTERVAL '2 days'
)
ON CONFLICT (id) DO NOTHING;

-- VAR-002: Extra GPO points — Fitzroy job, 4 days old
INSERT INTO variations (id, job_id, builder_id, title, description, amount, status, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000052',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'VAR-002',
  'Add extra GPO points to living room',
  680,
  'pending',
  NOW() - INTERVAL '4 days'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Invoice ─────────────────────────────────────────────────

-- Invoice for Fitzroy job — sent but not paid, due 3 days ago (OVERDUE)
INSERT INTO invoices (id, job_id, builder_id, amount, status, due_date, sent_at, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000061',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  28000,
  'sent',
  CURRENT_DATE - INTERVAL '3 days',
  NOW() - INTERVAL '14 days',
  NOW() - INTERVAL '14 days'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Communication History ───────────────────────────────────

-- Initial quote email to Caruso
INSERT INTO communication_history (id, job_id, builder_id, direction, channel, subject, body, from_address, to_address, timestamp)
VALUES (
  '00000000-0000-0000-0000-000000000071',
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'outbound',
  'email',
  'Quote for 8 Burnside Rd, Toorak',
  'Hi Tom, please find attached your quote for the Toorak renovation. Total: $127,500. Please let me know if you have any questions.',
  'dave@nguyenconstructions.com.au',
  'tom@carusoproperty.com.au',
  NOW() - INTERVAL '5 days'
)
ON CONFLICT (id) DO NOTHING;

-- Invoice email to Hendersons
INSERT INTO communication_history (id, job_id, builder_id, direction, channel, subject, body, from_address, to_address, timestamp)
VALUES (
  '00000000-0000-0000-0000-000000000072',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'outbound',
  'email',
  'Invoice — 14 Merri St, Fitzroy',
  'Hi, please find your invoice for the progress payment of $28,000 due on ' || (CURRENT_DATE - INTERVAL '3 days')::text || '. Payment details are included.',
  'dave@nguyenconstructions.com.au',
  'henderson@email.com',
  NOW() - INTERVAL '14 days'
)
ON CONFLICT (id) DO NOTHING;

-- VAR-001 notification to Hendersons
INSERT INTO communication_history (id, job_id, builder_id, direction, channel, subject, body, from_address, to_address, timestamp)
VALUES (
  '00000000-0000-0000-0000-000000000073',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'outbound',
  'email',
  'Variation Request — Kitchen Benchtop Upgrade',
  'Hi, we have a variation request for the Fitzroy job. Upgrading the kitchen benchtop to 40mm Caesarstone will cost an additional $3,200. Please approve or decline.',
  'dave@nguyenconstructions.com.au',
  'henderson@email.com',
  NOW() - INTERVAL '2 days'
)
ON CONFLICT (id) DO NOTHING;
