export interface Breed {
  id: string;
  name: string;
  description: string;
  temperament: string;
  origin: string;
  life_span: string;
  alt_names?: string;
  weight?: { imperial: string; metric: string };
  adaptability: number;
  affection_level: number;
  child_friendly: number;
  dog_friendly: number;
  energy_level: number;
  grooming: number;
  health_issues: number;
  intelligence: number;
  shedding_level: number;
  social_needs: number;
  stranger_friendly: number;
  vocalisation: number;
  wikipedia_url?: string;
  cfa_url?: string;
  vetstreet_url?: string;
  vcahospitals_url?: string;
  /** Runtime-populated validated image (Unsplash fallback) */
  image?: { url: string; id?: string; width?: number; height?: number };
  onSelectBreed?: (breed: Breed, imageUrl: string) => void;
}

export interface CatImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export interface BreedImage extends CatImage {
  breeds: Breed[];
}
