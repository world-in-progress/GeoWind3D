import { Pool } from 'pg';

type OSMTable = 'osm_building' | 'osm_elevated_walkway';

type OSMTableConfig = {
  attributes: readonly string[];
};

class ValidationError extends Error {}

const TABLE_CONFIG: Record<OSMTable, OSMTableConfig> = {
  osm_building: {
    attributes: ['full_id', 'osm_type', 'height', 'building:levels'],
  },
  osm_elevated_walkway: {
    attributes: ['full_id', 'osm_type', 'bridge'],
  },
};

const ALLOWED_TABLES = Object.keys(TABLE_CONFIG) as OSMTable[];
const DB_SCHEMA = process.env.POSTGRES_SCHEMA || 'public';
const DB_NAME = process.env.POSTGRES_DB || 'citywind';
const GEOM_COLUMN = 'geom';

const pool = new Pool({
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT || 5433),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: DB_NAME,
});

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_:]*$/.test(identifier)) {
    throw new ValidationError(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function parseTable(rawTable?: string): OSMTable {
  if (!rawTable) {
    throw new ValidationError('Missing table parameter');
  }
  if (!ALLOWED_TABLES.includes(rawTable as OSMTable)) {
    throw new ValidationError(`table must be one of: ${ALLOWED_TABLES.join(', ')}`);
  }
  return rawTable as OSMTable;
}

function parseTileCoord(rawValue: string | undefined, name: string): number {
  const parsed = Number(rawValue);
  if (!rawValue || Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export async function getOSMVectorTile(rawTable: string | undefined, rawZ: string, rawX: string, rawY: string) {
  const table = parseTable(rawTable);
  const z = parseTileCoord(rawZ, 'z');
  const x = parseTileCoord(rawX, 'x');
  const y = parseTileCoord(rawY, 'y');

  const schemaSql = quoteIdentifier(DB_SCHEMA);
  const tableSql = quoteIdentifier(table);
  const geomSql = quoteIdentifier(GEOM_COLUMN);
  const layerName = table;
  const fullTableName = `${DB_SCHEMA}.${table}`;
  const attributes = TABLE_CONFIG[table].attributes;
  const sourceAttributesSql = attributes
    .map((attribute) => `t.${quoteIdentifier(attribute)}::text AS ${quoteIdentifier(attribute)}`)
    .join(',\n        ');
  const mvtAttributesSql = attributes
    .map((attribute) => `source.${quoteIdentifier(attribute)}`)
    .join(',\n        ');

  const existsResult = await pool.query('SELECT to_regclass($1) AS table_name', [fullTableName]);
  if (!existsResult.rows[0]?.table_name) {
    throw new Error(`OSM table does not exist: ${fullTableName}`);
  }

  const sql = `
    WITH bounds AS (
      SELECT ST_TileEnvelope($1, $2, $3) AS geom
    ),
    source AS (
      SELECT
        ${sourceAttributesSql},
        CASE
          WHEN ST_SRID(t.${geomSql}) = 0 THEN ST_SetSRID(t.${geomSql}, 4326)
          ELSE t.${geomSql}
        END AS geom
      FROM ${schemaSql}.${tableSql} t
      WHERE t.${geomSql} IS NOT NULL
    ),
    mvtgeom AS (
      SELECT
        ${mvtAttributesSql},
        ST_AsMVTGeom(
          ST_Transform(source.geom, 3857),
          bounds.geom,
          4096,
          256,
          true
        ) AS geom
      FROM source, bounds
      WHERE ST_Intersects(ST_Transform(source.geom, 3857), bounds.geom)
    )
    SELECT ST_AsMVT(mvtgeom, $4, 4096, 'geom') AS tile
    FROM mvtgeom
  `;

  const result = await pool.query(sql, [z, x, y, layerName]);
  const tile = result.rows[0]?.tile as Buffer | null | undefined;
  return tile ?? Buffer.alloc(0);
}

export function isOSMValidationError(error: unknown): boolean {
  return error instanceof ValidationError;
}

export function normalizeOSMError(error: unknown): string {
  if (error instanceof ValidationError) return error.message;

  const pgError = error as { code?: string; message?: string };
  switch (pgError.code) {
    case '3D000':
      return `Database "${DB_NAME}" does not exist.`;
    case '28P01':
      return 'PostgreSQL authentication failed. Check POSTGRES_USER and POSTGRES_PASSWORD.';
    case 'ECONNREFUSED':
      return 'Cannot connect to PostgreSQL. Check host/port and service status.';
    case '42P01':
      return `Required OSM tables are missing in schema "${DB_SCHEMA}".`;
    case '42703':
      return `Required OSM columns are missing in schema "${DB_SCHEMA}".`;
    default:
      break;
  }

  if (error instanceof Error) {
    return `OSM query failed: ${error.message}`;
  }
  return 'OSM query failed: unknown error';
}
