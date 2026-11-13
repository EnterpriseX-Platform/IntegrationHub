/**
 * Convert string to URL-friendly slug
 * "DGA" → "dga"
 * "My Project" → "my-project"
 * "Data-Hub" → "data-hub"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')     // Remove special characters
    .replace(/\s+/g, '-')          // Replace spaces with -
    .replace(/-+/g, '-');          // Replace multiple - with single -
}
