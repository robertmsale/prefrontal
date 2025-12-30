export type QdrantDistance = "Cosine" | "Euclid" | "Dot" | "Manhattan";

export type QdrantFilter = {
  must?: unknown[];
  must_not?: unknown[];
  should?: unknown[];
};

export type QdrantPoint = {
  id: string | number;
  vector: number[] | Record<string, unknown>;
  payload?: Record<string, unknown>;
};

type QdrantError = { status?: unknown; message?: unknown } | string;

export class QdrantRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
  ) {}

  private headers(): HeadersInit {
    return {
      "content-type": "application/json",
      accept: "application/json",
      ...(this.apiKey ? { "api-key": this.apiKey } : {}),
    };
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const txt = await res.text().catch(() => "");
    if (!res.ok) {
      let err: QdrantError = txt;
      try {
        err = JSON.parse(txt) as any;
      } catch {
        // ignore
      }
      throw new Error(
        `Qdrant error ${res.status} ${res.statusText}: ${
          typeof err === "string" ? err : JSON.stringify(err)
        }`,
      );
    }
    return (txt ? (JSON.parse(txt) as T) : (undefined as T));
  }

  async getCollections(): Promise<string[]> {
    const out = await this.requestJson<any>("/collections");
    const cols: Array<{ name?: string }> = out?.result?.collections ??
      out?.collections ?? [];
    return cols.map((c) => c.name).filter((n): n is string =>
      typeof n === "string" && n.length > 0
    );
  }

  async createCollection(
    name: string,
    vectors: { size: number; distance: QdrantDistance },
  ): Promise<void> {
    await this.requestJson(`/collections/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ vectors }),
    });
  }

  async createCollectionIfMissing(
    name: string,
    vectors: { size: number; distance: QdrantDistance },
  ): Promise<void> {
    const cols = await this.getCollections();
    if (cols.includes(name)) return;
    await this.createCollection(name, vectors);
  }

  async createPayloadIndex(
    collection: string,
    fieldName: string,
    fieldSchema:
      | "keyword"
      | "integer"
      | "float"
      | "datetime"
      | "uuid"
      | "text"
      | "geo",
    wait = true,
  ): Promise<void> {
    await this.requestJson(
      `/collections/${encodeURIComponent(collection)}/index`,
      {
        method: "PUT",
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldSchema,
          wait,
        }),
      },
    );
  }

  async upsert(
    collection: string,
    points: QdrantPoint[],
    wait = true,
  ): Promise<void> {
    await this.requestJson(
      `/collections/${encodeURIComponent(collection)}/points?wait=${
        wait ? "true" : "false"
      }`,
      {
        method: "PUT",
        body: JSON.stringify({ points }),
      },
    );
  }

  async retrieve(
    collection: string,
    ids: Array<string | number>,
    withPayload = true,
    withVectors = false,
  ): Promise<any[]> {
    const out = await this.requestJson<any>(
      `/collections/${encodeURIComponent(collection)}/points`,
      {
        method: "POST",
        body: JSON.stringify({
          ids,
          with_payload: withPayload,
          with_vectors: withVectors,
        }),
      },
    );
    return out?.result ?? out?.points ?? [];
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: QdrantFilter,
    withPayload = true,
  ): Promise<any[]> {
    const out = await this.requestJson<any>(
      `/collections/${encodeURIComponent(collection)}/points/query`,
      {
        method: "POST",
        body: JSON.stringify({
          query: vector,
          limit,
          filter,
          with_payload: withPayload,
        }),
      },
    );
    const result = out?.result;
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.points)) return result.points;
    if (Array.isArray(out?.points)) return out.points;
    return [];
  }

  async setPayload(
    collection: string,
    payload: Record<string, unknown>,
    filter: QdrantFilter,
    wait = true,
  ): Promise<void> {
    await this.requestJson(
      `/collections/${encodeURIComponent(collection)}/points/payload`,
      {
        method: "POST",
        body: JSON.stringify({ payload, filter, wait }),
      },
    );
  }

  async scroll(
    collection: string,
    opts: {
      limit: number;
      offset?: unknown;
      filter?: QdrantFilter;
      order_by?: string | {
        key: string;
        direction?: "asc" | "desc";
        start_from?: number | string;
      };
      with_payload?: boolean;
      with_vectors?: boolean;
    },
  ): Promise<any[]> {
    const out = await this.requestJson<any>(
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
    return out?.result?.points ?? out?.points ?? [];
  }

  async scrollPage(
    collection: string,
    opts: {
      limit: number;
      offset?: unknown;
      filter?: QdrantFilter;
      with_payload?: boolean;
      with_vectors?: boolean;
    },
  ): Promise<{ points: any[]; next_offset: unknown | null }> {
    const out = await this.requestJson<any>(
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
    const points = out?.result?.points ?? out?.points ?? [];
    const next = out?.result?.next_page_offset ?? out?.next_page_offset ?? null;
    return { points, next_offset: next ?? null };
  }

  async count(
    collection: string,
    opts?: { filter?: QdrantFilter; exact?: boolean },
  ): Promise<number> {
    const out = await this.requestJson<any>(
      `/collections/${encodeURIComponent(collection)}/points/count`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: opts?.filter,
          exact: opts?.exact ?? true,
        }),
      },
    );
    const n = out?.result?.count ?? out?.count ?? 0;
    return typeof n === "number" ? n : 0;
  }
}
