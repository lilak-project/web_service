(() => {
  const TEMPLATE_URL = "template.hwpx";
  const TABLE_CELL_MARGIN_X = 180;
  const TABLE_CELL_MARGIN_Y = 120;
  const TABLE_PHOTO_INSET = 80;
  const TABLE_BASE_WIDTH = 42520;
  const TABLE_TOTAL_WIDTH = 51024;
  const HWPX_SIDE_MARGIN_15MM = 4252;
  const HWPX_VERTICAL_MARGIN_20MM = 5668;
  const HWPX_HEADER_FOOTER_MARGIN = 0;
  const TABLE_HEADER_HEIGHT = 1700;
  const TABLE_PHOTO_ROW_HEIGHT = 10000;
  const TABLE_TEXT_ROW_HEIGHT = 2400;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let templateBytesPromise = null;
  let injectedTemplateBytes = null;

  function xmlEscape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function createCrc32Table() {
    const table = [];
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table.push(value >>> 0);
    }
    return table;
  }

  const crcTable = createCrc32Table();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(bytes, value) {
    bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  function writeUint32(bytes, value) {
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  function readUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function readInt32(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  }

  function readUint16BigEndian(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUint32BigEndian(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function appendBytes(target, source) {
    for (let i = 0; i < source.length; i += 1) {
      target.push(source[i]);
    }
  }

  function getDosDateTime() {
    const now = new Date();
    const year = Math.max(1980, now.getFullYear());
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    return { dosTime, dosDate };
  }

  function findEndOfCentralDirectory(bytes) {
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (readUint32(bytes, i) === 0x06054b50) return i;
    }
    throw new Error("HWPX template ZIP footer was not found.");
  }

  function parseStoredZip(bytes) {
    const eocd = findEndOfCentralDirectory(bytes);
    const entryCount = readUint16(bytes, eocd + 10);
    const centralOffset = readUint32(bytes, eocd + 16);
    const entries = [];
    let offset = centralOffset;

    for (let i = 0; i < entryCount; i += 1) {
      if (readUint32(bytes, offset) !== 0x02014b50) {
        throw new Error("Invalid HWPX template central directory.");
      }

      const method = readUint16(bytes, offset + 10);
      const compressedSize = readUint32(bytes, offset + 20);
      const uncompressedSize = readUint32(bytes, offset + 24);
      const nameLength = readUint16(bytes, offset + 28);
      const extraLength = readUint16(bytes, offset + 30);
      const commentLength = readUint16(bytes, offset + 32);
      const localOffset = readUint32(bytes, offset + 42);
      const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));

      if (method !== 0) {
        throw new Error(`HWPX template entry is compressed and cannot be reused in-browser: ${name}`);
      }
      if (compressedSize !== uncompressedSize) {
        throw new Error(`HWPX template entry size mismatch: ${name}`);
      }
      if (readUint32(bytes, localOffset) !== 0x04034b50) {
        throw new Error(`Invalid HWPX template local header: ${name}`);
      }

      const localNameLength = readUint16(bytes, localOffset + 26);
      const localExtraLength = readUint16(bytes, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      entries.push({ name, data: bytes.slice(dataStart, dataStart + uncompressedSize) });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  function createStoredZip(entries) {
    const fileBytes = [];
    const centralBytes = [];
    const { dosTime, dosDate } = getDosDateTime();
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = encoder.encode(entry.name);
      const dataBytes = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
      const checksum = crc32(dataBytes);
      const localOffset = offset;

      writeUint32(fileBytes, 0x04034b50);
      writeUint16(fileBytes, 20);
      writeUint16(fileBytes, 0x0800);
      writeUint16(fileBytes, 0);
      writeUint16(fileBytes, dosTime);
      writeUint16(fileBytes, dosDate);
      writeUint32(fileBytes, checksum);
      writeUint32(fileBytes, dataBytes.length);
      writeUint32(fileBytes, dataBytes.length);
      writeUint16(fileBytes, nameBytes.length);
      writeUint16(fileBytes, 0);
      appendBytes(fileBytes, nameBytes);
      appendBytes(fileBytes, dataBytes);
      offset = fileBytes.length;

      writeUint32(centralBytes, 0x02014b50);
      writeUint16(centralBytes, 20);
      writeUint16(centralBytes, 20);
      writeUint16(centralBytes, 0x0800);
      writeUint16(centralBytes, 0);
      writeUint16(centralBytes, dosTime);
      writeUint16(centralBytes, dosDate);
      writeUint32(centralBytes, checksum);
      writeUint32(centralBytes, dataBytes.length);
      writeUint32(centralBytes, dataBytes.length);
      writeUint16(centralBytes, nameBytes.length);
      writeUint16(centralBytes, 0);
      writeUint16(centralBytes, 0);
      writeUint16(centralBytes, 0);
      writeUint16(centralBytes, 0);
      writeUint32(centralBytes, 0);
      writeUint32(centralBytes, localOffset);
      appendBytes(centralBytes, nameBytes);
    });

    const centralOffset = fileBytes.length;
    appendBytes(fileBytes, centralBytes);
    writeUint32(fileBytes, 0x06054b50);
    writeUint16(fileBytes, 0);
    writeUint16(fileBytes, 0);
    writeUint16(fileBytes, entries.length);
    writeUint16(fileBytes, entries.length);
    writeUint32(fileBytes, centralBytes.length);
    writeUint32(fileBytes, centralOffset);
    writeUint16(fileBytes, 0);

    return new Blob([new Uint8Array(fileBytes)], { type: "application/hwp+zip" });
  }

  function makeLines(payload, requestTypeLabel) {
    const labels = {
      applicantName: "신청자 이름",
      applicantOrg: "소속",
      takeoutPeriod: "반출 기간",
      takeoutReason: "반출 사유",
      takeoutPlace: "반출 장소",
      assetSharing: "자산공동활용여부",
      domesticOrInternational: "국외/국내 반출 여부",
      securityManagedItem: "보안관리대상물품 여부",
      customsExemptionNumber: "관세감면사후관리 대상물품 면세번호",
      extensionPeriod: "연장 기간",
      extensionReason: "연장 사유",
      returnDate: "반입 일자",
      returnReason: "반입 사유",
      returnPlace: "반입 장소",
    };
    const fields = payload.request?.fields || {};
    const title = requestTypeLabel ? `[${requestTypeLabel}] ${payload.title}` : payload.title;
    const lines = [title, ""];

    Object.entries(labels).forEach(([key, label]) => {
      if (fields[key]) lines.push(`${label}: ${fields[key]}`);
    });

    const headers = ["#", "자산번호", "자산명"];
    if (payload.printSettings?.photos !== "hide") {
      headers.push("자산번호가 확대된 사진", "자산 전체 사진");
    }
    if (payload.printSettings?.description !== "hide") {
      headers.push("자산설명");
    }
    lines.push("", headers.join(" / "));
    const rowStart = getRowStartNumber(payload);
    payload.rows
      .filter((row) => row.assetNumber || row.assetName || row.assetDescription)
      .forEach((row, index) => {
        const description = payload.printSettings?.description === "hide" ? "" : row.assetDescription;
        lines.push(`${rowStart + index}. ${row.assetNumber || ""} / ${row.assetName || ""}${description ? ` / ${description}` : ""}`);
      });

    return lines;
  }

  function makeIntroLines(payload, requestTypeLabel) {
    const labels = {
      applicantName: "신청자 이름",
      applicantOrg: "소속",
      takeoutPeriod: "반출 기간",
      takeoutReason: "반출 사유",
      takeoutPlace: "반출 장소",
      assetSharing: "자산공동활용여부",
      domesticOrInternational: "국외/국내 반출 여부",
      securityManagedItem: "보안관리대상물품 여부",
      customsExemptionNumber: "관세감면사후관리 대상물품 면세번호",
      extensionPeriod: "연장 기간",
      extensionReason: "연장 사유",
      returnDate: "반입 일자",
      returnReason: "반입 사유",
      returnPlace: "반입 장소",
    };
    const fields = payload.request?.fields || {};
    const title = requestTypeLabel ? `[${requestTypeLabel}] ${payload.title}` : payload.title;
    const lines = [title || "자산 목록", ""];

    Object.entries(labels).forEach(([key, label]) => {
      if (fields[key]) lines.push(`${label}: ${fields[key]}`);
    });

    lines.push("");
    return lines;
  }

  function randomId() {
    if (globalThis.crypto?.getRandomValues) {
      return crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return Math.floor(Math.random() * 0xffffffff);
  }

  function getRowStartNumber(payload) {
    const value = Number.parseInt(payload.printSettings?.rowStart, 10);
    return Number.isFinite(value) ? Math.max(1, Math.min(value, 9999)) : 1;
  }

  function getHwpFontHeight(payload) {
    const value = Number.parseFloat(payload.printSettings?.fontSize);
    const fontSize = Number.isFinite(value) ? Math.max(8, Math.min(value, 18)) : 12;
    return Math.round(fontSize * 100);
  }

  function getLineMetrics(fontHeight = 1000, compact = false) {
    const height = Math.max(800, Math.round(fontHeight || 1000));
    const spacing = Math.round(height * (compact ? 0.3 : 0.6));
    return {
      height,
      baseline: Math.round(height * 0.85),
      spacing,
      lineGap: height + spacing,
    };
  }

  function estimateCharWidth(char, fontHeight) {
    if (/\s/.test(char)) return fontHeight * 0.4;
    if (/[\u0000-\u007f]/.test(char)) return fontHeight * 0.55;
    return fontHeight;
  }

  function estimateWrapPositions(text, fontHeight, availableWidth) {
    const chars = Array.from(String(text || " "));
    const positions = [0];
    let currentWidth = 0;
    let textPosition = 0;

    chars.forEach((char) => {
      const charWidth = estimateCharWidth(char, fontHeight);
      if (currentWidth > 0 && currentWidth + charWidth > availableWidth) {
        positions.push(textPosition);
        currentWidth = 0;
      }
      currentWidth += charWidth;
      textPosition += char.length;
    });

    return positions;
  }

  function estimateLineSegments(text, fontHeight, horzsize, compact = false) {
    const metrics = getLineMetrics(fontHeight, compact);
    const availableWidth = Math.max(1000, horzsize || TABLE_TOTAL_WIDTH);
    let textOffset = 0;
    const positions = String(text || " ")
      .split(/\r?\n/)
      .flatMap((line) => {
        const linePositions = estimateWrapPositions(line || " ", metrics.height, availableWidth).map((position) => position + textOffset);
        textOffset += String(line || " ").length;
        return linePositions;
      });
    return positions
      .map(
        (textPosition, index) =>
          `<hp:lineseg textpos="${textPosition}" vertpos="${index * metrics.lineGap}" vertsize="${metrics.height}" textheight="${metrics.height}" baseline="${metrics.baseline}" spacing="${metrics.spacing}" horzpos="0" horzsize="${availableWidth}" flags="393216"/>`,
      )
      .join("");
  }

  function paragraphXml(text, paraPrId = "0", charPrId = "0", fontHeight = 1000, horzsize = TABLE_TOTAL_WIDTH, compact = false) {
    return paragraphWithPrefixXml(text, "", paraPrId, charPrId, fontHeight, horzsize, compact);
  }

  function paragraphWithPrefixXml(text, prefixXml = "", paraPrId = "0", charPrId = "0", fontHeight = 1000, horzsize = TABLE_TOTAL_WIDTH, compact = false) {
    const safeText = String(text || " ");
    const runs = safeText
      .split(/\r?\n/)
      .map((line) => `<hp:run charPrIDRef="${charPrId}"><hp:t>${xmlEscape(line || " ")}</hp:t></hp:run>`)
      .join("");
    return `<hp:p id="${randomId()}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${prefixXml}${runs}<hp:linesegarray>${estimateLineSegments(safeText, fontHeight, horzsize, compact)}</hp:linesegarray></hp:p>`;
  }

  function pictureParagraphXml(image, width = 7200, height = 5200) {
    if (!image) return paragraphXml(" ");
    return `<hp:p id="${randomId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:pic id="${randomId()}" zOrder="${image.picId + 3}" numberingType="PICTURE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${randomId()}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${width}" height="${height}"/><hp:curSz width="${width}" height="${height}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.floor(width / 2)}" centerY="${Math.floor(height / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="${image.binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect><hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${width}" dimheight="${height}"/><hp:effects/><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>${xmlEscape(image.label)}</hp:shapeComment></hp:pic><hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${height}" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="${width}" flags="393216"/></hp:linesegarray></hp:p>`;
  }

  function dataUrlToBytes(src) {
    const [metadata, data] = String(src || "").split(",");
    if (!metadata || !data) return null;
    const mimeMatch = /^data:([^;]+)/.exec(metadata);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, mimeType };
  }

  function imageExtension(mimeType) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/png") return "png";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/bmp") return "bmp";
    return "png";
  }

  function getImageDimensions(bytes, mimeType) {
    if (mimeType === "image/png" && bytes.length >= 24) {
      return { width: readUint32BigEndian(bytes, 16), height: readUint32BigEndian(bytes, 20) };
    }

    if (mimeType === "image/gif" && bytes.length >= 10) {
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }

    if (mimeType === "image/bmp" && bytes.length >= 26) {
      return {
        width: Math.abs(readInt32(bytes, 18)),
        height: Math.abs(readInt32(bytes, 22)),
      };
    }

    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = readUint16BigEndian(bytes, offset + 2);
        if (length < 2) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return {
            width: readUint16BigEndian(bytes, offset + 7),
            height: readUint16BigEndian(bytes, offset + 5),
          };
        }
        offset += 2 + length;
      }
    }

    return null;
  }

  function collectImages(payload) {
    const images = [];
    if (payload.printSettings?.photos === "hide") return images;

    payload.rows.forEach((row, rowIndex) => {
      [
        ["numberPhoto", "자산번호 확대 사진"],
        ["wholePhoto", "자산 전체 사진"],
      ].forEach(([key, label]) => {
        const data = dataUrlToBytes(row[key]);
        if (!data) return;
        const index = images.length + 1;
        const ext = imageExtension(data.mimeType);
        const dimensions = getImageDimensions(data.bytes, data.mimeType);
        images.push({
          row,
          rowIndex,
          photoType: key,
          label,
          bytes: data.bytes,
          ext,
          path: `BinData/image${index}.${ext}`,
          fileName: `image${index}.${ext}`,
          binId: `image${index}`,
          picId: index,
          width: dimensions?.width || 0,
          height: dimensions?.height || 0,
        });
      });
    });

    return images;
  }

  function getAssetRows(payload) {
    return (payload.rows || []).filter((row) => row.assetNumber || row.assetName || row.assetDescription || row.numberPhoto || row.wholePhoto);
  }

  function getRowImage(images, rowIndex, photoType) {
    return images.find((image) => image.rowIndex === rowIndex && image.photoType === photoType) || null;
  }

  function scaleColumnsToPage(columns) {
    let usedWidth = 0;
    return columns.map((column, index) => {
      if (index === columns.length - 1) {
        return { ...column, width: TABLE_TOTAL_WIDTH - usedWidth };
      }
      const width = Math.round((column.width / TABLE_BASE_WIDTH) * TABLE_TOTAL_WIDTH);
      usedWidth += width;
      return { ...column, width };
    });
  }

  function getTableColumns(payload) {
    const showPhotos = payload.printSettings?.photos !== "hide";
    const showDescription = payload.printSettings?.description !== "hide";
    const columns = [
      { key: "index", label: "#", width: 1800 },
      { key: "assetNumber", label: "자산번호", width: 6200 },
      { key: "assetName", label: "자산명", width: showPhotos ? 9000 : 15500 },
    ];

    if (showPhotos) {
      columns.push(
        { key: "numberPhoto", label: "자산번호가 확대된 사진", width: showDescription ? 8000 : 12760 },
        { key: "wholePhoto", label: "자산 전체 사진", width: showDescription ? 8000 : 12760 },
      );
    }

    if (showDescription) {
      columns.push({ key: "assetDescription", label: "자산설명", width: showPhotos ? 9520 : 19020 });
    }

    return scaleColumnsToPage(columns);
  }

  function cellParagraph(text, charPrId = "0", fontHeight = 1000, horzsize = TABLE_TOTAL_WIDTH) {
    return paragraphXml(text || " ", "11", charPrId, fontHeight, horzsize, true);
  }

  function tableCellXml(contentXml, colAddr, rowAddr, width, height) {
    return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${contentXml}</hp:subList><hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${width}" height="${height}"/><hp:cellMargin left="${TABLE_CELL_MARGIN_X}" right="${TABLE_CELL_MARGIN_X}" top="${TABLE_CELL_MARGIN_Y}" bottom="${TABLE_CELL_MARGIN_Y}"/></hp:tc>`;
  }

  function tablePhotoXml(image, cellWidth, cellHeight) {
    const maxWidth = Math.max(1000, cellWidth - TABLE_CELL_MARGIN_X * 2 - TABLE_PHOTO_INSET * 2);
    const maxHeight = Math.max(1000, cellHeight - TABLE_CELL_MARGIN_Y * 2 - TABLE_PHOTO_INSET * 2);
    if (!image?.width || !image?.height) return pictureParagraphXml(image, maxWidth, maxHeight);

    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    const photoWidth = Math.max(1, Math.round(image.width * scale));
    const photoHeight = Math.max(1, Math.round(image.height * scale));
    return pictureParagraphXml(image, photoWidth, photoHeight);
  }

  function makeTableXml(payload, images) {
    const rows = getAssetRows(payload);
    const columns = getTableColumns(payload);
    const rowStart = getRowStartNumber(payload);
    const fontHeight = getHwpFontHeight(payload);
    const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
    const showPhotos = payload.printSettings?.photos !== "hide";
    const headerHeight = Math.max(TABLE_HEADER_HEIGHT, Math.round(fontHeight * 2.4));
    const dataHeight = showPhotos ? TABLE_PHOTO_ROW_HEIGHT : TABLE_TEXT_ROW_HEIGHT;

    const headerCells = columns
      .map((column, colIndex) =>
        tableCellXml(cellParagraph(column.label, "0", fontHeight, column.width - TABLE_CELL_MARGIN_X * 2), colIndex, 0, column.width, headerHeight),
      )
      .join("");

    const bodyRows = rows
      .map((row, rowIndex) => {
        const originalRowIndex = (payload.rows || []).indexOf(row);
        const cells = columns
          .map((column, colIndex) => {
            let content = "";
            const textWidth = column.width - TABLE_CELL_MARGIN_X * 2;
            if (column.key === "index") content = cellParagraph(String(rowStart + rowIndex), "0", fontHeight, textWidth);
            if (column.key === "assetNumber") content = cellParagraph(row.assetNumber, "0", fontHeight, textWidth);
            if (column.key === "assetName") content = cellParagraph(row.assetName, "0", fontHeight, textWidth);
            if (column.key === "assetDescription") content = cellParagraph(row.assetDescription, "0", fontHeight, textWidth);
            if (column.key === "numberPhoto") {
              content = tablePhotoXml(getRowImage(images, originalRowIndex, "numberPhoto"), column.width, dataHeight);
            }
            if (column.key === "wholePhoto") {
              content = tablePhotoXml(getRowImage(images, originalRowIndex, "wholePhoto"), column.width, dataHeight);
            }
            return tableCellXml(content, colIndex, rowIndex + 1, column.width, dataHeight);
          })
          .join("");
        return `<hp:tr>${cells}</hp:tr>`;
      })
      .join("");

    const tableHeight = headerHeight + dataHeight * Math.max(rows.length, 1);
    const rowsXml = `<hp:tr>${headerCells}</hp:tr>${bodyRows}`;
    const metrics = getLineMetrics(fontHeight);
    return `<hp:p id="${randomId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${randomId()}" zOrder="2" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length + 1}" colCnt="${columns.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${tableWidth}" widthRelTo="ABSOLUTE" height="${tableHeight}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="283" bottom="283"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>${rowsXml}</hp:tbl><hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${tableHeight}" textheight="${metrics.height}" baseline="${metrics.baseline}" spacing="${metrics.spacing}" horzpos="0" horzsize="${tableWidth}" flags="393216"/></hp:linesegarray></hp:p>`;
  }

  function ensureTableBorderFill(headerXml) {
    if (/<hh:borderFill\b[^>]*\bid="3"/.test(headerXml)) return headerXml;
    const tableBorder = `<hh:borderFill id="3" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.1 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.1 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.1 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.1 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="#FFFFFF" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`;
    return headerXml
      .replace(/<hh:borderFills itemCnt="(\d+)">/, (match, count) => `<hh:borderFills itemCnt="${Number(count) + 1}">`)
      .replace("</hh:borderFills>", `${tableBorder}</hh:borderFills>`);
  }

  function applyHwpFontSize(headerXml, payload) {
    const height = getHwpFontHeight(payload);
    return headerXml.replace(/(<hh:charPr id="0" height=")\d+(")/, `$1${height}$2`);
  }

  function applyNarrowPageMargins(xml) {
    return xml.replace(
      /(<hp:margin\b[^>]*\bheader=")\d+("[^>]*\bfooter=")\d+("[^>]*\bleft=")\d+("[^>]*\bright=")\d+("[^>]*\btop=")\d+("[^>]*\bbottom=")\d+(")/,
      `$1${HWPX_HEADER_FOOTER_MARGIN}$2${HWPX_HEADER_FOOTER_MARGIN}$3${HWPX_SIDE_MARGIN_15MM}$4${HWPX_SIDE_MARGIN_15MM}$5${HWPX_VERTICAL_MARGIN_20MM}$6${HWPX_VERTICAL_MARGIN_20MM}$7`,
    );
  }

  function getSectionControlRun(firstParagraph) {
    return firstParagraph.match(/<hp:run\b[^>]*>[\s\S]*?<hp:secPr\b[\s\S]*?<\/hp:run>/)?.[0] || "";
  }

  function makeSectionXml(templateSection, lines, payload, images) {
    const rootMatch = templateSection.match(/^([\s\S]*?<hs:sec\b[^>]*>)/);
    const firstParagraphMatch = templateSection.match(/<hp:p\b[\s\S]*?<\/hp:p>/);
    if (!rootMatch || !firstParagraphMatch) {
      throw new Error("HWPX template section is not usable.");
    }

    const sectionStart = applyNarrowPageMargins(rootMatch[1]);
    const sectionControlRun = getSectionControlRun(applyNarrowPageMargins(firstParagraphMatch[0]));
    const fontHeight = getHwpFontHeight(payload);
    const body = lines
      .map((line, index) => {
        if (index === 0) return paragraphWithPrefixXml(line, sectionControlRun, "0", "0", fontHeight);
        return paragraphXml(line, "0", "0", fontHeight);
      })
      .join("");
    return `${sectionStart}${body}${makeTableXml(payload, images)}</hs:sec>`;
  }

  function makeContentHpf(title, images) {
    const safeTitle = xmlEscape(title || "자산 목록");
    const now = new Date().toISOString();
    const imageItems = images
      .map((image) => `<opf:item id="${image.binId}" href="${image.path}" media-type="image/${image.ext === "jpg" ? "jpeg" : image.ext}" isEmbeded="1"/>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="" unique-identifier="" id=""><opf:metadata><opf:title>${safeTitle}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">CENS Assets Tracker</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">CENS Assets Tracker</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="date" content="text">${now}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/>${imageItems}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
  }

  async function loadTemplateEntries() {
    if (injectedTemplateBytes) return parseStoredZip(injectedTemplateBytes);
    if (!templateBytesPromise) {
      templateBytesPromise = fetch(TEMPLATE_URL)
        .then((response) => {
          if (!response.ok) throw new Error("HWPX template could not be loaded.");
          return response.arrayBuffer();
        })
        .then((buffer) => new Uint8Array(buffer));
    }
    return parseStoredZip(await templateBytesPromise);
  }

  function replaceEntry(entries, name, data) {
    const entry = entries.find((item) => item.name === name);
    if (!entry) throw new Error(`HWPX template is missing ${name}.`);
    entry.data = data;
  }

  async function build(payload, requestTypeLabel) {
    const entries = await loadTemplateEntries();
    const templateSection = decoder.decode(entries.find((entry) => entry.name === "Contents/section0.xml")?.data || new Uint8Array());
    const lines = makeIntroLines(payload, requestTypeLabel);
    const previewLines = makeLines(payload, requestTypeLabel);
    const images = collectImages(payload);
    const title = payload.title || "자산 목록";

    replaceEntry(entries, "Contents/section0.xml", makeSectionXml(templateSection, lines, payload, images));
    replaceEntry(entries, "Contents/content.hpf", makeContentHpf(title, images));
    const headerXml = decoder.decode(entries.find((entry) => entry.name === "Contents/header.xml")?.data || new Uint8Array());
    replaceEntry(entries, "Contents/header.xml", applyHwpFontSize(ensureTableBorderFill(headerXml), payload));
    replaceEntry(entries, "Preview/PrvText.txt", previewLines.join("\n"));
    images.forEach((image) => {
      entries.push({ name: image.path, data: image.bytes });
    });

    return createStoredZip(entries);
  }

  function setTemplateBytes(bytes) {
    injectedTemplateBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    templateBytesPromise = null;
  }

  window.CensHwpx = { build, setTemplateBytes };
})();
