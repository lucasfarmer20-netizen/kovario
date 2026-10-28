begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

do $$
declare o uuid; c uuid; s uuid; other_site uuid; i uuid; l uuid; p uuid; a uuid; st uuid; n int;
begin
  for n in 1..2 loop
    insert into public.org(slug,name,timezone) values ('reports-'||n,'Reports','America/Anchorage') returning id into o;
    insert into public.site(org_id,name) values(o,'Main') returning id into s;
    insert into public.site(org_id,name) values(o,'Lodge') returning id into other_site;
    insert into public.customer(org_id,name) values(o,'Report customer') returning id into c;
    insert into public.species(org_id,code,name,"group") values(o,'salmon','Salmon','salmon'),(o,'cod','Cod','whitefish');
    insert into public.incoming_condition(org_id,code,name) values(o,'whole','Whole');
    insert into public.processing_method(org_id,code,name) values(o,'fillets','Fillets');
    insert into public.allocation_session(org_id,number) values(o,'ALC-0001') returning id into a;
    insert into public.settlement(org_id,number,session_id,angler_name) values(o,'STL-0001',a,'Angler') returning id into st;
    for j in 1..5 loop
      insert into public.intake(org_id,number,customer_id,site_id,state,intake_at,pulled_at,reconcile_at,blast_at)
      values(o,'INT-000'||j,c,case when j=5 then null when j=2 then other_site else s end,
        case when j=3 then 'draft'::public.intake_state when j=4 then 'cancelled'::public.intake_state when j=5 then 'holding'::public.intake_state else 'blast_freezer'::public.intake_state end,
        case when j=1 then '2026-10-27 02:00Z'::timestamptz else '2026-10-27 10:00Z'::timestamptz end,
        case when j=1 then '2026-10-27 04:00Z'::timestamptz when j=2 then '2026-10-27 09:00Z'::timestamptz end,
        case when j<=2 then '2026-10-27 10:00Z'::timestamptz end,
        case when j<=2 then '2026-10-27 12:00Z'::timestamptz end) returning id into i;
      insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
      values(o,i,'salmon','whole','fillets',100*j,0.5) returning id into l;
      if j<=2 then
        insert into public.reconcile_line(org_id,intake_id,intake_line_id,expected_lb,actual_lb)
        values(o,i,l,case when j=1 then 50 else 150 end,case when j=1 then 60 else 120 end);
        insert into public.allocation_intake(org_id,session_id,intake_id) values(o,a,i);
      end if;
      if j=1 then
        insert into public.intake_line(org_id,intake_id,species_code,condition_code,method_code,lb,yield_factor)
        values(o,i,'cod','whole','fillets',20,0.5) returning id into l;
        insert into public.reconcile_line(org_id,intake_id,intake_line_id,expected_lb,actual_lb) values(o,i,l,0,10);
        insert into public.payment(org_id,number,provider,amount,state,approved_at,created_at)
        values(o,'PAY-0001','manual',125,'approved','2026-10-28 02:00Z','2026-10-01 00:00Z') returning id into p;
        insert into public.charge(org_id,number,customer_id,kind,source_type,source_id,qty,unit,unit_price,state,settled_payment_id)
        values(o,'CHG-0001',c,'processing','intake',i,1,'each',100,'settled',p),
          (o,'CHG-0002',c,'freight','settlement',st,1,'each',25,'settled',p),
          (o,'CHG-0003',c,'retail','manual',null,1,'each',999,'open',null),
          (o,'CHG-0004',c,'retail','manual',null,1,'each',999,'voided',null);
        insert into public.charge(org_id,number,customer_id,kind,source_type,qty,unit,unit_price,state,comp_reason)
        values(o,'CHG-0005',c,'retail','manual',1,'each',999,'comped','Test comp');
      end if;
    end loop;
  end loop;
end $$;

select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','app_role','manager','org_id',(select id from public.org where slug='reports-1'))::text,true);
set local role authenticated;
select is((select sum(incoming_lb) from public.report_daily_volume),820::numeric,'WP21 volume: lb by species excludes draft/cancelled');
select is((select incoming_lb from public.report_daily_volume where day='2026-10-26' and species_code='salmon'),100::numeric,'WP21 dates: intake day uses org timezone at midnight');
select is((select sum(intake_count) from public.report_pipeline),3::numeric,'WP21 pipeline: counts each intake once despite multiple species');
select is((select sum(incoming_lb) from public.report_pipeline),820::numeric,'WP21 pipeline: incoming weights agree with volume');
select is((select sum(incoming_lb) from public.report_pipeline where site_id=(select id from public.site where name='Main')),120::numeric,'WP21 site filter: restricts pipeline to source site');
select is((select sum(incoming_lb) from public.report_pipeline where site_id is null),500::numeric,'WP21 site filter: unassigned intake is retained');
select is((select hours from public.report_throughput where stage='Intake → processing'),2::numeric,'WP21 throughput: completed hours excludes reversed and missing pairs');
select is((select sum(intake_count) from public.report_throughput where stage='Reconcile → blast'),2::numeric,'WP21 throughput: counts completed pairs');
select is((select sum(amount) from public.report_revenue),125::numeric,'WP21 revenue: settled charges only, pooled settlement never multiplies revenue');
select is((select min(day) from public.report_revenue),'2026-10-27'::date,'WP21 revenue: date is local approval day, not creation day');
select is((select amount from public.report_revenue where kind='freight' and site_id is null),25::numeric,'WP21 revenue: mixed-site settlement is unassigned');
select is((select sum(actual_lb) from public.report_reconcile_variance where species_code='salmon'),180::numeric,'WP21 variance: uses recorded measurements');
select is((select round((sum(actual_lb)-sum(expected_lb))/sum(expected_lb)*100,2) from public.report_reconcile_variance where species_code='salmon'),-10::numeric,'WP21 variance: weighted totals, not average percentages');
select ok((select variance_pct is null from public.report_reconcile_variance where species_code='cod'),'WP21 variance: zero expected weight has no percentage');
select is((select count(distinct org_id) from (select org_id from public.report_daily_volume union all select org_id from public.report_pipeline union all select org_id from public.report_throughput union all select org_id from public.report_revenue union all select org_id from public.report_reconcile_variance) r),1::bigint,'WP21 tenancy: every report obeys caller RLS');
reset role;
select ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class where relname in ('report_daily_volume','report_pipeline','report_throughput','report_revenue','report_reconcile_variance')),'WP21 tenancy: all report views are security invokers');
set local role anon;
select throws_ok('select * from public.report_revenue','42501',null,'WP21 tenancy: anonymous export/query denied');
reset role;
select * from finish();
rollback;
