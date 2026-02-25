/**
 * K-means++ clustering for 1536-dimensional OpenAI embeddings.
 *
 * Uses cosine distance (= 1 - dot product). Since text-embedding-3-small
 * returns unit-normalized vectors the denominator is always 1.0, so:
 *   cosine_distance(a, b) = 1 - dot(a, b)
 *
 * K-means++ initialization gives a bounded approximation ratio and
 * typically converges in fewer iterations than random init.
 */

export interface KMeansResult {
  /** centroids[k] = Float32Array centroid for cluster k */
  centroids: Float32Array[]
  /** assignments[i] = cluster index for input point i */
  assignments: number[]
}

/**
 * Run K-means++ on a set of unit-normalized embedding vectors.
 *
 * @param points  N input vectors, each Float32Array of dimension D
 * @param k       Desired number of clusters (clamped to N if k > N)
 * @param maxIter Maximum assignment+update iterations (default 50)
 * @param epsilon Convergence: stop when sum of squared centroid
 *                displacements < epsilon * k (default 1e-4)
 */
export function kmeansPP(
  points: Float32Array[],
  k: number,
  maxIter = 50,
  epsilon = 1e-4
): KMeansResult {
  const N = points.length
  if (N === 0) return { centroids: [], assignments: [] }

  // Clamp k to the number of available points
  const K = Math.min(k, N)
  const D = points[0].length

  // ── K-means++ initialization ─────────────────────────────────────────────
  const centroids: Float32Array[] = []

  // Pick first centroid uniformly at random
  centroids.push(copyVec(points[Math.floor(Math.random() * N)]))

  // Pick remaining K-1 centroids via D²-weighted sampling
  for (let c = 1; c < K; c++) {
    const dists = new Float64Array(N)
    let totalDist = 0

    for (let i = 0; i < N; i++) {
      // Distance to nearest already-chosen centroid
      let minDist = Infinity
      for (const centroid of centroids) {
        const d = cosineDist(points[i], centroid)
        if (d < minDist) minDist = d
      }
      dists[i] = minDist * minDist // D² weighting
      totalDist += dists[i]
    }

    // Weighted random selection
    let r = Math.random() * totalDist
    let chosen = N - 1
    for (let i = 0; i < N; i++) {
      r -= dists[i]
      if (r <= 0) {
        chosen = i
        break
      }
    }
    centroids.push(copyVec(points[chosen]))
  }

  // ── Iterative assignment + centroid update ────────────────────────────────
  const assignments = new Array<number>(N).fill(0)

  for (let iter = 0; iter < maxIter; iter++) {
    // Assignment step: assign each point to its nearest centroid
    for (let i = 0; i < N; i++) {
      let bestCluster = 0
      let bestDist = Infinity
      for (let c = 0; c < K; c++) {
        const d = cosineDist(points[i], centroids[c])
        if (d < bestDist) {
          bestDist = d
          bestCluster = c
        }
      }
      assignments[i] = bestCluster
    }

    // Update step: recompute centroids as mean of assigned points
    const newCentroids: Float32Array[] = Array.from({ length: K }, () => new Float32Array(D))
    const counts = new Int32Array(K)

    for (let i = 0; i < N; i++) {
      const c = assignments[i]
      counts[c]++
      const nc = newCentroids[c]
      const pt = points[i]
      for (let d = 0; d < D; d++) nc[d] += pt[d]
    }

    // Normalize (mean) and handle empty clusters
    for (let c = 0; c < K; c++) {
      if (counts[c] === 0) {
        // Empty cluster: reinitialize to the point farthest from any centroid
        let farthestIdx = 0
        let maxDist = -1
        for (let i = 0; i < N; i++) {
          let minDist = Infinity
          for (let cc = 0; cc < K; cc++) {
            if (cc === c) continue
            const d = cosineDist(points[i], centroids[cc])
            if (d < minDist) minDist = d
          }
          if (minDist > maxDist) {
            maxDist = minDist
            farthestIdx = i
          }
        }
        newCentroids[c] = copyVec(points[farthestIdx])
      } else {
        const n = counts[c]
        const nc = newCentroids[c]
        for (let d = 0; d < D; d++) nc[d] /= n
        // Re-normalize to unit length (maintains cosine metric validity)
        normalizeInPlace(nc)
      }
    }

    // Convergence check: sum of squared centroid displacement
    let displacement = 0
    for (let c = 0; c < K; c++) {
      displacement += squaredL2(centroids[c], newCentroids[c])
    }
    for (let c = 0; c < K; c++) centroids[c] = newCentroids[c]

    if (displacement < epsilon * K) break
  }

  return { centroids, assignments }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Cosine distance for unit-normalized vectors: 1 - dot(a, b). */
export function cosineDist(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const len = a.length
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  // Clamp to [0, 2] to handle floating-point noise beyond [-1, 1]
  return Math.max(0, 1 - dot)
}

function copyVec(v: Float32Array): Float32Array {
  return new Float32Array(v)
}

function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }
  return sum
}

function normalizeInPlace(v: Float32Array): void {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm
  }
}
