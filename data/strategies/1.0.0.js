// TACK routing strategy module — version 1.0.0 (baseline, hand-written)
// Pure functions only: no I/O, no loops over external state. Called by the routing engine,
// the decision engine and the benchmark evaluator. Outputs are clamped by the engine.

const strategy = {
  // Vessel performance under sea state. Baseline: only penalises pounding when sailing
  // upwind (TWA < 70°) in waves above 2 m.
  speedFactor(c) {
    let f = 1;
    if (c.waveHeightM != null && c.waveHeightM > 2 && c.twaDeg < 70) {
      f *= Math.max(0.7, 1 - 0.07 * (c.waveHeightM - 2));
    }
    return f;
  },

  // Forecast uncertainty. Baseline: predictions are taken at face value.
  uncertaintyFactor(c) {
    return 1;
  },

  // Objective weighting. Baseline: the captain's weights are used unchanged.
  adjustWeights(w, ctx) {
    return w;
  },

  // Fallback route scoring (used only when SubQ is unreachable).
  scoreRoute(c, w) {
    return w.speed * c.speed + w.comfort * c.comfort + w.fuel * c.fuel + w.sailing * c.sailing + w.morale * (c.comfort + c.sailing) / 2;
  },

  // Context assembly for SubQ Snap.
  context: { similarEpisodes: 3, includeNext12h: true, includeLearnedCorrection: true },
};
strategy;
