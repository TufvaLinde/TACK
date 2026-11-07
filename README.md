# TACK — adaptive AI sailing tactician

**Prototype. Not certified navigation software. The captain always decides.**

TACK combines a vessel polar, live Open-Meteo weather and marine forecasts, the logbook and the captain's
instructions to generate candidate routes. SubQ Snap chooses between them. TACK also improves its own routing
strategy code: it finds recurring prediction errors, proposes a code change, versions it, tests it on held-out
data, and promotes or rejects it.

## Run

```bash
npm install
cp .env.example .env      # add META_API_KEY and SUBQ_API_KEY
npm run dev               # server :8787 + client :5173 → http://localhost:5173
npm test
```

| Variable | Purpose |
|---|---|
| `META_API_KEY` | Meta Model API (`https://api.meta.ai/v1`, OpenAI-compatible chat completions; default model `muse-spark-1.3`) |
| `SUBQ_API_KEY` | SubQ Decisions API (`POST https://api.subq.ai/v1/systemone`, model `subq-snap-1.1`) |
| `MODEL_PROVIDER=local`, `LOCAL_MODEL_URL`, `LOCAL_MODEL` | on-board Llama via any OpenAI-compatible server (llama.cpp, Ollama, vLLM) |
| `MONGODB_URI`, `MONGODB_DB` | optional MongoDB Atlas intelligence store (shared fleet episodes) |
| `IMPROVE_INTERVAL_HOURS` | periodic improvement cycle (default 24) |

Note: Meta's hosted API now serves Muse models; the Llama models are open-weight. The model-provider abstraction
lets a locally hosted Llama replace the hosted API.

## Architecture

```
client/  React + Leaflet chart UI (Chart view, Strategy Lab)
server/
  model/        ModelProvider: Meta Model API | local OpenAI-compatible Llama (+ offline fallbacks)
  weather/      WeatherProvider: Open-Meteo forecast + marine, gridded, cached on disk with retrieval time
  vessel/       polar (CSV/JSON, bilinear), learned correction (quality-weighted, shrunk toward baseline)
  routing/      isochrone + waypoint candidates, hour-by-hour simulation, hard constraints, land mask
  logbook/      NL extraction (model / offline rules), pipe-delimited + JSON importers
  preferences/  captain instructions → hard constraints + soft weights (+ expiring temporary objectives)
  decision/     SubQ Snap request/response, low-confidence → ask captain, labelled local fallback
  strategies/   versioned routing-strategy modules (sandboxed JS) + registry
  intelligence/ voyage recorder, IntelligenceStore (local JSON | MongoDB Atlas), similar-experience retrieval
  benchmark/    dataset (real log legs + labelled synthetic), held-out evaluator with promotion gates
  improvement/  improvement agent (dev split only) + cycle orchestration
data/  vessel.json, polars/, geo/ (Natural Earth 1:50m coastline), strategies/, store/ (local DB), cache/
```

All state lives on board (`data/store`, `data/cache`). When offline, TACK still logs (rule-based parser),
answers logbook queries (keyword search), routes on the cached forecast (marked stale), and ranks routes with a
labelled local score. A sync queue re-reads offline entries with the model and re-asks SubQ when the link
returns. "Simulate offline" is in the top bar.

## Self-improvement ("The System That Gets Better")

FAILURE → HYPOTHESIS → CODE MODIFICATION → VERSIONING → HELD-OUT EVALUATION → PROMOTION / ROLLBACK

* **Strategy modules** (`data/strategies/<version>.js`) define `speedFactor` (sea-state performance),
  `uncertaintyFactor` (forecast uncertainty), `adjustWeights` (objective weighting), `scoreRoute`, and
  `context` (how the SubQ context is assembled). The router, the decision engine and the benchmark all call the
  same module, so a change applies everywhere. Each version is registered with its parent, author, hash, status
  and evaluation. Rollback is one click.
* **Safety stays outside the LLM's authority.** Wind and wave limits, deadlines, restricted areas and land are
  enforced by the router. Module outputs are clamped. Modules run in a `vm` sandbox with no I/O, loops,
  require, process or eval, and must pass behavioural tests.
* **Voyage recorder:** every decision is stored as an episode, with forecast, prediction, observations,
  outcome and captain feedback in separate fields. The "watch change" feedback buttons are on the
  recommendation card.
* **Benchmark data:**
  * *Real:* legs between consecutive sailing entries (no engine) of the imported 2026 Atlantic log, using
    observed speed made good, paired with Open-Meteo's archived forecast and marine data. Split by day.
  * *Synthetic:* generated scenarios from a hidden vessel model, clearly labelled. They demonstrate the
    mechanism and are never used as decision context.
* **Agent** (`improvement/agent.ts`): deterministic failure analysis on the **dev split only** → Muse Spark
  writes a hypothesis and new module source → validation → dev check (up to 3 attempts) → candidate version.
* **Evaluator** (`benchmark/evaluator.ts`): independent, **held-out only**. Gates: speed MAE ≥ 2 % better, ETA
  MAE not worse than +1 %, no sea-state bucket worse than +10 %, real-log legs not worse than +5 %, no new
  hard-constraint violations in simulated counterfactual passages (production and candidate re-route the same
  stored forecast). Fuel, comfort and preference metrics are reported only where data exists.

### Demo script

1. **Chart:** *Plan route* → five or six candidates; SubQ picks one. Try the A / B / C chips in the assistant.
2. **Strategy Lab:** *Reset to baseline* (if needed) → *Run improvement cycle*. The baseline over-predicts
   speed in big seas, so the agent rewrites `speedFactor`, and the held-out gates promote it.
3. Run again: the next cycle refines or converges ("no change").
4. *Evaluator self-test:* a deliberately flawed hand-written candidate is versioned, evaluated and rejected.

## Data honesty

* The polar is a **sample** (generic 45 ft cruiser). Load the real polar under *Performance → Load polar*.
* The Atlantic log has no time zone, no speed through water and no wind reference. These are flagged and
  reduce the weight of learned observations.
* The 5 real held-out legs were sailed in waves under 1.5 m, so the measured sea-state improvement comes from
  the synthetic set. More real heavy-weather legs are needed to confirm it on this boat.
* The MongoDB Atlas adapter has not been exercised (no cluster configured).
