// Shared, typed data structures used by both the server and the client.
// Every measured value carries provenance; every computed value is labelled as an estimate.

export interface LatLon {
  lat: number;
  lon: number;
}

/* ───────────────────────────── Vessel ───────────────────────────── */

export interface VesselConfig {
  name: string;
  type: string;
  lengthFt: number | null;
  notes: string;
  engine: {
    cruiseSpeedKn: number; // motoring speed in calm water
    fuelBurnLph: number | null; // null → fuel consumption cannot be estimated
    fuelCapacityL: number | null;
    fuelReserveL?: number | null; // never planned below this
  };
  operationalLimits: {
    maxTwsKn: number; // vessel/crew operational wind limit (hard)
    maxWaveM: number;
  };
  polarFile: string;
}

export interface PolarTable {
  name: string;
  source: string; // provenance: file name / "sample"
  isSample: boolean;
  tws: number[]; // knots, ascending
  twa: number[]; // degrees, ascending, 0..180
  speeds: number[][]; // [twaIndex][twsIndex] boat speed in knots
}

export type SailPlan = {
  main: "full" | "reefed" | "down" | "unknown";
  headsail: "full" | "reefed" | "down" | "unknown";
  engine: boolean | null; // null = not stated
  reefLevel: number | null;
  raw: string | null;
};

export interface CorrectionBin {
  twsRange: [number, number];
  twaRange: [number, number];
  samples: number;
  weight: number; // sum of observation weights
  meanRatio: number; // weighted mean observed/predicted
  factor: number; // shrunk toward 1.0 (prior) — what routing uses
  stdErr: number | null;
}

export interface PerformanceObservation {
  entryId: string;
  timestamp: string;
  twsKn: number;
  twaDeg: number;
  observedKn: number;
  speedType: "stw" | "sog";
  predictedKn: number;
  ratio: number;
  weight: number;
  sailKey: string;
  used: boolean;
  reasons: string[]; // why the weight was reduced / why excluded
}

export interface LearnedCorrection {
  updatedAt: string;
  priorStrength: number;
  bins: CorrectionBin[]; // full-sail correction (the one routing applies)
  byConfig: Record<string, { samples: number; meanRatio: number }>; // descriptive only
  observations: PerformanceObservation[];
  summary: {
    considered: number;
    used: number;
    excluded: number;
    exclusionReasons: Record<string, number>;
  };
}

/* ───────────────────────────── Logbook ───────────────────────────── */

export type LogEntryKind =
  | "observation" // captain report / instrument reading
  | "decision" // routing decision record
  | "preference" // captain objective change
  | "system"; // weather retrieval, sync, etc.

export interface Observations {
  position: LatLon | null;
  headingDeg: number | null;
  cogDeg: number | null;
  sogKn: number | null;
  stwKn: number | null;
  twsKn: number | null;
  twdDeg: number | null; // direction wind blows FROM
  windReference: "true" | "apparent" | "unspecified" | null;
  awaDeg?: number | null; // apparent wind angle, 0..180 off the bow (side in remarks)
  gustKn: number | null;
  pressureHpa: number | null;
  waveHeightM: number | null;
  seaState: "calm" | "slight" | "moderate" | "rough" | "very rough" | null;
  sailPlan: SailPlan | null;
  crewCondition: string | null;
  tripLogNm: number | null;
  fuelLitres?: number | null; // fuel on board, litres (observed)
  fuelBurnLph?: number | null; // engine-reported burn rate, L/h (observed)
  tanks: { diesel: string | null; water: string | null } | null; // raw gauge strings
  remarks: string | null;
}

export interface ExtractionInfo {
  method: string; // e.g. "muse-spark-1.3", "offline-rule-parser", "csv-import:atlantic.csv"
  confidence: number; // 0..1 overall
  missingFields: string[];
  notes: string[];
  pendingModelReview?: boolean; // parsed offline; will be re-interpreted when online
}

export interface LogEntry {
  id: string;
  voyageId: string;
  kind: LogEntryKind;
  timestamp: string; // ISO
  timestampProvenance: string;
  recordedAt: string; // when TACK TACK stored it
  source: string; // "captain:nl" | "captain:form" | "import:<file>" | "tack"
  rawText: string | null; // original, unmodified captain text
  observations: Observations | null;
  extraction: ExtractionInfo | null;
  interpretation?: NoteInterpretation | null; // model reading of free-text notes
  decision?: DecisionRecord | null;
  preference?: { text: string; change: ObjectiveChange } | null;
  message?: string | null; // for system entries
}

export interface NoteInterpretation {
  method: string;
  seaState: Observations["seaState"];
  crewMood: string | null;
  events: string[];
  confidence: number;
}

export interface Voyage {
  id: string;
  name: string;
  kind: "live" | "historical";
  start: LatLon & { label: string };
  destination: LatLon & { label: string };
  departureTime: string | null;
  notes: string;
}

/* ───────────────────────────── Weather ───────────────────────────── */

export interface WeatherGridMeta {
  id: string;
  fetchedAt: string;
  sources: { name: string; url: string; ok: boolean; error?: string }[];
  lats: number[];
  lons: number[];
  times: string[]; // ISO hours (UTC)
  bbox: { south: number; north: number; west: number; east: number };
  firstTime: string;
  lastTime: string;
  marineAvailable: boolean;
}

export interface WeatherStatus {
  available: boolean;
  meta: WeatherGridMeta | null;
  ageMinutes: number | null;
  stale: boolean; // older than threshold or a refresh failed
  lastError: string | null;
  fromCache: boolean;
}

