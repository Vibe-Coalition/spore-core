const API_BASE = "https://api.thecatapi.com/v1";
const API_KEY = process.env.NEXT_PUBLIC_CAT_API_KEY || "";

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (API_KEY) headers["x-api-key"] = API_KEY;

// Unsplash cat images - free for commercial use, no attribution required
const UNSPLASH_CAT_IMAGES = [
  "https://images.unsplash.com/photo-1592194996308-7b43878e84a6",
  "https://images.unsplash.com/photo-1561948955-570b270e7c36",
  "https://images.unsplash.com/photo-1503777119540-ce54b422baff",
  "https://images.unsplash.com/photo-1533738363-b7f9aef128ce",
  "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba",
  "https://images.unsplash.com/photo-1501820488136-72669149e0d4",
  "https://images.unsplash.com/photo-1495360019602-e05980bf549a",
  "https://images.unsplash.com/photo-1570018145352-2eba834d6c38",
  "https://images.unsplash.com/photo-1605450648855-63f9161b7ef7",
  "https://images.unsplash.com/photo-1519052537078-e6302a4968ef",
  "https://images.unsplash.com/photo-1615266895738-11f1371cd7e5",
  "https://images.unsplash.com/photo-1596854407944-bf87f6fdd49e",
  "https://images.unsplash.com/photo-1611273426761-53c8577a20fa",
  "https://images.unsplash.com/photo-1569587112025-0d460e81a126",
  "https://images.unsplash.com/photo-1543852786-1cf6624b9987",
];

function getUnsplashImageUrl(baseUrl: string, width: number = 600, height: number = 500): string {
  return `${baseUrl}?w=${width}&h=${height}&fit=crop&q=80&auto=format`;
}

export async function fetchBreeds() {
  const res = await fetch(`${API_BASE}/breeds`, { headers });
  if (!res.ok) throw new Error("Failed to fetch breeds");
  return res.json();
}

export async function fetchBreedImages(breedId: string, limit: number = 4) {
  const res = await fetch(
    `${API_BASE}/images/search?breed_ids=${breedId}&limit=${limit}`,
    { headers }
  );
  if (!res.ok) throw new Error("Failed to fetch images");
  return res.json();
}

export async function fetchBreedImage(breedId: string) {
  const res = await fetch(
    `${API_BASE}/images/search?breed_ids=${breedId}&limit=1`,
    { headers }
  );
  if (!res.ok) throw new Error("Failed to fetch image");
  const data = await res.json();
  return data[0] || null;
}

/** Check if an image URL actually loads successfully in the browser */
export function checkImageUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => resolve(false), 8000);
    img.onload = () => {
      clearTimeout(timeout);
      resolve(img.naturalWidth > 0);
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    img.src = url;
  });
}

/**
 * Get a working image URL for a breed.
 * Uses Unsplash cat images as the image source (fallback to Cat API if needed).
 */
export async function getValidatedBreedImage(
  breedId: string,
  preferredUrl?: string
): Promise<{ url: string; width?: number; height?: number } | null> {
  // Deterministically pick an Unsplash image based on breed id
  let hash = 0;
  for (let i = 0; i < breedId.length; i++) {
    hash = ((hash << 5) - hash + breedId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % UNSPLASH_CAT_IMAGES.length;
  const baseUrl = UNSPLASH_CAT_IMAGES[idx];

  // Try preferred URL first if provided
  if (preferredUrl) {
    const ok = await checkImageUrl(preferredUrl);
    if (ok) return { url: preferredUrl };
  }

  // Return Unsplash URL with sizing params
  return {
    url: getUnsplashImageUrl(baseUrl, 600, 500),
    width: 600,
    height: 500,
  };
}
