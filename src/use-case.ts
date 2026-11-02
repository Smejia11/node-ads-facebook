import { readFile } from 'node:fs/promises';
import type { Config } from './config.ts';
import type { GraphApi } from './meta-client.ts';

/** Textos y nombres del caso de uso: ajústalos a tu negocio. */
export const adCopy = {
  campaignName: `Tráfico | Landing | ${new Date().toISOString().slice(0, 10)}`,
  adSetName: 'CO | 25-60 | Ubicaciones automáticas',
  creativeName: 'Creativo | Mensaje principal',
  adName: 'Anuncio | Mensaje principal',
  message: 'Descubre lo que tenemos para ti. Entra y conoce más en menos de un minuto.',
  headline: 'Conoce más aquí',
  description: 'Información clara, sin compromiso.',
  callToAction: 'LEARN_MORE', // SIGN_UP, SHOP_NOW, CONTACT_US, GET_QUOTE...
} as const;

interface IdResponse { id: string }

export interface AdAccount {
  name: string;
  currency: string;
  account_status: number;
  timezone_name: string;
  disable_reason?: number;
}

export async function checkAdAccount(api: GraphApi, cfg: Config): Promise<AdAccount> {
  const account = await api.request<AdAccount>('GET', cfg.adAccountId, {
    fields: 'name,currency,account_status,timezone_name,disable_reason',
  });
  if (account.account_status !== 1) {
    throw new Error(`La cuenta ${cfg.adAccountId} no está activa (account_status=${account.account_status}, disable_reason=${account.disable_reason ?? '-'})`);
  }
  return account;
}

export async function uploadImage(api: GraphApi, cfg: Config): Promise<string | undefined> {
  if (!cfg.imagePath) return undefined;
  const bytes = (await readFile(cfg.imagePath)).toString('base64');
  const res = await api.request<{ images: Record<string, { hash: string }> }>('POST', `${cfg.adAccountId}/adimages`, { bytes });
  const hash = Object.values(res.images)[0]?.hash;
  if (!hash) throw new Error('Meta no devolvió el hash de la imagen');
  return hash;
}

export function createCampaign(api: GraphApi, cfg: Config): Promise<IdResponse> {
  return api.request<IdResponse>('POST', `${cfg.adAccountId}/campaigns`, {
    name: adCopy.campaignName,
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: [], // obligatorio: [] si no es vivienda, empleo, crédito o política
    is_adset_budget_sharing_enabled: false, // obligatorio desde v24 si el presupuesto va en el ad set
  });
}

export function createAdSet(api: GraphApi, cfg: Config, campaignId: string): Promise<IdResponse> {
  const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return api.request<IdResponse>('POST', `${cfg.adAccountId}/adsets`, {
    name: adCopy.adSetName,
    campaign_id: campaignId,
    status: 'PAUSED',
    daily_budget: cfg.dailyBudget,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    start_time: startTime.toISOString(),
    targeting: {
      geo_locations: { countries: cfg.countries },
      age_min: cfg.ageMin,
      age_max: cfg.ageMax,
      targeting_automation: { advantage_audience: 0 },
    },
  });
}

export function createCreative(api: GraphApi, cfg: Config, imageHash: string | undefined): Promise<IdResponse> {
  const linkData: Record<string, unknown> = {
    link: cfg.landingUrl,
    message: adCopy.message,
    name: adCopy.headline,
    description: adCopy.description,
    call_to_action: { type: adCopy.callToAction, value: { link: cfg.landingUrl } },
  };
  if (imageHash) linkData.image_hash = imageHash;
  else if (cfg.imageUrl) linkData.picture = cfg.imageUrl;

  return api.request<IdResponse>('POST', `${cfg.adAccountId}/adcreatives`, {
    name: adCopy.creativeName,
    object_story_spec: { page_id: cfg.pageId, link_data: linkData },
  });
}

export function createAd(api: GraphApi, cfg: Config, adSetId: string, creativeId: string): Promise<IdResponse> {
  return api.request<IdResponse>('POST', `${cfg.adAccountId}/ads`, {
    name: adCopy.adName,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED',
  });
}
