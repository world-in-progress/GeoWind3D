export const normalizeWindDirection = (value: number) => {
  const normalized = value % 360
  return normalized < 0 ? normalized + 360 : normalized
}

const getRingSignedArea = (ring: number[][]) => {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    area += x1 * y2 - x2 * y1
  }
  return area / 2
}

const getPolygonOuterRing = (geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): number[][] | null => {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates[0] ?? null
  }

  let largestRing: number[][] | null = null
  let largestArea = 0
  for (const polygon of geometry.coordinates) {
    const ring = polygon[0]
    if (!ring || ring.length < 4) continue
    const area = Math.abs(getRingSignedArea(ring))
    if (area > largestArea) {
      largestArea = area
      largestRing = ring
    }
  }
  return largestRing
}

export const getPolygonCentroid = (
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number] | null => {
  const ring = getPolygonOuterRing(geometry)
  if (!ring || ring.length < 4) return null

  let cx = 0
  let cy = 0
  let factorSum = 0

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    const factor = x1 * y2 - x2 * y1
    factorSum += factor
    cx += (x1 + x2) * factor
    cy += (y1 + y2) * factor
  }

  if (Math.abs(factorSum) < 1e-9) {
    const count = ring.length - 1
    const sum = ring.slice(0, count).reduce(
      (acc, [x, y]) => [acc[0] + x, acc[1] + y] as [number, number],
      [0, 0] as [number, number],
    )
    return [sum[0] / count, sum[1] / count]
  }

  return [cx / (3 * factorSum), cy / (3 * factorSum)]
}

export const getWindArrowEnd = (origin: [number, number], directionDeg: number): [number, number] => {
  const arrowLengthMeters = 300
  const radians = (normalizeWindDirection(directionDeg) * Math.PI) / 180
  const northMeters = arrowLengthMeters * Math.cos(radians)
  const eastMeters = arrowLengthMeters * Math.sin(radians)
  const latRadians = (origin[1] * Math.PI) / 180
  const metersPerDegreeLat = 110540
  const metersPerDegreeLng = Math.max(111320 * Math.cos(latRadians), 1e-6)

  return [
    origin[0] + eastMeters / metersPerDegreeLng,
    origin[1] + northMeters / metersPerDegreeLat,
  ]
}