export interface PointWeather {
  time: string;
  twsKn: number | null;
  twdDeg: number | null;
  gustKn: number | null;
  pressureHpa: number | null;
  waveHeightM: number | null;
  waveDirDeg: number | null;
  wavePeriodS: number | null;
  swellHeightM: number | null;
  currentKn: number | null;
  currentDirDeg: number | null; // direction current flows TOWARDS
  beyondForecast: boolean;
}

/* ───────────────────────────── Routing ───────────────────────────── */

export type SailingStrategy = "performance" | "comfort" | "sail-first";

export interface RouteTrackPoint {
  t: string;
  lat: number;
  lon: number;
  twsKn: number;
  twaDeg: number;
  bspKn: number;
  sogKn: number;
  waveM: number | null;
  motoring: boolean;
  reefed: boolean;
}

export interface RouteMetrics {
  etaIso: string | null;
  reachedDestination: boolean;
  durationHours: number;
  distanceNm: number;
  meanSogKn: number;
  meanBspKn: number;
  motoringHours: number;
  fuelLitres: number | null; // fuel burned on this route
  fuel?: { startL: number | null; burnLph: number | null; reserveL: number; remainingL: number | null; engineUnavailableHours: number; source: string };
  sailingHoursPct: number;
  goodSailingPct: number; // hours with 10–20 kn, reaching/running, waves < 2.5 m
  wind: { meanKn: number; maxKn: number; maxGustKn: number; hoursAbove20: number; hoursAbove25: number };
  waves: { meanM: number | null; maxM: number | null; hoursAbove2_5: number };
  upwindHours: number;
  comfortIndex: number; // 0 (miserable) .. 10 (very comfortable) — estimate
  next12h: { maxTwsKn: number; maxWaveM: number | null; comfortIndex: number; motoringHours: number };
  hoursBeyondForecast: number;
  currentGainNm: number; // net along-track distance gained (+) or lost (−) to current
  landCrossing: boolean;
}

export interface CandidateRoute {
  id: string;
  name: string;
  description: string;
  strategy: SailingStrategy;
  method: "isochrone" | "waypoint";
  waypoints: LatLon[];
  track: RouteTrackPoint[];
  metrics: RouteMetrics;
  hardConstraintViolations: string[];
  eligible: boolean;
}

export interface RoutingResult {
  id: string;
  computedAt: string;
  start: LatLon;
  destination: LatLon;
  departure: string;
  weatherFetchedAt: string | null;
  weatherStale: boolean;
  strategyVersion: string;
  correctionApplied: boolean;
  routes: CandidateRoute[];
  warnings: string[];
}

/* ───────────────────────────── Objectives ───────────────────────────── */

export type SoftKey = "speed" | "comfort" | "fuel" | "scenic" | "sailing" | "morale";
export type SoftWeights = Record<SoftKey, number>; // 0..1

export interface RestrictedArea {
  name: string;
  lat: number;
  lon: number;
  radiusNm: number;
}

export interface HardConstraints {
  arrivalDeadline: string | null;
  maxTwsKn: number | null;
  maxWaveM: number | null;
  restrictedAreas: RestrictedArea[];
  other: string[];
}

export interface TemporaryObjective {
  id: string;
  text: string;
  weights: Partial<SoftWeights>;
  createdAt: string;
  expiresAt: string;
}

export interface Objectives {
  hard: HardConstraints;
  base: SoftWeights;
  temporary: TemporaryObjective[];
  notes: string[];
  updatedAt: string;
}

export interface EffectiveObjectives {
  hard: HardConstraints;
  weights: SoftWeights;
  activeTemporary: TemporaryObjective[];
  notes: string[];
}

export interface ObjectiveChange {
  method: string;
  summary: string;
  hard: Partial<Omit<HardConstraints, "restrictedAreas" | "other">> & {
    addRestrictedAreas?: RestrictedArea[];
    addOther?: string[];
  };
  baseWeights: Partial<SoftWeights>;
  temporary: { weights: Partial<SoftWeights>; durationHours: number; text: string } | null;
  notes: string[];
  clarificationNeeded: string | null;
  confidence: number;
}

/* ───────────────────────────── Decision ───────────────────────────── */

export interface RouteAssessment {
  routeId: string;
  suitability: number | null; // 0..4 SubQ score
  comfort: number | null;
  arrivalTradeoff: number | null;
}

export interface DecisionRecord {
  id: string;
  createdAt: string;
  routingId: string;
  engine: string; // "subq-snap-1.1" | "local-weighted-score (SubQ unavailable)" | "none"
  selectedRouteId: string | null;
  confidence: number | null;
  probabilities: Record<string, number>;
  assessments: RouteAssessment[];
  needMoreInfo: number | null;
  safetyConcern: number | null;
  lowConfidence: boolean;
  askCaptain: string | null;
  objectivesSnapshot: EffectiveObjectives;
  weatherFetchedAt: string | null;
  weatherStale: boolean;
  tradeoffs: string[];
  excludedRoutes: { id: string; reasons: string[] }[];
  error: string | null;
  captainAction: { action: "accepted" | "overridden" | "pending"; routeId: string | null; at: string | null };
  strategyVersion?: string;
  episodeId?: string | null;
  similarEpisodesUsed?: number;
  requestSummary?: { questions: string[]; stateBytes: number };
}

/* ───────────────────────────── Status ───────────────────────────── */

export interface ServiceStatus {
  online: boolean;
  forcedOffline: boolean;
  checkedAt: string;
  model: { provider: string; model: string; configured: boolean; lastError: string | null };
  decision: { provider: string; model: string; configured: boolean; lastError: string | null };
  weather: WeatherStatus;
  pendingSync: number;
}
