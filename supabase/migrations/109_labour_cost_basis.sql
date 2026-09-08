-- Preserve the rate used when hours are logged; later team rate changes must
-- not silently reprice historical work. Null means costing is still required.
ALTER TABLE job_labour_hours
  ADD COLUMN hourly_rate numeric(10,2) CHECK (hourly_rate >= 0),
  ADD COLUMN trade_category_id integer REFERENCES trade_categories(id);
