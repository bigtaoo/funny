// Test-only JSON body reader.
//
// `Response.json()` is typed `Promise<unknown>` by @types/node (undici), which is correct — a
// response body genuinely is unknown until something validates it. HTTP e2e tests here assert on
// concrete fields immediately (`expect(body.data.name).toBe(...)`), so without this every one of
// them is a "possibly unknown" type error. Keeping the cast in one place beats an `as any` per
// assertion, and the type parameter lets a test that cares state the shape it expects:
//
//   const body = await jsonBody<{ ok: boolean; data: { id: string } }>(res);
//
// Prefer that form for new tests — it turns an API-shape change into a compile error instead of a
// runtime `undefined`.
export async function jsonBody<T = any>(res: { json(): Promise<unknown> }): Promise<T> {
  return (await res.json()) as T;
}
