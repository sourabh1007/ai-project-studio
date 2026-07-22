/** A feature: the top-level unit of AI-assisted work in the workspace. */
export interface Feature {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** AI-generated cross-session summary; null until generated. */
  summary: string | null;
}

export interface CreateFeatureInput {
  name: string;
  description: string;
}
