import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

type FileEntry = {
  absolutePath: string;
  relativePath: string;
};

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let j = 0; j < 8; j += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function collectFiles(rootDir: string, currentDir = rootDir): FileEntry[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: path.relative(rootDir, absolutePath).replace(/\\/g, '/'),
      });
    }
  }
  return files;
}

export function createZipFromDirectory(sourceDir: string, zipPath: string) {
  const files = collectFiles(sourceDir);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });

  const fd = fs.openSync(zipPath, 'w');
  const centralRecords: Buffer[] = [];
  let offset = 0;

  try {
    for (const file of files) {
      const raw = fs.readFileSync(file.absolutePath);
      const compressed = zlib.deflateRawSync(raw);
      const checksum = crc32(raw);
      const name = Buffer.from(file.relativePath, 'utf8');
      const stat = fs.statSync(file.absolutePath);
      const { dosDate, dosTime } = dosDateTime(stat.mtime);
      const localOffset = offset;

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(8, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(raw.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(0, 28);

      fs.writeSync(fd, localHeader);
      fs.writeSync(fd, name);
      fs.writeSync(fd, compressed);
      offset += localHeader.length + name.length + compressed.length;

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(localOffset, 42);
      centralRecords.push(Buffer.concat([central, name]));
    }

    const centralStart = offset;
    for (const record of centralRecords) {
      fs.writeSync(fd, record);
      offset += record.length;
    }
    const centralSize = offset - centralStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(centralRecords.length, 8);
    end.writeUInt16LE(centralRecords.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    fs.writeSync(fd, end);
  } finally {
    fs.closeSync(fd);
  }
}

