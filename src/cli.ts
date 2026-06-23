#!/usr/bin/env node
/**
 * cardia — CLI para que un agente IA opere tarjetas Cardia
 * con control via permisos acotados (comercio, tope, vigencia).
 *
 * Comandos:
 *   cardia cards
 *   cardia grant       --card <id> --merchant <Jumbo> --max <pesos> [--ttl 1h]
 *   cardia buy         --card <id> --merchant <Jumbo> --amount <pesos> [--max <pesos>] [--ttl 1h]
 *   cardia permissions [--card <id>]
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  CardiaApi,
  ConfigError,
  ApiError,
  type Card,
  type Permission,
} from "./api.js";

// ---------------------------------------------------------------------------
// Colores ANSI (sin dependencias). Se desactivan si la salida no es TTY o NO_COLOR.
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: (s: string) => (useColor ? `\x1b[0m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  gray: (s: string) => (useColor ? `\x1b[90m${s}\x1b[0m` : s),
};

const OK = c.green("✓"); // ✓
const FAIL = c.red("✗"); // ✗

// ---------------------------------------------------------------------------
// Errores de uso (args inválidos) -> mensaje + exit 2
// ---------------------------------------------------------------------------
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Helpers de parseo / formato
// ---------------------------------------------------------------------------

/** Convierte pesos (string/number) a centavos enteros. "1500" -> 150000. */
function pesosToCents(value: string | undefined, flag: string): number {
  if (value === undefined || value === "") {
    throw new UsageError(`Falta el valor para ${flag}.`);
  }
  const normalized = value.replace(/[,_\s]/g, "");
  const pesos = Number(normalized);
  if (!Number.isFinite(pesos) || pesos < 0) {
    throw new UsageError(`Valor inválido para ${flag}: "${value}" (esperaba pesos, ej. 1500).`);
  }
  return Math.round(pesos * 100);
}

