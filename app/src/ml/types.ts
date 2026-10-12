// Detection models: shapes of the /api/ml/* API (server/src/ml). Everything is optional-ish on
// purpose: the client normalises whatever the server sends (see client.ts).

export type Ep = "main" | "local";

export interface FeatureDef {
  id: string;
  name: string;
  unit?: string;
  group?: string;
}
export interface ParamDef {
  id: string;
  name: string;
  type: "int" | "float" | "number" | "bool" | "choice" | "string" | string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: (string | [string, string] | { id: string; name: string })[];
  help?: string;
}
export interface FilterDef {
  id: string;
  name: string;
  type: "number" | "choice" | "multi" | "bool" | string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: [string, string][];
  help?: string;
}
export interface TargetDef {
  id: string;
  name: string;
  candidate: string;
  /** server: an array of label-source ids */
  default_labels_source?: string[] | string;
  description?: string;
  filters?: FilterDef[];
}
export interface CandidateDef {
  id: string;
  name: string;
  features: FeatureDef[];
}
export interface AlgoDef {
  id: string;
  name: string;
  params: ParamDef[];
  help?: string;
}
export interface LabelSource {
  id: string;
  name: string;
  targets: string[];
  years: [number, number];
  help?: string;
  url?: string;
}
export interface Preset {
  id: string;
  name: string;
  target: string;
  spec: Partial<TrainSpec>;
  description?: string;
  est_min?: number;
}
export interface Catalog {
  targets: TargetDef[];
  candidates: CandidateDef[];
  algos: AlgoDef[];
  label_sources: LabelSource[];
  presets: Preset[];
  radar_products?: (string | { id: string; name: string })[];
  mrms?: (string | { id: string; name: string })[];
  model_fields?: (string | { id: string; name: string })[];
  /** TrainSpec defaults (server) */
  defaults?: Partial<TrainSpec>;
  server?: { enabled?: boolean; max_jobs?: number; cpu_threads?: number; profile?: string; version?: string };
}

export interface TrainSpec {
  name: string;
  target: string;
  candidate: string;
  /** one or more label-source ids (the server also accepts a comma list) */
  label_source: string[];
  years: [number, number];
  region: { states?: string[]; bbox?: [number, number, number, number] };
  filters: Record<string, any>;
  max_events: number;
  neg_ratio: number;
  null_days: number;
  match: { radius_km: number; before_min: number; after_min: number };
  sources: { radar_products: string[]; mrms: string[]; metar: boolean; model: string[] };
  features?: string[];
  algo: string;
  params: Record<string, any>;
  cv_folds: number;
  time_limit_min?: number | null;
  /** server-only knobs (grid, cell, radars_per_event, …) carried through untouched */
  [k: string]: any;
}

export type JobState = "queued" | "running" | "stopping" | "done" | "failed" | "cancelled" | "interrupted";
export interface Job {
  id: string;
  ep: Ep;
  name?: string;
  target?: string;
  state: JobState;
  phase?: string;
  progress?: number;
  counts?: { events?: number; volumes_done?: number; volumes_total?: number; samples?: number; positives?: number };
  eta_s?: number | null;
  started?: number;
  elapsed_s?: number;
  log?: string[];
  model_id?: string;
  error?: string;
  /** latest training iteration (boosting round / epoch) */
  train?: { iteration?: number; train_loss?: number; val_loss?: number } | null;
  finished?: number;
  /** an interrupted / failed job can be restarted (POST …/resume → new job) */
  resumable?: boolean;
  time_limit_min?: number | null;
  spec?: Partial<TrainSpec>;
}

export interface Metrics {
  auc?: number;
  pr_auc?: number;
  pod?: number;
  far?: number;
  csi?: number;
  brier?: number;
  threshold?: number;
  best_csi_threshold?: number;
  reliability?: { p: number; obs: number; n: number }[];
  confusion?: { tp: number; fp: number; fn: number; tn: number };
  cv?: { fold: number; auc: number; csi: number }[];
  /** optional: precomputed threshold curve */
  curve?: { t: number; pod: number; far: number; csi: number; pofd?: number }[];
  samples?: number;
  positives?: number;
  eval_kind?: string;
}
export interface Model {
  id: string;
  ep: Ep;
  name: string;
  labels: string[];
  target: string;
  candidate?: string;
  created?: number;
  updated?: number;
  spec?: Partial<TrainSpec>;
  feature_schema?: FeatureDef[];
  algo?: string;
  params?: Record<string, any>;
  metrics?: Metrics;
  /** gain = share of the total (0–1) */
  importance?: { id: string; name?: string; gain: number }[];
  threshold?: number;
  levels?: { low: number; med: number; high: number };
  notes?: string;
  size?: number;
}

export interface RunState {
  enabled: boolean;
  models: string[];
  radars: any;
  /** the radar selection resolved to site ids */
  sites?: string[];
  interval_s?: number;
  last_cycle?: number;
  per_radar: Record<string, { t?: number | null; cells?: number; ms?: number; error?: string; detections?: number; key?: string; checked?: number }>;
}

export interface Detection {
  key: string;
  ep: Ep;
  model_id: string;
  model_name: string;
  target: string;
  prob: number;
  level: "low" | "med" | "high";
  site: string;
  t: number;
  cell_id?: string;
  top_features?: { id: string; value: number; contribution: number }[];
  motion?: { dir: number; kt: number };
  lon: number;
  lat: number;
  /** from "Test on radar" (shown on the map, never notifies) */
  test?: boolean;
  /** cell outline when the server sends a polygon */
  poly?: number[][][];
}
