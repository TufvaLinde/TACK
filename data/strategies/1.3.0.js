// TACK routing strategy module — version 1.3.0 (EVALUATOR SELF-TEST, deliberately flawed)
// Intent: fix backwards TWA dependence of wave penalty.
// Change v1.1.0 -> v1.2.0: keep 1.5m threshold and 0.065 rate,
// reverse blend to penalize upwind most, offwind least.
const strategy = {
  speedFactor(c) {
    // SELF-TEST candidate: crude step penalty (expected to fail held-out gates)
    if (c.waveHeightM != null && c.waveHeightM > 1) return 0.85;
    return 1;
  },
  uncertaintyFactor(c) {
    return 1;
  },
  adjustWeights(w, ctx) {
    return w;
  },
  scoreRoute(c, w) {
    return w.speed * c.speed + w.comfort * c.comfort + w.fuel * c.fuel + w.sailing * c.sailing + w.morale * (c.comfort + c.sailing) / 2;
  },
  context: { similarEpisodes: 3, includeNext12h: true, includeLearnedCorrection: true },
};
strategy;