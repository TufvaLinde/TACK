// TACK routing strategy module — version 1.1.0
// Intent: correct systematic overprediction in waves by applying a smooth
// Hs penalty on all headings, growing above 1.5 m and stronger offwind.
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
        const coeff = 1 + 0.5 * blend;
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