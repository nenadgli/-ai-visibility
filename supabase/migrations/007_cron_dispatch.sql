-- Pouzdano zakazivanje: GitHub "schedule" često kasni ili preskače pokretanja, pa ih pokreće Supabase pg_cron
-- preko GitHub API-ja (workflow_dispatch). Workflowi ostaju na GitHubu, samo okidač je ovde.
--
-- Token: GitHub fine-grained token samo za repo nenadgli/-ai-visibility, dozvola "Actions: Read and write".
-- Čuva se u Supabase Vaultu pod imenom 'github_actions_token' (nikad u kodu):
--   select vault.create_secret('<token>', 'github_actions_token', 'GitHub: pokretanje Actions za -ai-visibility');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_workflow(p_workflow text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'github_actions_token';
  if v_token is null then
    raise exception 'Nema GitHub tokena u Vaultu (github_actions_token)';
  end if;
  -- asinhroni HTTP poziv; odgovor (204 = pokrenuto) se vidi u net._http_response
  return net.http_post(
    url := 'https://api.github.com/repos/nenadgli/-ai-visibility/actions/workflows/' || p_workflow || '/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'ai-visibility-cron',
      'Content-Type', 'application/json'),
    body := '{"ref":"main"}'::jsonb
  );
end $$;

revoke execute on function public.dispatch_workflow(text) from public, anon, authenticated;

-- Agent Feed svakog sata (:41), Feed X-ray svakog jutra (04:17 UTC)
select cron.schedule('agent-feed-hourly', '41 * * * *', $$select public.dispatch_workflow('agent-feed.yml')$$);
select cron.schedule('feed-xray-daily', '17 4 * * *', $$select public.dispatch_workflow('feed-xray.yml')$$);
