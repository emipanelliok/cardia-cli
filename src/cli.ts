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
 *   cardia mcp         (servidor MCP por stdio para Claude Code / Claude Desktop / Cursor)
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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

// Nombre y versión reales desde package.json (nada hardcodeado).
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

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
  const permissions = await api.listPermissions(opts.card);
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
// cardia teams — onboarding interactivo: empresa + tarjeta para un miembro (persona/agente)
// ---------------------------------------------------------------------------
async function cmdTeams(api: CardiaApi): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const ask = (q: string) => rl.question(q);
  try {
    console.log("");
    console.log(
      "  " + c.bold(c.cyan("◆ Cardia Teams")) +
        c.gray(" — pagos para tu equipo (gente + agentes), con control")
    );
    console.log(
      c.gray("  Tarjetas en USDT o pesos, con límite, para pagar IA (Claude, OpenAI, APIs...).\n")
    );

    // 1/3 — Empresa
    console.log(c.bold("  1/3  Tu empresa"));
    const empresa = (await ask("       Nombre › ")).trim();
    if (!empresa) throw new UsageError("Necesito el nombre de la empresa.");
    const customer = await api.createCustomer({ name: empresa });
    console.log(`       ${OK} Empresa creada: ${c.bold(empresa)}\n`);

    // 2/3 — A quién
    console.log(c.bold("  2/3  ¿A quién le das una tarjeta?"));
    const tipo = (await ask("       Agente (a) o Persona (p) › ")).trim().toLowerCase();
    const esAgente = tipo.startsWith("a");
    const quien = esAgente ? "agente" : "persona";
    const nombre = (await ask(`       Nombre del ${quien} › `)).trim() || quien;
    const moneda = (await ask("       Moneda — USDT (u) o Pesos (p) › ")).trim().toLowerCase();
    const currency = moneda.startsWith("p") ? "ARS" : "USD"; // USDT se respalda en saldo USD
    const monedaLabel = currency === "ARS" ? "Pesos (ARS)" : "USDT";
    console.log("");

    // 3/3 — Límite
    console.log(c.bold("  3/3  Límite mensual"));
    const limStr = (await ask(`       ${currency === "ARS" ? "$" : "US$"} › `)).trim();
    const limitCents = pesosToCents(limStr, "límite"); // *100, sirve para ARS y USD

    // AGENTES → "scoped" (deny-by-default: solo compra con permisos otorgados via `cardia grant`).
    // PERSONAS → "free" (tarjeta de gasto: paga hasta el límite sin permisos).
    const { cards } = await api.createMember({
      label: nombre,
      customerId: customer.id,
      limit: limitCents,
      mode: esAgente ? "scoped" : "free",
    });
    const card = cards.find((cc) => (cc.currency ?? "ARS") === currency) ?? cards[0];
    console.log(
      `       ${OK} Tarjeta ${c.bold(monedaLabel)} creada para ${c.bold(nombre)} ${c.gray("(" + quien + ")")}\n`
    );

    // Resultado
    console.log("  " + c.green(c.bold("✓ Listo.")));
    if (esAgente) {
      console.log("  Conectá el agente (Claude / Cursor) por MCP:");
      console.log("     " + c.cyan("claude mcp add cardia -- npx cardia mcp"));
      console.log(
        c.gray(
          "  La tarjeta arranca en modo scoped: SIN permisos, no puede gastar nada.\n" +
            "  Habilitá compras con: " +
            `cardia grant --card ${card?.id ?? "<id>"} --merchant <Comercio> --max <pesos> --ttl 1h`
        )
      );
    } else {
      console.log(
        `  Pasale a ${c.bold(nombre)} los datos de la tarjeta ${c.gray("••••" + (card?.last4 ?? "----"))} ` +
          "para cargar en Claude / OpenAI."
      );
    }
    const limTxt = currency === "ARS" ? centsToPesos(limitCents) : `US$${limitCents / 100}`;
    console.log(c.gray(`\n  Límite: ${limTxt} / mes. Vos controlás y ves cada cobro.`));
    console.log(c.gray("  Panel del gasto de IA del equipo → cardia.digital/admin\n"));
  } finally {
    rl.close();
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
    `  ${c.cyan("teams")}                            Onboarding: creá tu empresa y dale una tarjeta a un miembro (persona/agente).`,
    `  ${c.cyan("cards")}                            Lista tarjetas (id, label, ••••last4, estado).`,
    `  ${c.cyan("grant")}   --card <id> --merchant <Jumbo> --max <pesos> [--ttl 1h]`,
    `                                   Crea un permiso (comercio, tope, vigencia).`,
    `  ${c.cyan("buy")}     --card <id> --merchant <Jumbo> --amount <pesos> [--max <pesos>] [--ttl 1h]`,
    `                                   Compra. Con --max crea el permiso y luego compra.`,
    `  ${c.cyan("permissions")} [--card <id>]         Lista permisos con estado y vigencia.`,
    `  ${c.cyan("mcp")}                              Servidor MCP por stdio (Claude Code, Claude Desktop, Cursor).`,
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
    "  claude mcp add cardia -- npx cardia mcp   " + c.gray("# conectá tu agente por MCP"),
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Beta: sin credenciales (no hay registro público todavía) → mensaje + waitlist.
// ---------------------------------------------------------------------------
function printBeta(): void {
  console.log("");
  console.log("  " + c.bold(c.cyan("◆ Cardia")) + c.gray(" — la tarjeta para tus agentes de IA"));
  console.log("");
  console.log("  🔒 Estamos en " + c.bold("beta privada") + ". Todavía no abrimos el registro público.");
  console.log("");
  console.log("  Sumate a la lista de espera y te avisamos apenas abramos:");
  console.log("     " + c.bold(c.cyan("https://cardia.digital")));
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const KNOWN_COMMANDS = ["teams", "cards", "grant", "buy", "permissions", "mcp"];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`${pkg.name} ${pkg.version}`);
    return;
  }

  // Validar el comando ANTES del gate de beta: un comando desconocido es SIEMPRE
  // error de uso (exit 2), tenga o no credenciales configuradas.
  if (!KNOWN_COMMANDS.includes(command)) {
    throw new UsageError(
      `Comando desconocido: "${command}". Probá: ${KNOWN_COMMANDS.join(", ")}. (cardia help)`
    );
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

  const hasEnv = Boolean(
    process.env.CARDIA_API_TOKEN && process.env.CARDIA_API_URL
  );

  // `cardia mcp`: stdout es EXCLUSIVO del protocolo JSON-RPC. Sin credenciales,
  // el error va a stderr y salimos con 1 (jamás el banner beta por stdout,
  // rompería el handshake con Claude/Cursor).
  if (command === "mcp") {
    if (!hasEnv) {
      process.stderr.write(
        "cardia mcp: faltan variables de entorno CARDIA_API_URL y/o CARDIA_API_TOKEN.\n" +
          "Configuralas en el bloque \"env\" del cliente MCP (Claude Code / Claude Desktop / Cursor)\n" +
          "o exportalas en el shell. Beta privada: pedí acceso en https://cardia.digital\n"
      );
      process.exit(1);
    }
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return;
  }

  // Sin credenciales configuradas → beta privada (no hay registro público todavía).
  if (!hasEnv) {
    printBeta();
    return;
  }

  const api = CardiaApi.fromEnv();

  switch (command) {
    case "teams":
      await cmdTeams(api);
      break;
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
