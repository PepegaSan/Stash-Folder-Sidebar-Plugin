/** Tiny GraphQL client for Stash. Same origin, so the UI session cookie authenticates us. */

function baseUrl(): URL {
  const href = document.querySelector("base")?.getAttribute("href") ?? "/";
  return new URL(href, window.location.origin);
}

/** Resolves a Stash-relative path (e.g. "/plugin/x/assets/a.mp3") against the Stash base URL. */
export function stashUrl(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return new URL(path.replace(/^\//, ""), baseUrl()).toString();
}

export class GraphQLError extends Error {}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(stashUrl("graphql"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GraphQLError(`GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new GraphQLError(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}
