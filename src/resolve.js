import { copperFetch } from "./copper.js";

// Copper activities/related items reference their parent only by { type, id }. This resolves a
// parent to a human-readable name, using a per-request Map cache to avoid duplicate lookups.
// Reuse this whenever a resource returns bare parent references. Pass a fresh `new Map()` per call.
export async function resolveParentName(type, id, cache) {
  const key = `${type}:${id}`;
  if (cache.has(key)) return cache.get(key);

  const endpoints = {
    person: `/people/${id}`,
    company: `/companies/${id}`,
    lead: `/leads/${id}`,
    opportunity: `/opportunities/${id}`,
    project: `/projects/${id}`,
    task: `/tasks/${id}`,
  };

  const endpoint = endpoints[type];
  if (!endpoint) {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }

  try {
    const record = await copperFetch(endpoint);
    const name = record.name || record.first_name
      ? [record.first_name, record.last_name].filter(Boolean).join(" ") || record.name
      : `${type} #${id}`;
    cache.set(key, name);
    return name;
  } catch {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }
}
