export const PRISM_STUDIO_REF: string;
export function readDevUserEnv(env?: Record<string, string | undefined>): {
  url: string;
  id: string;
  email: string | null;
};
export function assertDevUserExists(
  queryable: {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<{ id: string; email: string | null }> }>;
  },
  user: { id: string; email: string | null },
): Promise<{ id: string; email: string | null }>;
