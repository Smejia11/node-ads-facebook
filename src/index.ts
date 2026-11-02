import { createInterface } from 'node:readline/promises';
import { ConfigError, loadConfig, parseFlags, type Config, type Flags } from './config.ts';
import { DryRunClient, MetaApiError, MetaClient, type GraphApi } from './meta-client.ts';
import { redact, registerSecret } from './redact.ts';
import { checkAdAccount, createAd, createAdSet, createCampaign, createCreative, uploadImage } from './use-case.ts';

interface Created { type: string; id: string }

async function confirmProduction(cfg: Config, flags: Flags): Promise<boolean> {
  if (flags.dryRun || cfg.env !== 'production' || flags.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('✗ META_ENV=production sin terminal interactiva: usa --yes para confirmar explícitamente.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n⚠ Vas a crear objetos en la cuenta REAL ${cfg.adAccountId} (presupuesto diario ${cfg.dailyBudget}).\n` +
    `  Todo quedará en PAUSED. Escribe el ID de la cuenta para continuar: `,
  );
  rl.close();
  return answer.trim() === cfg.adAccountId;
}

async function rollback(api: GraphApi, created: Created[]) {
  console.log('\n↩ Rollback de lo creado...');
  for (const { type, id } of [...created].reverse()) {
    try {
      await api.request('DELETE', id);
      console.log(`  ✓ ${type} ${id} eliminado`);
    } catch (err) {
      console.error(`  ✗ No se pudo eliminar ${type} ${id}: ${redact((err as Error).message)}`);
    }
  }
}

async function main(): Promise<number> {
  let flags: Flags;
  let cfg: Config;
  try {
    flags = parseFlags(process.argv.slice(2));
    cfg = loadConfig(flags);
  } catch (err) {
    console.error(`✗ ${err instanceof ConfigError ? err.message : redact(String(err))}`);
    return 2;
  }

  registerSecret(cfg.accessToken);
  registerSecret(cfg.appSecret);

  const mode = flags.dryRun ? 'DRY RUN' : cfg.env.toUpperCase();
  console.log(`▶ Caso de uso Facebook Ads (${cfg.apiVersion}) — ${mode}\n`);

  if (!(await confirmProduction(cfg, flags))) {
    console.log('Cancelado. No se creó nada.');
    return 1;
  }

  const api: GraphApi = flags.dryRun
    ? new DryRunClient(cfg.apiVersion)
    : new MetaClient({ apiVersion: cfg.apiVersion, accessToken: cfg.accessToken, appSecret: cfg.appSecret });

  const created: Created[] = [];
  try {
    const account = await checkAdAccount(api, cfg);
    console.log(`✓ Cuenta: ${account.name} | Moneda: ${account.currency} | Zona: ${account.timezone_name}`);

    const imageHash = await uploadImage(api, cfg);
    if (imageHash) console.log(`✓ Imagen subida (hash ${imageHash})`);

    const campaign = await createCampaign(api, cfg);
    created.push({ type: 'Campaña', id: campaign.id });
    console.log(`✓ Campaña: ${campaign.id}`);

    const adSet = await createAdSet(api, cfg, campaign.id);
    created.push({ type: 'Conjunto de anuncios', id: adSet.id });
    console.log(`✓ Conjunto de anuncios: ${adSet.id}`);

    const creative = await createCreative(api, cfg, imageHash);
    created.push({ type: 'Creativo', id: creative.id });
    console.log(`✓ Creativo: ${creative.id}`);

    const ad = await createAd(api, cfg, adSet.id, creative.id);
    created.push({ type: 'Anuncio', id: ad.id });
    console.log(`✓ Anuncio: ${ad.id}`);

    console.log('\n✅ Listo. Todo quedó en PAUSED.\n');
    console.log(JSON.stringify({
      env: cfg.env,
      campaign_id: campaign.id,
      adset_id: adSet.id,
      creative_id: creative.id,
      ad_id: ad.id,
      status: 'PAUSED',
    }, null, 2));
    return 0;
  } catch (err) {
    console.error(`\n✗ ${redact((err as Error).message)}`);
    if (err instanceof MetaApiError && err.fbtraceId) console.error(`  fbtrace_id: ${err.fbtraceId}`);
    if (created.length && !flags.keepOnError && !flags.dryRun) await rollback(api, created);
    return 1;
  }
}

process.exitCode = await main();