/** Convierte centavos a string de pesos con separador de miles. */
function centsToPesos(cents: number): string {
  const pesos = cents / 100;
  return `$${pesos.toLocaleString("es-AR", {
    minimumFractionDigits: pesos % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Parsea un TTL "1h" / "30m" / "24h" / "90s" / "2d" a segundos. Default 1h. */
function parseTtl(value: string | undefined): number {
  if (value === undefined || value === "") return 3600; // 1h por defecto
  const match = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
  if (!match) {
    throw new UsageError(
      `TTL inválido: "${value}". Usá formatos como 30m, 1h, 24h, 2d o 90s.`
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * mult[unit];
}

/** Formatea segundos en algo legible: 3600 -> "1h". */
function formatTtl(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Devuelve un texto de vigencia a partir de expiresAt o ttlSeconds. */
function vigencia(p: Permission): string {
  if (p.expiresAt) {
    const exp = new Date(p.expiresAt);
    if (!isNaN(exp.getTime())) {
      const now = Date.now();
      const left = Math.round((exp.getTime() - now) / 1000);
      const when = exp.toLocaleString("es-AR");
      if (left <= 0) return `vencido (${when})`;
      return `vence ${when} ${c.gray(`(en ${formatTtl(left)})`)}`;
    }
  }
  if (typeof p.ttlSeconds === "number") {
    return `ttl ${formatTtl(p.ttlSeconds)}`;
  }
  return c.gray("sin vencimiento");
}

function statusColor(status: string | undefined): string {
  const s = (status || "").toUpperCase();
  if (["ACTIVE", "ACTIVA", "OK", "ENABLED"].includes(s)) return c.green(s);
  if (["EXPIRED", "VENCIDO", "BLOCKED", "DISABLED", "REVOKED"].includes(s))
    return c.red(s);
  return s ? c.yellow(s) : c.gray("-");
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function cmdCards(api: CardiaApi): Promise<void> {
  const cards = await api.listCards();
  if (cards.length === 0) {
    console.log(c.gray("No hay tarjetas."));
    return;
  }
  console.log(c.bold(`Tarjetas (${cards.length})`));
  for (const card of cards) {
    const masked = `••••${card.last4}`;
    const limit = centsToPesos(card.limit);
    const spent = centsToPesos(card.spent);
    console.log(
      `  ${c.cyan(card.id)}  ${c.bold(card.label)}  ${c.gray(masked)}  ` +
        `${statusColor(card.status)}  ${c.gray(`gastado ${spent} / límite ${limit}`)}`
    );
  }
}

function printPermission(p: Permission): void {
  console.log(`  ${c.cyan(p.id)}`);
  console.log(`    comercio : ${c.bold(p.merchant)}`);
  console.log(`    tope     : ${centsToPesos(p.maxAmountCents)}`);
  console.log(`    tarjeta  : ${p.cardId}`);
  if (p.status) console.log(`    estado   : ${statusColor(p.status)}`);
  console.log(`    vigencia : ${vigencia(p)}`);
}

async function cmdGrant(
  api: CardiaApi,
  opts: { card?: string; merchant?: string; max?: string; ttl?: string }
): Promise<Permission> {
  if (!opts.card) throw new UsageError("Falta --card <id>.");
  if (!opts.merchant) throw new UsageError("Falta --merchant <nombre>.");
  const maxAmountCents = pesosToCents(opts.max, "--max");
  const ttlSeconds = parseTtl(opts.ttl);

  const permission = await api.createPermission({
    cardId: opts.card,
    merchant: opts.merchant,
    maxAmountCents,
    ttlSeconds,
  });

  console.log(`${OK} ${c.bold("Permiso creado")}`);
  printPermission(permission);
  return permission;
}

async function cmdBuy(
  api: CardiaApi,
  opts: {
    card?: string;
    merchant?: string;
    amount?: string;
    max?: string;
    ttl?: string;
  }
): Promise<void> {
  if (!opts.card) throw new UsageError("Falta --card <id>.");
  if (!opts.merchant) throw new UsageError("Falta --merchant <nombre>.");
  const amountCents = pesosToCents(opts.amount, "--amount");

  let permissionId: string | undefined;

  // Si pasa --max, primero crea el permiso (grant) y luego dispara la compra.
  if (opts.max !== undefined) {
    const permission = await cmdGrant(api, {
      card: opts.card,
      merchant: opts.merchant,
      max: opts.max,
      ttl: opts.ttl,
    });
    permissionId = permission.id;
    console.log("");
  }

  const idempotencyKey = randomUUID();
  console.log(
    c.dim(
      `Comprando ${centsToPesos(amountCents)} en ${opts.merchant} ` +
        `(idempotencyKey ${idempotencyKey})...`
    )
  );

  const result = await api.simulateAuthorization({
    cardId: opts.card,
    amountCents,
    merchant: opts.merchant,
    idempotencyKey,
  });

  if (result.status === "APPROVED") {
    console.log(
      `${OK} ${c.green(c.bold("APPROVED"))} ` +
        `${centsToPesos(amountCents)} en ${c.bold(opts.merchant)}` +
        (result.permissionId || permissionId
          ? c.gray(`  (permiso ${result.permissionId || permissionId})`)
          : "")
    );
  } else {
    console.log(
      `${FAIL} ${c.red(c.bold("REJECTED"))} ` +
        `${centsToPesos(amountCents)} en ${c.bold(opts.merchant)}`
    );
    console.log(`  motivo: ${c.yellow(result.reason || "sin motivo informado")}`);
    process.exitCode = 1;
  }
}

async function cmdPermissions(
  api: CardiaApi,
  opts: { card?: string }
): Promise<void> {
  let permissions = await api.listPermissions();
  if (opts.card) {
    permissions = permissions.filter((p) => p.cardId === opts.card);
  }
  if (permissions.length === 0) {
    console.log(
      c.gray(opts.card ? `No hay permisos para la tarjeta ${opts.card}.` : "No hay permisos.")
    );
    return;
  }
  console.log(c.bold(`Permisos (${permissions.length})`));
  for (const p of permissions) {
    printPermission(p);
  }
}

// ---------------------------------------------------------------------------
// Ayuda
// ---------------------------------------------------------------------------
function printHelp(): void {
  const lines = [
    c.bold("cardia") + " — operá tarjetas Cardia con permisos acotados",
    "",
    c.bold("Uso:"),
    "  cardia <comando> [opciones]",
    "",
    c.bold("Comandos:"),
    `  ${c.cyan("cards")}                            Lista tarjetas (id, label, ••••last4, estado).`,
    `  ${c.cyan("grant")}   --card <id> --merchant <Jumbo> --max <pesos> [--ttl 1h]`,
    `                                   Crea un permiso (comercio, tope, vigencia).`,
    `  ${c.cyan("buy")}     --card <id> --merchant <Jumbo> --amount <pesos> [--max <pesos>] [--ttl 1h]`,
    `                                   Compra. Con --max crea el permiso y luego compra.`,
    `  ${c.cyan("permissions")} [--card <id>]         Lista permisos con estado y vigencia.`,
    "",
    c.bold("Variables de entorno:"),
    "  CARDIA_API_URL     base de la API admin (ej. https://cardia-api.emipanelli.com)",
    "  CARDIA_API_TOKEN   token admin (header x-admin-token)",
    "",
    c.bold("Ejemplos:"),
    "  cardia cards",
    "  cardia grant --card card_123 --merchant Jumbo --max 50000 --ttl 1h",
    "  cardia buy --card card_123 --merchant Jumbo --amount 12000 --max 50000",
    "  cardia buy --card card_123 --merchant Jumbo --amount 12000",
    "  cardia permissions --card card_123",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log("cardia-cli 0.1.0");
    return;
  }

  // Parseo de flags compartido por los comandos que las usan.
  let values: Record<string, string | undefined> = {};
  if (["grant", "buy", "permissions"].includes(command)) {
    try {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          card: { type: "string" },
          merchant: { type: "string" },
          max: { type: "string" },
          amount: { type: "string" },
          ttl: { type: "string" },
        },
        allowPositionals: false,
        strict: true,
      });
      values = parsed.values as Record<string, string | undefined>;
    } catch (err) {
      throw new UsageError(
        err instanceof Error ? err.message : "Argumentos inválidos."
      );
    }
  }

  // Los comandos necesitan API -> validar env recién acá (cards/grant/buy/permissions).
  const api = CardiaApi.fromEnv();

  switch (command) {
    case "cards":
      await cmdCards(api);
      break;
    case "grant":
      await cmdGrant(api, values);
      break;
    case "buy":
      await cmdBuy(api, values);
      break;
    case "permissions":
      await cmdPermissions(api, values);
      break;
    default:
      throw new UsageError(
        `Comando desconocido: "${command}". Probá: cards, grant, buy, permissions. (cardia help)`
      );
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`${FAIL} ${err.message}`);
    console.error(c.gray("Ejecutá 'cardia help' para ver el uso."));
    process.exit(2);
  }
  if (err instanceof ConfigError) {
    console.error(`${FAIL} ${c.red("Error de configuración")}`);
    console.error(err.message);
    process.exit(3);
  }
  if (err instanceof ApiError) {
    console.error(`${FAIL} ${c.red(err.message)}`);
    process.exit(4);
  }
  console.error(`${FAIL} ${c.red("Error inesperado")}: ${err?.message || err}`);
  process.exit(1);
});
