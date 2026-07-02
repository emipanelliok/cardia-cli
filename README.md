# cardia

CLI + servidor MCP para que un **agente IA opere tarjetas Cardia** con control:
cada compra está limitada por **permisos acotados** (comercio, tope de monto y
vigencia/TTL). El agente solo puede gastar dentro de lo que vos le habilitaste
(deny-by-default en tarjetas modo `scoped`).

```
vos        ──►  cardia grant   (definís qué puede comprar y hasta cuánto)
agente IA  ──►  cardia buy     (intenta la compra; la API aprueba o rechaza)
agente IA  ──►  cardia mcp     (o directamente por MCP desde Claude / Cursor)
```

## Instalación

Requiere Node.js >= 18.

```bash
# global
npm install -g cardia
cardia help

# o sin instalar
npx cardia help
```

## Beta privada

Cardia está en **beta privada**: todavía no hay registro público. Si corrés
cualquier comando sin credenciales configuradas, el CLI te muestra el mensaje
de beta y la lista de espera en **[cardia.digital](https://cardia.digital)**
(sale con código `0`). La excepción es `cardia mcp`, que sin credenciales
escribe el error a stderr y sale con código `1` (nunca ensucia stdout, que es
del protocolo MCP).

## Configuración (variables de entorno)

| Variable           | Descripción                                        | Ejemplo                             |
| ------------------ | -------------------------------------------------- | ----------------------------------- |
| `CARDIA_API_URL`   | Base URL de la API admin                           | `https://cardia-api.emipanelli.com` |
| `CARDIA_API_TOKEN` | Token admin; se envía como header `x-admin-token`  | `tok_xxx`                           |

```bash
export CARDIA_API_URL="https://cardia-api.emipanelli.com"
export CARDIA_API_TOKEN="tu-admin-token"
```

Todas las requests tienen un timeout de 15 segundos.

## Comandos

### `cardia teams` — onboarding

Wizard interactivo: creá tu empresa y dale una tarjeta a un miembro del equipo
(persona o agente). Las tarjetas de **agentes** se emiten en modo `scoped`
(deny-by-default: arrancan sin permisos y les habilitás compras con
`cardia grant`); las de **personas** en modo `free` (pagan hasta el límite).

```bash
cardia teams
```

### `cardia cards`

Lista las tarjetas (id, label, `••••last4`, estado, gastado/límite).

```bash
cardia cards
```

```
Tarjetas (2)
  card_123  Operaciones  ••••4242  ACTIVE  gastado $12.000 / límite $200.000
  card_999  Marketing     ••••0007  BLOCKED gastado $0 / límite $50.000
```

### `cardia grant` — crear un permiso

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

### `cardia buy` — flujo del agente

Dispara la compra (simulate). Dos modos:

- **Con `--max`**: primero crea el permiso (grant) y después intenta la compra.
- **Sin `--max`**: solo intenta la compra contra los permisos ya existentes.

`idempotencyKey` se genera automáticamente con `crypto.randomUUID()`.

```bash
cardia buy --card card_123 --merchant Jumbo --amount 12000 --max 50000 --ttl 1h
cardia buy --card card_123 --merchant Jumbo --amount 12000
```

Aprobada: `✓ APPROVED $12.000 en Jumbo  (permiso perm_abc)`
Rechazada (sale con código `1`): `✗ REJECTED $80.000 en Jumbo` + motivo.

### `cardia permissions` — listar permisos

```bash
cardia permissions
cardia permissions --card card_123
```

### `cardia purchase` / `cardia reveal` — tarjeta por compra (single-use)

Crea una **tarjeta por compra**: nace atada a **un comercio** y **un monto**
(que es su límite exacto), devuelve los datos (PAN/CVV/vencimiento) **una sola
vez**, y **muere sola** (se cancela) después de su primer pago `APPROVED`.
Sirve para exactamente una compra — nada de tarjetas "vivas" dando vueltas.

Ejemplo — el agente te compra un vuelo:

```bash
cardia purchase --merchant Aerolineas --amount 150000 --label "Vuelo MDZ-AEP"
```

```
✓ Tarjeta por compra creada (single-use)
  card_abc  Vuelo MDZ-AEP  ••••3119
    lock   : 🔒 Aerolineas (solo aprueba en este comercio)
    límite : $150.000 [ARS]

  ⚠ Datos de la tarjeta — se muestran una sola vez. Guardalos ahora.
    número : 4111 1111 1111 3119
    cvv    : 123
    vence  : 06/29

  Flujo: si la cuenta es nueva, fondeala (cash-in) antes de pagar.
  La compra aprueba UNA vez y la tarjeta muere sola (se cancela).
  Ojo: el saldo de cuentas recién creadas puede tardar ~10s en verse.
```

Flujo completo: **crear → cargar los datos en el checkout → pagar → la tarjeta
muere**. Si la cuenta que respalda la tarjeta es nueva, hacé el cash-in antes
de pagar; el saldo Pomelo de cuentas recién creadas puede tardar **~10
segundos** en verse reflejado.

`cardia reveal` vuelve a mostrar los datos de una tarjeta existente:

```bash
cardia reveal --card card_abc
```

- Tarjeta **cancelada** (p. ej. una single-use que ya pagó) → la API responde
  `409` y el CLI lo explica ("ya hizo su pago y murió").
- Token con **rol agent** → `403`: el reveal es solo para el dueño (owner).

### `cardia mcp` — servidor MCP (Claude Code, Claude Desktop, Cursor)

Levanta un servidor [MCP](https://modelcontextprotocol.io) por **stdio** para
que tu agente opere Cardia con tools nativas, sin shellear al CLI.

**Claude Code:**

```bash
claude mcp add cardia --env CARDIA_API_URL=https://cardia-api.emipanelli.com --env CARDIA_API_TOKEN=tok_xxx -- npx cardia mcp
```

(Si ya exportaste las env vars en tu shell, alcanza con
`claude mcp add cardia -- npx cardia mcp`.)

**Claude Desktop** (`claude_desktop_config.json`) **/ Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cardia": {
      "command": "npx",
      "args": ["cardia", "mcp"],
      "env": {
        "CARDIA_API_URL": "https://cardia-api.emipanelli.com",
        "CARDIA_API_TOKEN": "tok_xxx"
      }
    }
  }
}
```

Tools expuestas (todos los montos en **centavos**):

| Tool                | Qué hace                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| `list_cards`        | Lista tarjetas (límite/gastado, estado, modo)                             |
| `create_card`       | Crea cuenta + tarjetas para un miembro (modo `scoped` por defecto)        |
| `check_balance`     | Saldos por cuenta (ARS/USD); con `accountId` da el detalle de una cuenta  |
| `set_limit`         | Cambia el límite de una tarjeta                                           |
| `freeze_card`       | Congela una tarjeta (rechaza toda compra)                                 |
| `unfreeze_card`     | Reactiva una tarjeta congelada                                            |
| `grant_permission`  | Otorga un permiso acotado (comercio + tope + TTL)                         |
| `list_permissions`  | Lista permisos, filtrable por tarjeta                                     |
| `authorize_payment` | Intenta un pago → `APPROVED` / `REJECTED` con motivo                      |
| `get_transactions`  | Transacciones paginadas, filtrables por tarjeta y resultado               |
| `create_purchase_card` | Tarjeta por compra (single-use): un comercio + un monto **en pesos**, PAN/CVV una sola vez, muere tras el primer pago |
| `reveal_card`       | Vuelve a mostrar PAN/CVV/vencimiento de una tarjeta (409 si está cancelada) |

Sin `CARDIA_API_URL`/`CARDIA_API_TOKEN`, `cardia mcp` escribe el error a
stderr y sale con `1`; stdout queda limpio para el handshake JSON-RPC.

## Códigos de salida

| Código | Significado                                                          |
| ------ | -------------------------------------------------------------------- |
| `0`    | OK (incluye el mensaje de beta sin credenciales)                     |
| `1`    | Compra rechazada (REJECTED), `mcp` sin credenciales o error genérico |
| `2`    | Argumentos inválidos / comando desconocido                           |
| `3`    | Falta configuración (env vars) en comandos que la requieren          |
| `4`    | Error de la API o de red                                             |

## Endpoints usados

| Comando / tool        | Método + endpoint                                                              |
| --------------------- | ------------------------------------------------------------------------------ |
| `cards`, `list_cards` | `GET /admin/cards`                                                             |
| `teams`, `create_card`| `POST /admin/customers` + `POST /admin/cards`                                  |
| `grant`, `grant_permission` | `POST /admin/permissions`                                                |
| `buy`, `authorize_payment`  | `POST /admin/authorizations/simulate`                                    |
| `permissions`, `list_permissions` | `GET /admin/permissions`                                           |
| `check_balance`       | `GET /admin/accounts` · `GET /admin/accounts/:id`                              |
| `set_limit`           | `PATCH /admin/cards/:id/limit`                                                 |
| `freeze_card` / `unfreeze_card` | `POST /admin/cards/:id/block` · `POST /admin/cards/:id/activate`     |
| `get_transactions`    | `GET /admin/authorizations`                                                    |
| `purchase`, `create_purchase_card` | `POST /admin/cards/purchase`                                      |
| `reveal`, `reveal_card` | `GET /admin/cards/:id/reveal`                                                |

Todas las requests envían el header `x-admin-token`.

## Desarrollo

```bash
npm install
npm run dev     # tsc --watch
npm run build   # compila una vez a dist/
```

Los colores ANSI se desactivan automáticamente si la salida no es una TTY o si
`NO_COLOR` está seteada.
