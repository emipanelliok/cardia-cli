# cardia-cli

CLI para que un **agente IA opere tarjetas Cardia** desde la línea de comandos.

A diferencia de la competencia (`agent-cards buy` de AgentCard, donde el agente
tiene barra libre), `cardia` se basa en **permisos acotados**: cada compra está
limitada por comercio, tope de monto y vigencia (TTL). El agente solo puede
gastar dentro de lo que vos le habilitaste.

```
agente IA  ──►  cardia grant   (define qué puede comprar y hasta cuánto)
agente IA  ──►  cardia buy     (intenta la compra; la API aprueba o rechaza)
```

## Instalación

Requiere Node.js >= 18.

```bash
git clone <repo> cardia-cli
cd cardia-cli
npm install
npm run build      # compila TypeScript a dist/

# opcional: usarlo como comando global `cardia`
npm link
```

Sin `npm link` lo corrés con `node dist/cli.js <comando>`.

## Configuración (variables de entorno)

La API admin se configura por entorno:

| Variable           | Descripción                                              | Ejemplo                              |
| ------------------ | -------------------------------------------------------- | ------------------------------------ |
| `CARDIA_API_URL`   | Base URL de la API admin                                 | `https://cardia-api.emipanelli.com`  |
| `CARDIA_API_TOKEN` | Token admin; se envía como header `x-admin-token`        | `tok_xxx`                            |

```bash
export CARDIA_API_URL="https://cardia-api.emipanelli.com"
export CARDIA_API_TOKEN="tu-admin-token"
```

Si falta alguna, el CLI te avisa con un mensaje claro y sale con código `3`.

## Comandos

### 1. `cardia cards`

Lista las tarjetas disponibles (id, label, `••••last4`, estado, gastado/límite).

```bash
cardia cards
```

```
Tarjetas (2)
  card_123  Operaciones  ••••4242  ACTIVE  gastado $12.000 / límite $200.000
  card_999  Marketing     ••••0007  BLOCKED gastado $0 / límite $50.000
```

### 2. `cardia grant` — crear un permiso

Habilita al agente a comprar en un comercio, con un tope y una vigencia.
Los pesos se convierten a centavos (×100). El TTL acepta `30m`, `1h`, `24h`,
`2d`, `90s`; por defecto **1h**.

```bash
cardia grant --card card_123 --merchant Jumbo --max 50000 --ttl 1h
```

```
✓ Permiso creado
  perm_abc
    comercio : Jumbo
    tope     : $50.000
    tarjeta  : card_123
    vigencia : vence 23/6/2026, 15:30:00 (en 1h)
```

### 3. `cardia buy` — flujo del agente

Dispara la compra (simulate). Dos modos:

- **Con `--max`**: primero crea el permiso (grant) y después intenta la compra.
  Útil para que el agente declare límite y compre en un solo paso.
- **Sin `--max`**: solo intenta la compra contra los permisos ya existentes.

`idempotencyKey` se genera automáticamente con `crypto.randomUUID()`.

```bash
# grant + buy en un paso
cardia buy --card card_123 --merchant Jumbo --amount 12000 --max 50000 --ttl 1h

# solo buy (usa permisos ya creados)
cardia buy --card card_123 --merchant Jumbo --amount 12000
```

Aprobada:

```
✓ APPROVED $12.000 en Jumbo  (permiso perm_abc)
```

Rechazada (sale con código `1`):

```
✗ REJECTED $80.000 en Jumbo
  motivo: amount exceeds permission max
```

### 4. `cardia permissions` — listar permisos

Lista los permisos con estado y vigencia. Filtrable por tarjeta.

```bash
cardia permissions
cardia permissions --card card_123
```

```
Permisos (1)
  perm_abc
    comercio : Jumbo
    tope     : $50.000
    tarjeta  : card_123
    estado   : ACTIVE
    vigencia : vence 23/6/2026, 15:30:00 (en 58m)
```

## Códigos de salida

| Código | Significado                                  |
| ------ | -------------------------------------------- |
| `0`    | OK                                           |
| `1`    | Compra rechazada (REJECTED) o error genérico |
| `2`    | Argumentos inválidos / uso incorrecto        |
| `3`    | Falta configuración (env vars)               |
| `4`    | Error de la API o de red                     |

## Endpoints usados

| Comando       | Método + endpoint                          |
| ------------- | ------------------------------------------ |
| `cards`       | `GET /admin/cards`                         |
| `grant`       | `POST /admin/permissions`                  |
| `buy`         | `POST /admin/permissions` (si `--max`) + `POST /admin/authorizations/simulate` |
| `permissions` | `GET /admin/permissions`                   |

Todas las requests envían el header `x-admin-token`.

## Desarrollo

```bash
npm run dev     # tsc --watch
npm run build   # compila una vez
```

Los colores ANSI se desactivan automáticamente si la salida no es una TTY o si
`NO_COLOR` está seteada.
