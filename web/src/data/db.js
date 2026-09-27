const API_BASE = "/api";

async function request(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- Categories ---

export function getCategories() {
  return request("/categories");
}

export async function addCategory(name) {
  const { id } = await request("/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return id;
}

export function updateCategoryName(categoryId, name) {
  return request(`/categories/${categoryId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteCategory(categoryId) {
  return request(`/categories/${categoryId}`, { method: "DELETE" });
}

// --- Feeds ---

export function getFeeds() {
  return request("/feeds");
}

export async function addFeed(url, categoryId, title) {
  const { id } = await request("/feeds", {
    method: "POST",
    body: JSON.stringify({ url, categoryId, title }),
  });
  return id;
}

export function renameFeed(feedId, title) {
  return request(`/feeds/${feedId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function updateFeedCategory(feedId, categoryId) {
  return request(`/feeds/${feedId}/category`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId }),
  });
}

export function deleteFeed(feedId) {
  return request(`/feeds/${feedId}`, { method: "DELETE" });
}

// Sends the outline tree parsed from an OPML file (see opml.js's parseOPML); resolves to
// { feedsAdded, categoriesCreated, duplicates, invalid }.
export function importOpml(outlines) {
  return request("/import", {
    method: "POST",
    body: JSON.stringify({ outlines }),
  });
}

// --- Articles ---

export function getArticles() {
  return request("/articles");
}

export function markRead(id, read = true) {
  return request(`/articles/${encodeURIComponent(id)}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read }),
  });
}

export async function toggleSaved(id) {
  const { saved } = await request(`/articles/${encodeURIComponent(id)}/saved`, {
    method: "PATCH",
  });
  return saved;
}
