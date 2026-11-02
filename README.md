# facebook-ads-caso-uso

Crea un flujo completo de Facebook/Instagram Ads con la Meta Marketing API:
**cuenta → imagen → campaña → conjunto de anuncios → creativo → anuncio**.
Todo queda en `PAUSED`, así que no se gasta nada hasta que lo actives.

## Requisitos

- Node.js 22.18+ (ejecuta TypeScript nativo, sin build)
- pnpm 12 (`corepack enable` toma la versión fija de `packageManager`)
- App de Meta tipo Business con el producto Marketing API

## Uso

```bash
corepack enable
pnpm install            # genera pnpm-lock.yaml: súbelo al repo
cp .env.example .env    # completa tus valores

pnpm dry-run            # imprime los payloads, no llama a Meta
pnpm sandbox            # META_ENV=sandbox: crea objetos en la cuenta sandbox
pnpm start              # META_ENV=production: pide confirmación escribiendo el ID de la cuenta
pnpm start -- --yes     # producción en CI (sin prompt)
```

Flags: `--dry-run`, `--keep-on-error` (no hace rollback si algo falla), `--yes`.

## Ambiente de prueba (sandbox)

En developers.facebook.com → tu app → **Marketing API → Tools** crea la cuenta sandbox
(una por app) y vincúlala a una Página. Los anuncios nunca se publican y no requiere
método de pago. No se ve en el Administrador de anuncios ni soporta Insights.

## Seguridad

### Cadena de suministro (`pnpm-workspace.yaml`)

| Control | Qué evita |
|---|---|
| `minimumReleaseAge: 10080` | Instalar versiones con menos de 7 días publicadas (ventana típica de paquetes comprometidos) |
| `trustPolicy: no-downgrade` | Versiones que pierden provenance/trusted publishing (cuenta de maintainer robada) |
| `strictDepBuilds` + `allowBuilds: {}` | Que corra cualquier `postinstall` no revisado |
| `blockExoticSubdeps` | Sub-dependencias desde git o tarballs por URL |
| `engineStrict`, `savePrefix: ''` | Versiones de Node/pnpm no soportadas y rangos `^`/`~` |
| `verifyDepsBeforeRun: error` | Correr scripts con `node_modules` distinto al lockfile |

Solo hay 2 dependencias, ambas de desarrollo; en runtime no hay ninguna.
`pnpm security` corre `pnpm audit` y `pnpm audit signatures`.

### Ejecución

- **Permission Model de Node**: los scripts corren con `--permission --allow-fs-read=./`.
  El proceso solo puede leer la carpeta del proyecto y no puede escribir en disco
  ni lanzar procesos hijos.
- **Token en header** `Authorization: Bearer`, nunca en la URL.
- **`appsecret_proof` obligatorio** en cada llamada. Activa también *Require App Secret*
  en la configuración avanzada de la app de Meta.
- **Redacción de secretos**: token y app secret se reemplazan por `***` en toda salida y error.
- **Allowlist de cuentas** (`META_ALLOWED_AD_ACCOUNTS`) y **tope de presupuesto**
  (`MAX_DAILY_BUDGET`): el script aborta antes de llamar a Meta si no se cumplen.
- **Confirmación en producción**: hay que escribir el ID de la cuenta, o pasar `--yes`.
- **Validación de entradas**: formatos de IDs y token, URLs solo `https`, imagen solo
  `.jpg`/`.png` de máximo 30 MB y dentro del proyecto.
- Timeouts de 30 s, sin seguir redirects, reintentos con backoff y rollback si algo falla.

### Recomendaciones fuera del código

- Usa un token de **System User** con permisos mínimos (`ads_management`,
  `pages_read_engagement`) y asignado solo a las cuentas necesarias.
- En CI guarda el token y el app secret en un secret store
  (Azure Key Vault / variables secretas del pipeline), no en `.env`.
- Rota el token si se expone, y revisa `pnpm security` en cada PR.
