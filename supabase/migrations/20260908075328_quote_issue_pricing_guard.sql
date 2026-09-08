-- Prevent UI, RPC or direct status updates from issuing an incomplete quote.
create or replace function public.guard_quote_issue_pricing()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare expected numeric;
begin
  if new.status in ('pending_review','sent','approved') and new.status is distinct from old.status then
    if not exists(select 1 from public.quote_line_items where quote_id=new.id and assumption_status is distinct from 'excluded') then
      raise exception 'Quote has no included lines';
    end if;
    if exists(select 1 from public.quote_line_items where quote_id=new.id and assumption_status is distinct from 'excluded' and
      (total is null or total < 0 or assumption_status='unresolved' or pricing_source='category_rate' or margin_pct < 0
       or (rate is not null and quantity is not null and round(rate*quantity,2)<>round(total,2)))) then
      raise exception 'Quote has unresolved pricing, scope review or line arithmetic errors';
    end if;
    if exists(select 1 from public.assumptions where quote_id=new.id and resolution_type is null) then
      raise exception 'Quote has unresolved review items';
    end if;
    select coalesce(sum(round(total,2)),0) into expected from public.quote_line_items where quote_id=new.id and assumption_status is distinct from 'excluded';
    if new.total_cost is null or round(new.total_cost,2)<>expected then
      raise exception 'Quote total does not reconcile with included lines';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_quote_issue_pricing() from public, anon, authenticated;
drop trigger if exists guard_quote_issue_pricing on public.quotes;
create trigger guard_quote_issue_pricing before update of status on public.quotes
for each row execute function public.guard_quote_issue_pricing();
