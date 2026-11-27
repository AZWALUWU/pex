interface D1Database {
  prepare(query: string): D1PreparedStatement
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: { changes: number } }>
  run(): Promise<{ success: boolean; meta: { changes: number } }>
}
type PagesFunction<E = unknown> = (context: { request: Request; env: E; next: () => Promise<Response>; waitUntil: (promise: Promise<unknown>) => void; passThroughOnException: () => void; params: Record<string, string> }) => Response | Promise<Response>
