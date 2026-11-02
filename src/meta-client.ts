import { createHmac } from 'node:crypto';
import { redact } from './redact.ts';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';
export type Params = Record<string, unknown>;

/** Interfaz común para el cliente real y el de dry-run. */
export interface GraphApi {
  request<T>(method: HttpMethod, path: string, params?: Params): Promise<T>;
}

interface GraphErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
  is_transient?: boolean;
}

// 1/2 = errores temporales de Meta; 4/17/32/613/80004 = rate limits
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613, 80004]);
const SAFE_PATH = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?$/;

export class MetaApiError extends Error {
  override name = 'MetaApiError';
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly fbtraceId: string | undefined;
  readonly retryable: boolean;

  constructor(body: GraphErrorBody, httpStatus: number) {
    const userMsg = body.error_user_msg ? ` → ${body.error_user_msg}` : '';
    super(redact(`[Meta ${body.code ?? httpStatus}/${body.error_subcode ?? '-'}] ${body.message ?? 'Error desconocido'}${userMsg}`));
    this.code = body.code;
    this.subcode = body.error_subcode;
    this.fbtraceId = body.fbtrace_id;
    this.retryable = Boolean(body.is_transient) || (body.code !== undefined && RETRYABLE_CODES.has(body.code));
  }
}

export interface MetaClientOptions {
  apiVersion: string;
  accessToken: string;
  appSecret: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class MetaClient implements GraphApi {
  readonly #baseUrl: string;
  readonly #accessToken: string;
  readonly #appSecretProof: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(opts: MetaClientOptions) {
    this.#baseUrl = `https://graph.facebook.com/${opts.apiVersion}`;
    this.#accessToken = opts.accessToken;
    // appsecret_proof: aunque se filtre el token, sin el app secret no sirve contra esta app
    this.#appSecretProof = createHmac('sha256', opts.appSecret).update(opts.accessToken).digest('hex');
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxAttempts = opts.maxAttempts ?? 4;
  }

  async request<T>(method: HttpMethod, path: string, params: Params = {}): Promise<T> {
    if (!SAFE_PATH.test(path)) throw new Error(`Ruta de Graph API no permitida: ${path}`);

    const query = new URLSearchParams({ appsecret_proof: this.#appSecretProof });
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (key === 'access_token' || key === 'appsecret_proof') continue; // nunca desde params
      const encoded = typeof value === 'object' ? JSON.stringify(value) : String(value);
      (method === 'POST' ? body : query).append(key, encoded);
    }

    const url = `${this.#baseUrl}/${path}?${query}`;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          // El token va en el header, nunca en la URL (no queda en logs de proxies ni historiales)
          headers: { Authorization: `Bearer ${this.#accessToken}` },
          body: method === 'POST' ? body : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (attempt < this.#maxAttempts) {
          await this.#backoff(attempt, `Error de red: ${(err as Error).message}`);
          continue;
        }
        throw new Error(redact(`No se pudo contactar a Meta: ${(err as Error).message}`));
      }

      const data = (await res.json().catch(() => ({}))) as { error?: GraphErrorBody } & T;
      if (res.ok && !data.error) return data;

      const error = new MetaApiError(data.error ?? {}, res.status);
      if (error.retryable && attempt < this.#maxAttempts) {
        await this.#backoff(attempt, error.message);
        continue;
      }
      throw error;
    }
  }

  async #backoff(attempt: number, reason: string) {
    const wait = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
    console.warn(`  ⚠ ${redact(reason)}. Reintento ${attempt + 1}/${this.#maxAttempts} en ${(wait / 1000).toFixed(1)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Cliente que no llama a Meta: imprime cada request y devuelve IDs simulados. */
export class DryRunClient implements GraphApi {
  #counter = 0;
  readonly #apiVersion: string;

  constructor(apiVersion: string) {
    this.#apiVersion = apiVersion;
  }

  async request<T>(method: HttpMethod, path: string, params: Params = {}): Promise<T> {
    const printable: Params = { ...params };
    if (typeof printable.bytes === 'string') printable.bytes = `<base64 ${printable.bytes.length} chars>`;
    console.log(`\n  [dry-run] ${method} /${this.#apiVersion}/${path}`);
    console.log(redact(JSON.stringify(printable, null, 2)).replace(/^/gm, '    '));

    if (method === 'GET') {
      return { name: 'Cuenta simulada', currency: 'COP', account_status: 1, timezone_name: 'America/Bogota' } as T;
    }
    if (path.endsWith('/adimages')) return { images: { bytes: { hash: 'DRY_RUN_IMAGE_HASH' } } } as T;
    return { id: `DRY_RUN_${++this.#counter}` } as T;
  }
}
