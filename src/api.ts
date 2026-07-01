/**
 * Cliente HTTP para la API admin de Cardia.
 *
 * Configuración por env:
 *   CARDIA_API_URL    -> base URL (ej. https://cardia-api.emipanelli.com)
 *   CARDIA_API_TOKEN  -> se envía como header `x-admin-token`
 */

export type Currency = "ARS" | "USD";

export interface Card {
  id: string;
  label: string;
  last4: string;
  limit: number;
  spent: number;
  status: string;
  accountId: string;
  currency?: Currency;
}

/** Cliente/empresa titular (capa de organización sobre las cuentas). */
export interface Customer {
  id: string;
  name: string;
  email?: string;
  document?: string;
  phone?: string;
  createdAt?: string;
}

export interface Permission {
  id: string;
  cardId: string;
  merchant: string;
  maxAmountCents: number;
  ttlSeconds?: number;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface AuthorizationResult {
  status: "APPROVED" | "REJECTED";
  approved?: boolean;
  reason?: string;
  detail?: string;
  permissionId?: string;
  cardId?: string;
}

/** Cuenta (miembro del equipo) con sus saldos multi-moneda en centavos. */
export interface AccountSummary {
  id: string;
  userId?: string;
  currency?: Currency;
  balanceCents?: number; // legacy: espejo de balances.ARS
  balances?: { ARS: number; USD: number }; // centavos por moneda
  status?: string;
  createdAt?: string;
  cardCount?: number;
  customerId?: string | null;
  customerName?: string | null;
}

/** Autorización (transacción) registrada. `amount` en centavos. */
export interface AuthorizationSummary {
  id: string;
  cardId: string;
  amount: number;
  merchant: string;
  status: "APPROVED" | "REJECTED";
  reason?: string;
  detail?: string;
  at: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

/** Error de configuración (env vars faltantes). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Error proveniente de la API o de la red. */
export class ApiError extends Error {
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiConfig {
  baseUrl: string;
  token: string;
}

/**
 * Lee y valida la configuración desde las variables de entorno.
 * Lanza ConfigError con un mensaje útil si falta algo.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const baseUrl = (env.CARDIA_API_URL || "").trim();
  const token = (env.CARDIA_API_TOKEN || "").trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("CARDIA_API_URL");
  if (!token) missing.push("CARDIA_API_TOKEN");

  if (missing.length > 0) {
    throw new ConfigError(
      `Faltan variables de entorno: ${missing.join(", ")}.\n` +
        `Configurá:\n` +
        `  export CARDIA_API_URL="https://cardia-api.emipanelli.com"\n` +
        `  export CARDIA_API_TOKEN="tu-admin-token"`
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export class CardiaApi {
  private baseUrl: string;
  private token: string;

  constructor(config: ApiConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): CardiaApi {
    return new CardiaApi(loadConfig(env));
  }

  /** Timeout de cada request HTTP (fetch no tiene timeout por defecto). */
  private static readonly REQUEST_TIMEOUT_MS = 15_000;

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    // Timeout defensivo: aborta la request si la API no responde en 15s.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      CardiaApi.REQUEST_TIMEOUT_MS
    );

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-admin-token": this.token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ApiError(
          `La API en ${this.baseUrl} no respondió dentro de los ${
            CardiaApi.REQUEST_TIMEOUT_MS / 1000
          }s (timeout en ${method} ${path}). ` +
            `Verificá que el servicio esté arriba y que CARDIA_API_URL sea correcto.`
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        `No se pudo conectar con la API en ${this.baseUrl} (${detail}). ` +
          `Verificá que CARDIA_API_URL sea correcto y que el servicio esté arriba.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let reason = text;
      try {
        const parsed = JSON.parse(text);
        reason = parsed.error || parsed.message || text;
      } catch {
        /* dejar el texto crudo */
      }
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(
          `Autenticación rechazada (HTTP ${res.status}). Revisá CARDIA_API_TOKEN.`,
          res.status,
          text
        );
      }
      throw new ApiError(
        `La API respondió ${res.status} en ${method} ${path}: ${reason}`,
        res.status,
        text
      );
    }

    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        `Respuesta inválida de la API (no es JSON) en ${method} ${path}.`,
        res.status,
        text
      );
    }
  }

  /** GET /admin/cards */
  async listCards(): Promise<Card[]> {
    const data = await this.request<{ cards: Card[] }>("GET", "/admin/cards");
    return data.cards ?? [];
  }

  /** POST /admin/permissions */
  async createPermission(input: {
    cardId: string;
    merchant: string;
    maxAmountCents: number;
    ttlSeconds: number;
  }): Promise<Permission> {
    const data = await this.request<{ permission: Permission }>(
      "POST",
      "/admin/permissions",
      input
    );
    return data.permission;
  }

  /** GET /admin/permissions — con filtro opcional por tarjeta (server-side). */
  async listPermissions(cardId?: string): Promise<Permission[]> {
    const data = await this.request<{ permissions: Permission[] }>(
      "GET",
      "/admin/permissions",
      undefined,
      { cardId }
    );
    return data.permissions ?? [];
  }

  /** POST /admin/authorizations/simulate */
  async simulateAuthorization(input: {
    cardId: string;
    amountCents: number;
    merchant: string;
    idempotencyKey: string;
  }): Promise<AuthorizationResult> {
    return this.request<AuthorizationResult>(
      "POST",
      "/admin/authorizations/simulate",
      input
    );
  }

  /** POST /admin/customers — crea una empresa/cliente. */
  async createCustomer(input: {
    name: string;
    email?: string;
    document?: string;
    phone?: string;
  }): Promise<Customer> {
    const data = await this.request<{ customer: Customer }>(
      "POST",
      "/admin/customers",
      input
    );
    // Fallback defensivo: si la API devuelve el customer "plano" (sin envolver), lo usamos igual.
    return data.customer ?? (data as unknown as Customer);
  }

  /**
   * POST /admin/cards SIN accountId — crea una cuenta nueva + sus tarjetas (ARS + USD)
   * para un miembro (persona/agente). Devuelve la cuenta y las tarjetas emitidas.
   */
  async createMember(input: {
    label: string;
    customerId?: string;
    limit: number;
    mode?: "free" | "scoped";
    currency?: Currency;
  }): Promise<{ accountId: string; cards: Card[] }> {
    const data = await this.request<{ accountId: string; cards: Card[] }>(
      "POST",
      "/admin/cards",
      input
    );
    // Fallback defensivo: nunca devolver cards undefined (evita crash en el wizard).
    return { accountId: data.accountId, cards: data.cards ?? [] };
  }

  /** GET /admin/accounts — cuentas con balances por moneda (centavos). */
  async listAccounts(): Promise<AccountSummary[]> {
    const data = await this.request<{ accounts: AccountSummary[] }>(
      "GET",
      "/admin/accounts"
    );
    return data.accounts ?? [];
  }

  /** GET /admin/accounts/:id — detalle de una cuenta (saldos, tarjetas, movimientos). */
  async getAccount(accountId: string): Promise<{
    account: AccountSummary;
    cards: Card[];
    movements: AuthorizationSummary[];
  }> {
    const data = await this.request<{
      account: AccountSummary;
      cards: Card[];
      movements: AuthorizationSummary[];
    }>("GET", `/admin/accounts/${encodeURIComponent(accountId)}`);
    return {
      account: data.account ?? (data as unknown as AccountSummary),
      cards: data.cards ?? [],
      movements: data.movements ?? [],
    };
  }

  /** PATCH /admin/cards/:id/limit — cambia el límite (en centavos). */
  async setCardLimit(cardId: string, limitCents: number): Promise<Card> {
    const data = await this.request<{ card: Card }>(
      "PATCH",
      `/admin/cards/${encodeURIComponent(cardId)}/limit`,
      { limit: limitCents }
    );
    return data.card ?? (data as unknown as Card);
  }

  /** POST /admin/cards/:id/block — congela la tarjeta. */
  async blockCard(cardId: string): Promise<Card> {
    const data = await this.request<{ card: Card }>(
      "POST",
      `/admin/cards/${encodeURIComponent(cardId)}/block`
    );
    return data.card ?? (data as unknown as Card);
  }

  /** POST /admin/cards/:id/activate — reactiva la tarjeta. */
  async activateCard(cardId: string): Promise<Card> {
    const data = await this.request<{ card: Card }>(
      "POST",
      `/admin/cards/${encodeURIComponent(cardId)}/activate`
    );
    return data.card ?? (data as unknown as Card);
  }

  /** GET /admin/authorizations — transacciones paginadas, filtro opcional por tarjeta/estado. */
  async listAuthorizations(opts?: {
    cardId?: string;
    approved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ authorizations: AuthorizationSummary[]; pagination?: Pagination }> {
    const data = await this.request<{
      authorizations: AuthorizationSummary[];
      pagination?: Pagination;
    }>("GET", "/admin/authorizations", undefined, {
      cardId: opts?.cardId,
      approved: opts?.approved,
      page: opts?.page,
      limit: opts?.limit,
    });
    return {
      authorizations: data.authorizations ?? [],
      pagination: data.pagination,
    };
  }
}
