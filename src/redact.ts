/**
 * Quita secretos de cualquier texto antes de imprimirlo o loguearlo.
 * Cubre los secretos conocidos de la config y cualquier cosa con forma de token de Meta.
 */
const META_TOKEN_PATTERN = /\bEA[A-Za-z0-9]{30,}\b/g;
const QUERY_SECRET_PATTERN = /((?:access_token|appsecret_proof|client_secret)=)[^&\s"']+/gi;

const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8 && !value.startsWith('<')) knownSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) out = out.split(secret).join('***');
  return out.replace(META_TOKEN_PATTERN, 'EA***').replace(QUERY_SECRET_PATTERN, '$1***');
}
