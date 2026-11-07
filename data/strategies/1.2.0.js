// TACK routing strategy module — version 1.2.0
// Intent: fix backwards TWA dependence of wave penalty.
// Change v1.1.0 -> v1.2.0: keep 1.5m threshold and 0.065 rate,
// reverse blend to penalize upwind most, offwind least.
const strategy = {
  speedFactor(c) {
    let f = 1;
    if (c.waveHeightM != null) {
      const excess = c.waveHeightM - 1.5;
      if (excess > 0) {
        let blend = 0;
        if (c.twaDeg != null) {
          blend = (c.twaDeg - 60) / 30;
          blend = Math.max(0, Math.min(1, blend));
        }
        const coeff = 1.5 - 0.5 * blend;
        f *= 1 - 0.065 * excess * coeff;
      }
    }
    return Math.max(0.3, Math.min(1.3, f));
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