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
  reason?: string;
  permissionId?: string;
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-admin-token": this.token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        `No se pudo conectar con la API en ${this.baseUrl} (${detail}). ` +
          `Verificá que CARDIA_API_URL sea correcto y que el servicio esté arriba.`
      );
    }

    const text = await res.text();

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

  /** GET /admin/permissions */
  async listPermissions(): Promise<Permission[]> {
    const data = await this.request<{ permissions: Permission[] }>(
      "GET",
      "/admin/permissions"
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
    return data.customer;
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
    return this.request<{ accountId: string; cards: Card[] }>(
      "POST",
      "/admin/cards",
      input
    );
  }
}
