import { existsSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

export type MetaEnv = 'sandbox' | 'production';

export interface Flags {
  dryRun: boolean;
  keepOnError: boolean;
  yes: boolean;
}

export interface Config {
  env: MetaEnv;
  apiVersion: string;
  accessToken: string;
  appSecret: string;
  adAccountId: string;
  pageId: string;
  landingUrl: string;
  imagePath: string | undefined;
  imageUrl: string | undefined;
  dailyBudget: number;
  maxDailyBudget: number;
  countries: string[];
  ageMin: number;
  ageMax: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

export function parseFlags(argv: readonly string[]): Flags {
  const known = new Set(['--dry-run', '--keep-on-error', '--yes']);
  const unknown = argv.filter((a) => a.startsWith('--') && !known.has(a));
  if (unknown.length) throw new ConfigError(`Flags desconocidos: ${unknown.join(', ')}`);
  return {
    dryRun: argv.includes('--dry-run'),
    keepOnError: argv.includes('--keep-on-error'),
    yes: argv.includes('--yes'),
  };
}

/**
 * Lee y valida TODA la configuración antes de hacer cualquier llamada.
 * En --dry-run los secretos e IDs pueden faltar (se usan placeholders).
 */
export function loadConfig(flags: Flags, source: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];
  const placeholder = (name: string) => `<${name}>`;

  const str = (name: string, opts: { required?: boolean; pattern?: RegExp; hint?: string } = {}) => {
    const raw = source[name]?.trim();
    if (!raw) {
      if (opts.required !== false && !flags.dryRun) errors.push(`${name} es obligatorio`);
      return opts.required === false ? undefined : placeholder(name);
    }
    if (opts.pattern && !opts.pattern.test(raw)) {
      errors.push(`${name} tiene un formato inválido${opts.hint ? ` (${opts.hint})` : ''}`);
    }
    return raw;
  };

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = source[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`${name} debe ser un entero entre ${min} y ${max}`);
      return fallback;
    }
    return n;
  };

  const env = (source.META_ENV?.trim() || 'sandbox') as MetaEnv;
  if (env !== 'sandbox' && env !== 'production') errors.push('META_ENV debe ser "sandbox" o "production"');

  const apiVersion = str('META_API_VERSION', { required: false, pattern: /^v\d{2,3}\.0$/, hint: 'ej. v26.0' }) ?? 'v26.0';
  const accessToken = str('META_ACCESS_TOKEN', { pattern: /^[A-Za-z0-9]{40,}$/, hint: 'token alfanumérico' })!;
  const appSecret = str('META_APP_SECRET', { pattern: /^[a-f0-9]{32}$/i, hint: '32 caracteres hex' })!;
  const adAccountId = normalizeAccountId(str('META_AD_ACCOUNT_ID', { pattern: /^(act_)?\d{5,20}$/ })!);
  const pageId = str('META_PAGE_ID', { pattern: /^\d{5,20}$/ })!;

  const landingUrl = str('LANDING_URL')!;
  if (source.LANDING_URL?.trim()) assertHttpsUrl('LANDING_URL', landingUrl, errors);

  const imageUrl = str('IMAGE_URL', { required: false });
  if (imageUrl) assertHttpsUrl('IMAGE_URL', imageUrl, errors);

  const imagePath = str('IMAGE_PATH', { required: false });
  if (imagePath) validateImagePath(imagePath, errors);

  const maxDailyBudget = int('MAX_DAILY_BUDGET', 100_000, 1, 1_000_000_000);
  const dailyBudget = int('DAILY_BUDGET', 20_000, 1, 1_000_000_000);
  if (dailyBudget > maxDailyBudget) {
    errors.push(`DAILY_BUDGET (${dailyBudget}) supera el tope MAX_DAILY_BUDGET (${maxDailyBudget})`);
  }

  const countries = (source.TARGET_COUNTRIES?.trim() || 'CO').split(',').map((c) => c.trim().toUpperCase());
  if (!countries.every((c) => /^[A-Z]{2}$/.test(c))) errors.push('TARGET_COUNTRIES debe ser una lista de códigos ISO de 2 letras');

  const ageMin = int('AGE_MIN', 25, 18, 65);
  const ageMax = int('AGE_MAX', 60, 18, 65);
  if (ageMin > ageMax) errors.push('AGE_MIN no puede ser mayor que AGE_MAX');

  // Allowlist de cuentas: evita disparar contra la cuenta equivocada por un .env copiado.
  const allowed = (source.META_ALLOWED_AD_ACCOUNTS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(normalizeAccountId);
  if (!flags.dryRun && source.META_AD_ACCOUNT_ID?.trim() && !allowed.includes(adAccountId)) {
    errors.push(`La cuenta ${adAccountId} no está en META_ALLOWED_AD_ACCOUNTS`);
  }

  if (errors.length) {
    throw new ConfigError(`Configuración inválida:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    env, apiVersion, accessToken, appSecret, adAccountId, pageId, landingUrl,
    imagePath, imageUrl, dailyBudget, maxDailyBudget, countries, ageMin, ageMax,
  };
}

export function normalizeAccountId(id: string): string {
  return id.startsWith('act_') || id.startsWith('<') ? id : `act_${id}`;
}

function assertHttpsUrl(name: string, value: string, errors: string[]) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') errors.push(`${name} debe usar https`);
    if (url.username || url.password) errors.push(`${name} no debe incluir credenciales`);
  } catch {
    errors.push(`${name} no es una URL válida`);
  }
}

/** La imagen debe estar dentro del proyecto (evita leer archivos arbitrarios del disco). */
function validateImagePath(path: string, errors: string[]) {
  const absolute = resolve(path);
  const rel = relative(process.cwd(), absolute);
  if (rel.startsWith('..') || resolve(rel) !== absolute) {
    errors.push('IMAGE_PATH debe estar dentro de la carpeta del proyecto');
    return;
  }
  if (!ALLOWED_IMAGE_EXT.has(extname(absolute).toLowerCase())) {
    errors.push('IMAGE_PATH debe ser .jpg, .jpeg o .png');
    return;
  }
  if (!existsSync(absolute)) {
    errors.push(`IMAGE_PATH no existe: ${path}`);
    return;
  }
  const stats = statSync(absolute);
  if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) {
    errors.push('IMAGE_PATH debe ser un archivo de máximo 30 MB');
  }
}
