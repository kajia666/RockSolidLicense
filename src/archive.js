const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? (0xedb88320 ^ (value >>> 1))
        : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function toDosDateTime(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.min(2107, Math.max(1980, safe.getFullYear()));
  return {
    date:
      ((year - 1980) << 9)
      | ((safe.getMonth() + 1) << 5)
      | safe.getDate(),
    time:
      (safe.getHours() << 11)
      | (safe.getMinutes() << 5)
      | Math.floor(safe.getSeconds() / 2)
  };
}

function normalizeEntryPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

export function buildZipArchive(entries = [], options = {}) {
  const normalizedEntries = entries.map((entry) => {
    const name = normalizeEntryPath(entry?.path);
    if (!name) {
      throw new Error("Zip entry path must not be empty.");
    }
    return {
      path: name,
      body: Buffer.isBuffer(entry?.body)
        ? entry.body
        : Buffer.from(String(entry?.body ?? ""), "utf8")
    };
  });

  const { date: dosDate, time: dosTime } = toDosDateTime(options.date);
  const generalPurposeFlag = 0x0800;
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of normalizedEntries) {
    const nameBuffer = Buffer.from(entry.path, "utf8");
    const bodyBuffer = entry.body;
    const checksum = crc32(bodyBuffer);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(generalPurposeFlag, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(bodyBuffer.length, 18);
    localHeader.writeUInt32LE(bodyBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, bodyBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(generalPurposeFlag, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(bodyBuffer.length, 20);
    centralHeader.writeUInt32LE(bodyBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBuffer);
    localOffset += localHeader.length + nameBuffer.length + bodyBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(normalizedEntries.length, 8);
  endRecord.writeUInt16LE(normalizedEntries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}
