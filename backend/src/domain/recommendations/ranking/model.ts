/**
 * A small, dependency-free supervised regressor: ridge (L2-regularized)
 * linear regression trained with batch gradient descent.
 *
 * This is a deliberate choice, not a compromise made silently. Per the
 * design note this engine follows: for tabular financial data with a
 * handful of engineered features, start with gradient-boosted trees; for
 * a JavaScript-only runtime with no Python model service available,
 * fall back to a small regression model rather than reaching for an
 * LSTM/Transformer that would just overfit seven features. This module
 * is that fallback — a real, fitted, walk-forward-validated model (see
 * rankingEngine.ts), not a hand-tuned scoring formula.
 */

export type RidgeModel = {
  weights: number[];
  bias: number;
  /** Standard deviation of in-sample residuals — used to calibrate a probability-of-outperformance score. */
  residualStd: number;
  /** Pearson correlation between in-sample predictions and targets. Not a substitute for the walk-forward metrics, just a fit diagnostic. */
  trainCorrelation: number | null;
  sampleCount: number;
};

export type RidgeTrainOptions = {
  epochs?: number;
  learningRate?: number;
  /** L2 penalty strength. Kept fairly small since features are already z-scored and the effective dimensionality (7 features) is low. */
  l2?: number;
};

export function pearsonCorrelation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((sum, v) => sum + v, 0) / a.length;
  const meanB = b.reduce((sum, v) => sum + v, 0) / b.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return null;
  return numerator / Math.sqrt(denomA * denomB);
}

/**
 * Trains weights + bias by batch gradient descent on mean-squared error
 * with an L2 penalty on the weights (not the bias). `X` rows are assumed
 * already cross-sectionally z-scored (see rankingEngine.ts) so a single
 * fixed learning rate works across every feature without per-feature
 * tuning.
 */
export function trainRidgeRegression(X: number[][], y: number[], options: RidgeTrainOptions = {}): RidgeModel {
  const epochs = options.epochs ?? 350;
  const learningRate = options.learningRate ?? 0.15;
  const l2 = options.l2 ?? 0.01;

  const n = X.length;
  const d = X[0]?.length ?? 0;
  const weights = new Array(d).fill(0);
  let bias = 0;

  if (n === 0 || d === 0) {
    return { weights, bias: 0, residualStd: 0, trainCorrelation: null, sampleCount: 0 };
  }

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i += 1) {
      const row = X[i];
      let prediction = bias;
      for (let j = 0; j < d; j += 1) prediction += weights[j] * row[j];
      const error = prediction - y[i];
      for (let j = 0; j < d; j += 1) gradW[j] += error * row[j];
      gradB += error;
    }

    for (let j = 0; j < d; j += 1) {
      weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= learningRate * (gradB / n);
  }

  const predictions = X.map((row) => {
    let prediction = bias;
    for (let j = 0; j < d; j += 1) prediction += weights[j] * row[j];
    return prediction;
  });
  const residuals = predictions.map((p, i) => p - y[i]);
  const residualMeanSquare = residuals.reduce((sum, r) => sum + r * r, 0) / n;

  return {
    weights,
    bias,
    residualStd: Math.sqrt(residualMeanSquare),
    trainCorrelation: pearsonCorrelation(predictions, y),
    sampleCount: n
  };
}

export function predictOne(model: RidgeModel, x: number[]): number {
  let prediction = model.bias;
  for (let j = 0; j < model.weights.length; j += 1) prediction += model.weights[j] * x[j];
  return prediction;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
