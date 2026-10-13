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
/** models 0.7: a per-target training parameter / a per-model run option (rendered generically) */
export interface OptDef {
  id: string;
  name: string;
  type: "int" | "float" | "number" | "bool" | "choice" | "multi" | "string" | "region" | "leads" | "range" | "day" | "states" | "bbox" | string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  choices?: (string | number | [string | number, string] | { id: string | number; name: string })[];
  help?: string;
  group?: string;
  /** run_params: target ids (or outputs "detections" | "grid" | "outlook") the option applies to; empty = all */
  applies_to?: string[];
}
export type Task = "classification" | "regression";
export type Output = "detections" | "grid" | "outlook";
export interface TargetDef {
  id: string;
  name: string;
  candidate: string;
  /** models 0.7 */
  task?: Task;
  output?: Output;
  /** forecast lead hours the target supports (grid / outlook forecasts) */
  leads?: number[];
  /** e.g. outlook hazards, precip accumulation windows */
  subtargets?: (string | { id: string; name: string; help?: string })[];
  params?: OptDef[];
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
  /** models 0.7: options for POST /api/ml/run per model */
  run_params?: OptDef[];
  /** models 0.7: every data source group the server can train on */
  sources?: Partial<Record<"radar_products" | "mrms" | "satellite" | "model_vars" | "metar" | "other", (string | { id: string; name: string; unit?: string; group?: string; help?: string })[] | boolean>> & Record<string, any>;
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
  sources: { radar_products: string[]; mrms: string[]; metar: boolean; model: string[]; satellite?: string[]; other?: string[] };
  /** models 0.7: values of the target's own params (catalog targets[].params) */
  target_params?: Record<string, any>;
  subtarget?: string;
  task?: Task;
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
  /** models 0.7: regression */
  mae?: number;
  rmse?: number;
  bias?: number;
  r2?: number;
  skill?: number;
}
export interface HistoryEntry {
  version: number;
  at?: number;
  kind: "train" | "retrain" | "continue" | string;
  metrics_summary?: Record<string, number>;
  samples?: number;
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
  /** models 0.7 */
  task?: Task;
  output?: Output;
  version?: number;
  history?: HistoryEntry[];
  imported?: boolean;
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
  /** models 0.7 */
  models_state?: Record<string, { state?: string; last_run?: number; next_run?: number; error?: string; detections?: number; valid_times?: number[]; [k: string]: any }>;
  layers?: PredLayer[];
  concurrency?: number;
  /** per-model options as the runner has them */
  model_opts?: Record<string, ModelRunOpts>;
}
export interface PredLayer {
  model_id: string;
  layer_id: string;
  kind: "grid" | "outlook" | string;
  valid_times: number[];
  name?: string;
  field?: string;
}
/** per-model run options (POST /api/ml/run models[]) */
export interface ModelRunOpts {
  threshold?: number;
  min_prob?: number;
  max_prob?: number;
  persistence?: number;
  min_cell_dbz?: number;
  min_area_km2?: number;
  max_range_km?: number;
  region?: { bbox?: [number, number, number, number]; states?: string[] };
  leads?: number[];
  valid_from?: number;
  valid_to?: number;
  day?: 1 | 2 | 3 | "4-7";
  grid_res_deg?: number;
  smoothing_km?: number;
  ensemble?: boolean | string | number;
  cadence_min?: number;
  max_detections?: number;
  notify?: boolean;
  [k: string]: any;
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
  /** models 0.7: "area" = a grid model's polygon (flood / tropical / instability areas) */
  kind?: "cell" | "area";
  valid_from?: number;
  valid_to?: number;
}
