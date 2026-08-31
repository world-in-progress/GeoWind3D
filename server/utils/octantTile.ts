export type LatLonBox = {
  n: number;
  s: number;
  w: number;
  e: number;
};

export type LatLonBbox = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

const FIRST_OCTANT_BOXES: Array<{ path: string; box: LatLonBox }> = [
  { path: '02', box: { n: 0, s: -90, w: -180, e: -90 } },
  { path: '03', box: { n: 0, s: -90, w: -90, e: 0 } },
  { path: '12', box: { n: 0, s: -90, w: 0, e: 90 } },
  { path: '13', box: { n: 0, s: -90, w: 90, e: 180 } },
  { path: '20', box: { n: 90, s: 0, w: -180, e: -90 } },
  { path: '21', box: { n: 90, s: 0, w: -90, e: 0 } },
  { path: '30', box: { n: 90, s: 0, w: 0, e: 90 } },
  { path: '31', box: { n: 90, s: 0, w: 90, e: 180 } },
];

function getFirstOctantBox(path: string): LatLonBox {
  const first = path.slice(0, 2);
  switch (first) {
    case '02': return { n: 0, s: -90, w: -180, e: -90 };
    case '03': return { n: 0, s: -90, w: -90, e: 0 };
    case '12': return { n: 0, s: -90, w: 0, e: 90 };
    case '13': return { n: 0, s: -90, w: 90, e: 180 };
    case '20': return { n: 90, s: 0, w: -180, e: -90 };
    case '21': return { n: 90, s: 0, w: -90, e: 0 };
    case '30': return { n: 90, s: 0, w: 0, e: 90 };
    case '31': return { n: 90, s: 0, w: 90, e: 180 };
    default:
      throw new Error(`Invalid first octant: ${first}`);
  }
}

function advanceHorizontalBox(box: LatLonBox, horizontalKey: number): LatLonBox {
  if (horizontalKey < 0 || horizontalKey > 3) {
    throw new Error(`Invalid horizontal octant key: ${horizontalKey}`);
  }

  let { n, s, w, e } = box;
  const midLat = (n + s) / 2;
  const midLon = (w + e) / 2;

  if (horizontalKey < 2) {
    n = midLat;
  } else {
    s = midLat;
  }

  if (n === 90 || s === -90) {
    return { n, s, w, e };
  }

  if (horizontalKey % 2 === 0) {
    e = midLon;
  } else {
    w = midLon;
  }

  return { n, s, w, e };
}

function advanceBox(box: LatLonBox, digit: number): LatLonBox {
  return advanceHorizontalBox(box, digit >= 4 ? digit - 4 : digit);
}

function boxesIntersect(box: LatLonBox, bbox: LatLonBbox): boolean {
  return box.e >= bbox.minLon
    && box.w <= bbox.maxLon
    && box.n >= bbox.minLat
    && box.s <= bbox.maxLat;
}

function collectIntersectingHorizontalPaths(
  pathPrefix: string,
  box: LatLonBox,
  level: number,
  bbox: LatLonBbox,
  output: string[],
  hasPrefix?: (path: string) => boolean,
) {
  if ((hasPrefix && !hasPrefix(pathPrefix)) || !boxesIntersect(box, bbox)) {
    return;
  }

  if (pathPrefix.length === level) {
    output.push(pathPrefix);
    return;
  }

  for (let horizontalKey = 0; horizontalKey < 4; horizontalKey++) {
    collectIntersectingHorizontalPaths(
      `${pathPrefix}${horizontalKey}`,
      advanceHorizontalBox(box, horizontalKey),
      level,
      bbox,
      output,
      hasPrefix,
    );
  }
}

export function getOctantLatLonBox(path: string): LatLonBox {
  if (path.length < 2) {
    throw new Error(`Invalid octant path: ${path}`);
  }
  let box = getFirstOctantBox(path);
  for (let i = 2; i < path.length; i++) {
    const digit = Number(path[i]);
    if (!Number.isInteger(digit)) {
      throw new Error(`Invalid octant path digit: ${path[i]}`);
    }
    box = advanceBox(box, digit);
  }
  return box;
}

export function normalizeOctantHorizontalPath(tileId: string): string {
  if (tileId.length < 2) {
    return tileId;
  }
  let normalized = tileId.slice(0, 2);
  for (let i = 2; i < tileId.length; i++) {
    const digit = Number(tileId[i]);
    if (!Number.isInteger(digit) || digit < 0 || digit > 7) {
      return tileId;
    }
    normalized += String(digit >= 4 ? digit - 4 : digit);
  }
  return normalized;
}

export function getIntersectingHorizontalOctantPaths(
  bbox: LatLonBbox,
  level: number,
  options?: { hasPrefix?: (path: string) => boolean },
): string[] {
  const output: string[] = [];
  for (const first of FIRST_OCTANT_BOXES) {
    collectIntersectingHorizontalPaths(first.path, first.box, level, bbox, output, options?.hasPrefix);
  }
  return output;
}

export function octantBoxToRTreeBBox(box: LatLonBox) {
  return {
    minX: box.w,
    minY: box.s,
    maxX: box.e,
    maxY: box.n,
  };
}

export function octantBoxToScope(box: LatLonBox): number[][] {
  return [
    [box.w, box.s],
    [box.e, box.s],
    [box.e, box.n],
    [box.w, box.n],
  ];
}
