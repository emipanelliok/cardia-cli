/**
 * cardia mcp — servidor MCP por stdio para operar Cardia desde un agente
 * (Claude Code, Claude Desktop, Cursor, etc.).
 *
 *   claude mcp add cardia -- npx cardia mcp
 *
 * REGLA DE ORO: por stdout solo sale JSON-RPC (el transporte MCP). Cualquier
 * log/error humano va a stderr; si no, se rompe el handshake del cliente.
 *
 * Config por env (las mismas del CLI):
 *   CARDIA_API_URL    -> base URL de la API admin
 *   CARDIA_API_TOKEN  -> token (header x-admin-token)
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CardiaApi } from "./api.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

// ---------------------------------------------------------------------------
// Helpers de respuesta: texto legible + JSON, y errores como isError (nunca crash).
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(summary: string, data?: unknown): ToolResult {
  const text =
    data === undefined
      ? summary
      : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Envuelve un handler: cualquier error de API/red se devuelve como isError. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Error de la API de Cardia: ${msg}`);
    }
  };
}

/** Formatea centavos como monto legible según moneda. */
function money(cents: number, currency?: string): string {
  const units = (cents / 100).toLocaleString("es-AR", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `US$${units}` : `$${units}`;
}

// ---------------------------------------------------------------------------
// Servidor MCP con las 10 tools de Cardia
// ---------------------------------------------------------------------------

export function buildServer(api: CardiaApi): McpServer {
  const server = new McpServer({ name: "cardia", version: pkg.version });

  // 1. list_cards
  server.registerTool(
    "list_cards",
    {
      title: "Listar tarjetas",
      description:
        "Lista todas las tarjetas Cardia: id, label, últimos 4 dígitos, moneda (ARS/USD), " +
        "límite y gastado (ambos en CENTAVOS), estado (active/frozen/cancelled) y modo " +
        '("scoped" = exige permisos, "free" = paga hasta el límite).',
      inputSchema: {},
    },
    safe(async () => {
      const cards = await api.listCards();
      if (cards.length === 0) return ok("No hay tarjetas emitidas todavía.");
      const lines = cards.map(
        (card) =>
          `- ${card.id} "${card.label}" ••••${card.last4} [${card.currency ?? "ARS"}] ` +
          `${card.status} — gastado ${money(card.spent, card.currency)} / límite ${money(card.limit, card.currency)}`
      );
      return ok(`${cards.length} tarjeta(s):\n${lines.join("\n")}`, { cards });
    })
  );

  // 2. create_card
  server.registerTool(
    "create_card",
    {
      title: "Crear tarjeta",
      description:
        "Crea una cuenta nueva con sus tarjetas Cardia para un miembro del equipo (persona o agente). "
        + 'El límite va en CENTAVOS (ej. $50.000 = 5000000). Modo "scoped" (default, recomendado para agentes): '
        + "deny-by-default, solo compra con permisos otorgados via grant_permission. "
        + 'Modo "free": paga hasta el límite sin permisos (para personas).',
      inputSchema: {
        label: z.string().min(1).describe("Nombre de la tarjeta / del miembro (ej. 'Agente Compras')"),
        limitCents: z
          .number()
          .int()
          .positive()
          .describe("Límite de gasto en CENTAVOS (ej. 5000000 = $50.000)"),
        mode: z
          .enum(["scoped", "free"])
          .default("scoped")
          .describe('"scoped" = requiere permisos (agentes, default) · "free" = sin permisos (personas)'),
        currency: z
          .enum(["ARS", "USD"])
          .optional()
          .describe("Moneda preferida (opcional; la cuenta nueva emite tarjetas ARS y USD)"),
        customerId: z
          .string()
          .optional()
          .describe("ID del cliente/empresa (cus_...) al que asociar la cuenta (opcional)"),
      },
    },
    safe(async (args: {
      label: string;
      limitCents: number;
      mode: "scoped" | "free";
      currency?: "ARS" | "USD";
      customerId?: string;
    }) => {
      const result = await api.createMember({
        label: args.label,
        limit: args.limitCents,
        mode: args.mode,
        currency: args.currency,
        customerId: args.customerId,
      });
      const lines = result.cards.map(
        (card) =>
          `- ${card.id} ••••${card.last4} [${card.currency ?? "ARS"}] límite ${money(card.limit, card.currency)}`
      );
      return ok(
        `Tarjeta(s) creada(s) para "${args.label}" (cuenta ${result.accountId}, modo ${args.mode}):\n` +
          lines.join("\n") +
          (args.mode === "scoped"
            ? "\n\nOJO: en modo scoped la tarjeta arranca SIN permisos; otorgalos con grant_permission."
            : ""),
        result
      );
    })
  );

  // 3. check_balance
  server.registerTool(
    "check_balance",
    {
      title: "Consultar saldos",
      description:
        "Consulta los saldos de las cuentas Cardia, en CENTAVOS por moneda (ARS y USD). " +
        "Sin accountId devuelve todas las cuentas; con accountId devuelve el detalle de esa cuenta " +
        "(saldos + tarjetas + últimos movimientos).",
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe("ID de la cuenta (acc_...). Si se omite, lista todas las cuentas."),
      },
    },
    safe(async (args: { accountId?: string }) => {
      if (args.accountId) {
        const detail = await api.getAccount(args.accountId);
        const b = detail.account.balances;
        const summary =
          `Cuenta ${detail.account.id}` +
          (detail.account.customerName ? ` (${detail.account.customerName})` : "") +
          `: saldo ARS ${money(b?.ARS ?? detail.account.balanceCents ?? 0)} · ` +
          `USD ${money(b?.USD ?? 0, "USD")} · ${detail.cards.length} tarjeta(s)`;
        return ok(summary, detail);
      }
      const accounts = await api.listAccounts();
      if (accounts.length === 0) return ok("No hay cuentas creadas todavía.");
      const lines = accounts.map((a) => {
        const b = a.balances;
        return (
          `- ${a.id}` +
          (a.customerName ? ` (${a.customerName})` : "") +
          `: ARS ${money(b?.ARS ?? a.balanceCents ?? 0)} · USD ${money(b?.USD ?? 0, "USD")}` +
          ` · ${a.cardCount ?? 0} tarjeta(s)`
        );
      });
      return ok(`${accounts.length} cuenta(s):\n${lines.join("\n")}`, { accounts });
    })
  );

  // 4. set_limit
  server.registerTool(
    "set_limit",
    {
      title: "Cambiar límite de tarjeta",
      description:
        "Cambia el límite de gasto de una tarjeta. El límite va en CENTAVOS y debe ser mayor " +
        "a lo ya gastado (si no, la API lo rechaza).",
      inputSchema: {
        cardId: z.string().min(1).describe("ID de la tarjeta (card_...)"),
        limitCents: z
          .number()
          .int()
          .positive()
          .describe("Nuevo límite en CENTAVOS (ej. 10000000 = $100.000)"),
      },
    },
    safe(async (args: { cardId: string; limitCents: number }) => {
      const card = await api.setCardLimit(args.cardId, args.limitCents);
      return ok(
        `Límite actualizado: tarjeta ${card.id} "${card.label}" ahora tiene límite ` +
          `${money(card.limit, card.currency)} (gastado ${money(card.spent, card.currency)}).`,
        { card }
      );
    })
  );

  // 5. freeze_card
  server.registerTool(
    "freeze_card",
    {
      title: "Congelar tarjeta",
      description:
        "Congela (bloquea) una tarjeta: rechaza toda compra hasta que se reactive con unfreeze_card. " +
        "Es reversible; no cancela la tarjeta.",
      inputSchema: {
        cardId: z.string().min(1).describe("ID de la tarjeta (card_...)"),
      },
    },
    safe(async (args: { cardId: string }) => {
      const card = await api.blockCard(args.cardId);
      return ok(
        `Tarjeta ${card.id} "${card.label}" congelada (estado: ${card.status}). ` +
          "No va a aprobar compras hasta reactivarla con unfreeze_card.",
        { card }
      );
    })
  );

  // 6. unfreeze_card
  server.registerTool(
    "unfreeze_card",
    {
      title: "Reactivar tarjeta",
      description: "Reactiva una tarjeta congelada: vuelve a estado activo y puede operar de nuevo.",
      inputSchema: {
        cardId: z.string().min(1).describe("ID de la tarjeta (card_...)"),
      },
    },
    safe(async (args: { cardId: string }) => {
      const card = await api.activateCard(args.cardId);
      return ok(
        `Tarjeta ${card.id} "${card.label}" reactivada (estado: ${card.status}).`,
        { card }
      );
    })
  );

  // 7. grant_permission
  server.registerTool(
    "grant_permission",
    {
      title: "Otorgar permiso de compra",
      description:
        "Otorga un permiso acotado de compra sobre una tarjeta: comercio, tope en CENTAVOS y " +
        "vigencia (TTL en segundos, default 3600 = 1 hora). En tarjetas modo scoped es la ÚNICA " +
        "forma de habilitar compras (deny-by-default).",
      inputSchema: {
        cardId: z.string().min(1).describe("ID de la tarjeta (card_...)"),
        merchant: z.string().min(1).describe("Comercio habilitado (ej. 'OpenAI', 'Jumbo')"),
        maxAmountCents: z
          .number()
          .int()
          .positive()
          .describe("Tope máximo del permiso en CENTAVOS (ej. 5000000 = $50.000)"),
        ttlSeconds: z
          .number()
          .int()
          .positive()
          .default(3600)
          .describe("Vigencia del permiso en segundos (default 3600 = 1h)"),
      },
    },
    safe(async (args: {
      cardId: string;
      merchant: string;
      maxAmountCents: number;
      ttlSeconds: number;
    }) => {
      const permission = await api.createPermission(args);
      return ok(
        `Permiso ${permission.id} creado: la tarjeta ${permission.cardId} puede comprar en ` +
          `"${permission.merchant}" hasta ${money(permission.maxAmountCents)}` +
          (permission.expiresAt ? `, vence ${permission.expiresAt}` : "") +
          ".",
        { permission }
      );
    })
  );

  // 8. list_permissions
  server.registerTool(
    "list_permissions",
    {
      title: "Listar permisos",
      description:
        "Lista los permisos de compra (comercio, tope en CENTAVOS, estado open/used/expired/cancelled " +
        "y vencimiento). Filtrable por tarjeta con cardId.",
      inputSchema: {
        cardId: z
          .string()
          .optional()
          .describe("Filtrar por tarjeta (card_...). Si se omite, lista todos."),
      },
    },
    safe(async (args: { cardId?: string }) => {
      const permissions = await api.listPermissions(args.cardId);
      if (permissions.length === 0) {
        return ok(
          args.cardId
            ? `No hay permisos para la tarjeta ${args.cardId}.`
            : "No hay permisos creados."
        );
      }
      const lines = permissions.map(
        (p) =>
          `- ${p.id} [${p.status ?? "?"}] tarjeta ${p.cardId} → "${p.merchant}" ` +
          `hasta ${money(p.maxAmountCents)}` +
          (p.expiresAt ? `, vence ${p.expiresAt}` : "")
      );
      return ok(`${permissions.length} permiso(s):\n${lines.join("\n")}`, { permissions });
    })
  );

  // 9. authorize_payment
  server.registerTool(
    "authorize_payment",
    {
      title: "Autorizar un pago",
      description:
        "Intenta un pago con una tarjeta Cardia (monto en CENTAVOS) contra el motor real de " +
        "autorización (saldo + permisos). Devuelve APPROVED o REJECTED con el motivo. En tarjetas " +
        "scoped necesita un permiso vigente que cubra comercio y monto (ver grant_permission). " +
        "La idempotencyKey se genera automáticamente.",
      inputSchema: {
        cardId: z.string().min(1).describe("ID de la tarjeta (card_...)"),
        merchant: z.string().min(1).describe("Comercio donde se paga (ej. 'OpenAI')"),
        amountCents: z
          .number()
          .int()
          .positive()
          .describe("Monto del pago en CENTAVOS (ej. 1200000 = $12.000)"),
      },
    },
    safe(async (args: { cardId: string; merchant: string; amountCents: number }) => {
      const result = await api.simulateAuthorization({
        cardId: args.cardId,
        merchant: args.merchant,
        amountCents: args.amountCents,
        idempotencyKey: randomUUID(),
      });
      if (result.status === "APPROVED") {
        return ok(
          `APPROVED — pago de ${money(args.amountCents)} en "${args.merchant}" aprobado` +
            (result.permissionId ? ` (permiso ${result.permissionId})` : "") +
            ".",
          result
        );
      }
      return ok(
        `REJECTED — pago de ${money(args.amountCents)} en "${args.merchant}" rechazado. ` +
          `Motivo: ${result.reason ?? "sin motivo informado"}` +
          (result.detail ? ` (${result.detail})` : "") +
          ".",
        result
      );
    })
  );

  // 10. get_transactions
  server.registerTool(
    "get_transactions",
    {
      title: "Ver transacciones",
      description:
        "Lista las transacciones (autorizaciones) más recientes, paginadas: monto en CENTAVOS, " +
        "comercio, APPROVED/REJECTED y motivo. Filtrable por tarjeta y por resultado.",
      inputSchema: {
        cardId: z.string().optional().describe("Filtrar por tarjeta (card_...)"),
        approved: z
          .boolean()
          .optional()
          .describe("true = solo aprobadas · false = solo rechazadas · omitido = todas"),
        page: z.number().int().positive().default(1).describe("Página (default 1)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(20)
          .describe("Resultados por página (default 20, máx 100)"),
      },
    },
    safe(async (args: {
      cardId?: string;
      approved?: boolean;
      page: number;
      limit: number;
    }) => {
      const { authorizations, pagination } = await api.listAuthorizations(args);
      if (authorizations.length === 0) {
        return ok("No hay transacciones para esos filtros.");
      }
      const lines = authorizations.map(
        (t) =>
          `- ${t.at} ${t.status} ${money(t.amount)} en "${t.merchant}" (tarjeta ${t.cardId})` +
          (t.status === "REJECTED" && t.reason ? ` — motivo: ${t.reason}` : "")
      );
      const pageInfo = pagination
        ? ` (página ${pagination.page}/${pagination.pages}, total ${pagination.total})`
        : "";
      return ok(
        `${authorizations.length} transacción(es)${pageInfo}:\n${lines.join("\n")}`,
        { authorizations, pagination }
      );
    })
  );

  return server;
}

/**
 * Arranca el servidor MCP por stdio. Asume que las env vars ya fueron validadas
 * por el CLI (si faltan acá, igual se reporta por stderr y exit 1: stdout es sagrado).
 */
export async function runMcpServer(): Promise<void> {
  let api: CardiaApi;
  try {
    api = CardiaApi.fromEnv();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cardia mcp: ${msg}\n`);
    process.exit(1);
  }
  const server = buildServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `cardia mcp v${pkg.version} listo (stdio) — API: ${process.env.CARDIA_API_URL}\n`
  );
}
