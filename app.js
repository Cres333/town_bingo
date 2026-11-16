// ============================================================================
// 街のパーツ収集・宝探しビンゴ — アプリケーションロジック (app.js)
// ============================================================================

(function () {
  "use strict";

  const STORAGE_KEY = "town_bingo_archive_v1";

  // 8本のビンゴライン定義（0-indexed インデックス）
  const BINGO_LINES = [
    { id: "row_1", label: "横・上段 (1-2-3)", indices: [0, 1, 2] },
    { id: "row_2", label: "横・中段 (4-5-6)", indices: [3, 4, 5] },
    { id: "row_3", label: "横・下段 (7-8-9)", indices: [6, 7, 8] },
    { id: "col_1", label: "縦・左列 (1-4-7)", indices: [0, 3, 6] },
    { id: "col_2", label: "縦・中列 (2-5-8)", indices: [1, 4, 7] },
    { id: "col_3", label: "縦・右列 (3-6-9)", indices: [2, 5, 8] },
    { id: "diag_1", label: "斜め・右下がり (1-5-9)", indices: [0, 4, 8] },
    { id: "diag_2", label: "斜め・右上がり (3-5-7)", indices: [2, 4, 6] }
  ];

  // アプリケーション状態
  let state = loadState();
  let activeModalCellId = null;
  let lastAnimatedCellId = null;
  let activeRegionFilter = "すべて";
  let activeSubRegionFilter = "すべて";
  let activePartsCategory = "すべて";
  let inlineMapVisible = false;
  let inlineMapPinMode = "coords"; // "coords" (座標ピン) | "spot" (スポット名ピン)
  let unreadCompendiumCount = 0; // 図鑑タブを開くと消える新着バッジ件数
  let confettiAnimId = null;

  // スマホの戻るボタン（History API）管理用の状態
  let currentViewId = "view-home";
  let viewHistoryStack = []; // 遷移元のビューID履歴（トップでは空）
  let hasHistoryGuard = false;

  // ==========================================================================
  // 1. 状態管理（IndexedDB 大容量写真保存 ＋ localStorage メタデータ永続化）
  // ==========================================================================
  const IDB_NAME = "town_bingo_photo_db_v1";
  const IDB_STORE = "cell_photos";
  let photoDbPromise = null;
  let idbSupported = typeof indexedDB !== "undefined";
  let idbVerified = false;

  function openPhotoDB() {
    if (!idbSupported) return Promise.resolve(null);
    if (photoDbPromise) return photoDbPromise;
    photoDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = function (e) {
          idbVerified = true;
          resolve(e.target.result);
        };
        req.onerror = function () {
          idbSupported = false;
          idbVerified = false;
          resolve(null);
        };
      } catch (err) {
        idbSupported = false;
        idbVerified = false;
        resolve(null);
      }
    });
    return photoDbPromise;
  }

  function idbPutPhoto(cellId, photoDataUrl) {
    return openPhotoDB().then((db) => {
      if (!db || !photoDataUrl) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(photoDataUrl, cellId);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (err) {
          resolve(false);
        }
      });
    });
  }

  function idbDeletePhoto(cellId) {
    return openPhotoDB().then((db) => {
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).delete(cellId);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (err) {
          resolve(false);
        }
      });
    });
  }

  function idbGetAllPhotos() {
    return openPhotoDB().then((db) => {
      if (!db) return {};
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, "readonly");
          const store = tx.objectStore(IDB_STORE);
          const result = {};
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = function (e) {
            const cursor = e.target.result;
            if (cursor) {
              result[cursor.key] = cursor.value;
              cursor.continue();
            } else {
              resolve(result);
            }
          };
          cursorReq.onerror = () => resolve(result);
        } catch (err) {
          resolve({});
        }
      });
    });
  }

  function formatDateObj(dateObj) {
    if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return null;
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}.${m}.${d}`;
  }

  function formatDateOnly(dateStr) {
    if (!dateStr || typeof dateStr !== "string") {
      return formatDateObj(new Date());
    }
    // 既存データの "YYYY.MM.DD HH:MM" などから時間部分を除いて日付のみ返す
    return dateStr.trim().split(/\s+/)[0];
  }

  // 写真が実際に登録されたレコードかどうか判定（写真なしスタンプやテスト用ダミーを除外）
  function isPhotoRegistered(record) {
    if (!record) return false;
    if (record.isSketch || record.mode === "sketch") return false;
    if (record.isDummy || record.mode === "dummy") return false;
    return Boolean(record.photoDataUrl || record.hasPhoto);
  }

  function getDefaultState() {
    return {
      selectedTownId: INITIAL_TOWNS[0].id,
      unlockedHints: {}, // { [cellId]: true }
      collectedCells: {}, // { [cellId]: { photoDataUrl, capturedAt, mode, isSketch, isDummy } }
      achievedBingos: {} // { [townId]: ["row_1", ...] }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return getDefaultState();
      const parsed = JSON.parse(raw);
      const rawCells = parsed.collectedCells || {};
      const normalizedCells = {};
      Object.keys(rawCells).forEach((cid) => {
        const rec = rawCells[cid];
        if (rec && typeof rec === "object") {
          normalizedCells[cid] = Object.assign({}, rec, {
            capturedAt: formatDateOnly(rec.capturedAt)
          });
        }
      });
      return {
        selectedTownId: parsed.selectedTownId || INITIAL_TOWNS[0].id,
        unlockedHints: parsed.unlockedHints || {},
        collectedCells: normalizedCells,
        achievedBingos: parsed.achievedBingos || {}
      };
    } catch (err) {
      console.warn("localStorageの読み込みに失敗したため初期状態を使用します:", err);
      return getDefaultState();
    }
  }

  // localStorage には画像データ（巨大なBase64）を含めない軽量メタデータのみを保存し、5MB上限到達を防止する
  function buildSlimStateForLocalStorage(includePhotosFallback = false) {
    const slimCells = {};
    Object.keys(state.collectedCells).forEach((cid) => {
      const rec = state.collectedCells[cid];
      if (!rec) return;
      const isSketch = Boolean(rec.isSketch || rec.mode === "sketch");
      const isDummy = Boolean(rec.isDummy || rec.mode === "dummy");
      const hasPhoto = !isSketch && !isDummy && Boolean(rec.photoDataUrl || rec.hasPhoto);
      slimCells[cid] = {
        capturedAt: formatDateOnly(rec.capturedAt),
        mode: rec.mode || (isSketch ? "sketch" : isDummy ? "dummy" : "photo"),
        isSketch: isSketch,
        isDummy: isDummy,
        hasPhoto: hasPhoto
      };
      if (includePhotosFallback && hasPhoto && rec.photoDataUrl) {
        slimCells[cid].photoDataUrl = rec.photoDataUrl;
      }
    });
    return {
      selectedTownId: state.selectedTownId,
      unlockedHints: state.unlockedHints,
      collectedCells: slimCells,
      achievedBingos: state.achievedBingos
    };
  }

  function saveState() {
    try {
      // IndexedDBが利用可能な場合はlocalStorageから巨大な写真Base64を除外して保存
      const slim = buildSlimStateForLocalStorage(!idbSupported);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (err) {
      // 万一フォールバック時に容量上限に達した場合でも、クリア記録や日付メタデータは確実に保存する
      try {
        const metaOnly = buildSlimStateForLocalStorage(false);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(metaOnly));
      } catch (e2) {
        console.error("localStorageへの保存に失敗しました:", e2);
      }
    }
  }

  function encodeCanvasHighQuality(canvas, quality = 0.86) {
    try {
      const webp = canvas.toDataURL("image/webp", quality);
      if (webp && webp.startsWith("data:image/webp")) {
        return webp;
      }
    } catch (e) {
      // ignore
    }
    return canvas.toDataURL("image/jpeg", quality);
  }

  // スケッチ標本・ダミー標本の画像生成補完＆IndexedDBとの双方向マイグレーション（画質は一切落とさず移行）
  function hydrateCellsAndMigrateStorage() {
    // 1. スケッチやダミーでメモリ上に画像がない場合は動的生成してセット
    Object.keys(state.collectedCells).forEach((cid) => {
      const rec = state.collectedCells[cid];
      if (!rec) return;
      if ((rec.isSketch || rec.mode === "sketch") && !rec.photoDataUrl) {
        const found = findCellAndTown(cid);
        if (found) {
          rec.photoDataUrl = generateFieldSketchSpecimen(found.cell, found.town);
        }
      } else if ((rec.isDummy || rec.mode === "dummy") && !rec.photoDataUrl) {
        const found = findCellAndTown(cid);
        if (found) {
          rec.photoDataUrl = generateDummyArchitecturalPhoto(found.cell, found.town);
        }
      }
    });

    // 2. IndexedDBから保存済み高画質写真を読み込みつつ、旧localStorage内の写真を無劣化でIndexedDBへ移行
    idbGetAllPhotos().then(async (dbPhotos) => {
      const migrationPromises = [];

      Object.keys(state.collectedCells).forEach((cid) => {
        const rec = state.collectedCells[cid];
        if (!rec) return;
        const isSketch = Boolean(rec.isSketch || rec.mode === "sketch");
        const isDummy = Boolean(rec.isDummy || rec.mode === "dummy");

        if (!isSketch && !isDummy) {
          if (dbPhotos[cid]) {
            // IndexedDB側に高画質写真がある場合はそちらを採用
            rec.photoDataUrl = dbPhotos[cid];
          } else if (rec.photoDataUrl && idbSupported) {
            // 旧localStorageに保存されていた写真をそのままの画質でIndexedDBへ移行保存
            migrationPromises.push(idbPutPhoto(cid, rec.photoDataUrl));
          }
          rec.hasPhoto = Boolean(rec.photoDataUrl);
        }
      });

      if (migrationPromises.length > 0) {
        await Promise.all(migrationPromises);
      }

      // localStorage側を軽量メタデータのみで上書き保存
      saveState();
      renderAll();
    });
  }

  // ==========================================================================
  // 2. ヘルパー：街データ・ビンゴ判定計算
  // ==========================================================================
  function getTownById(townId) {
    return INITIAL_TOWNS.find((t) => t.id === townId) || INITIAL_TOWNS[0];
  }

  function findCellAndTown(cellId) {
    for (const town of INITIAL_TOWNS) {
      const cell = town.cells.find((c) => c.id === cellId);
      if (cell) return { cell, town };
    }
    return null;
  }

  function getTownProgress(town) {
    const clearedMap = town.cells.map((cell) => Boolean(state.collectedCells[cell.id]));
    const clearedCount = clearedMap.filter(Boolean).length;

    const activeLines = [];
    const cellsInBingoLines = new Set();

    BINGO_LINES.forEach((line) => {
      const isLineComplete = line.indices.every((idx) => clearedMap[idx]);
      if (isLineComplete) {
        activeLines.push(line);
        line.indices.forEach((idx) => cellsInBingoLines.add(town.cells[idx].id));
      }
    });

    return {
      clearedCount,
      totalCells: town.cells.length,
      activeLines,
      bingoCount: activeLines.length,
      isComplete: clearedCount === town.cells.length,
      cellsInBingoLines
    };
  }

  function getOverallStats() {
    let totalCollected = 0;
    let totalCells = 0;
    let totalBingos = 0;
    let completedTowns = 0;

    INITIAL_TOWNS.forEach((town) => {
      const prog = getTownProgress(town);
      totalCollected += prog.clearedCount;
      totalCells += prog.totalCells;
      totalBingos += prog.bingoCount;
      if (prog.isComplete) completedTowns += 1;
    });

    return {
      totalCollected,
      totalCells,
      totalBingos,
      completedTowns,
      totalTowns: INITIAL_TOWNS.length
    };
  }

  // ==========================================================================
  // 3. 建築パーツシルエット SVG アイコン生成
  // ==========================================================================
  function getArchitecturalSilhouetteSVG(iconType, size = 28) {
    const common = `width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    switch (iconType) {
      case "clock_tower":
        return `<svg ${common}>
          <path d="M18 8L24 3L30 8" />
          <rect x="16" y="8" width="16" height="36" />
          <circle cx="24" cy="18" r="5" />
          <path d="M24 16v2.5l1.8 1.2" />
          <path d="M14 28h20M14 36h20M12 44h24" />
        </svg>`;
      case "crown_tower":
        return `<svg ${common}>
          <path d="M24 3v5M14 12h20l-3-4H17l-3 4z" />
          <path d="M12 18h24l-2-6H14l-2 6z" />
          <rect x="15" y="18" width="18" height="26" />
          <path d="M20 24v14M24 24v14M28 24v14M10 44h28" />
        </svg>`;
      case "dome":
        return `<svg ${common}>
          <path d="M24 4v4" />
          <path d="M12 22 C12 12, 36 12, 36 22" />
          <rect x="10" y="22" width="28" height="6" />
          <path d="M12 28v16M20 28v16M28 28v16M36 28v16M8 44h32" />
        </svg>`;
      case "columns":
        return `<svg ${common}>
          <path d="M6 12L24 4L42 12H6z" />
          <rect x="8" y="12" width="32" height="4" />
          <path d="M13 16v24M19 16v24M29 16v24M35 16v24" />
          <rect x="6" y="40" width="36" height="4" />
        </svg>`;
      case "capital":
        return `<svg ${common}>
          <rect x="6" y="8" width="36" height="4" />
          <circle cx="13" cy="17" r="5" />
          <circle cx="35" cy="17" r="5" />
          <circle cx="13" cy="17" r="2" />
          <circle cx="35" cy="17" r="2" />
          <path d="M18 14h12M16 22v22M21 24v20M27 24v20M32 22v22" />
        </svg>`;
      case "medallion":
        return `<svg ${common}>
          <path d="M6 18L24 6L42 18" />
          <circle cx="24" cy="24" r="9" />
          <circle cx="24" cy="24" r="5" />
          <path d="M10 38c4-3 9-3 14 0c5-3 10-3 14 0" />
          <path d="M8 44h32" />
        </svg>`;
      case "arch_brick":
        return `<svg ${common}>
          <rect x="6" y="8" width="36" height="36" />
          <path d="M14 44V26a10 10 0 0 1 20 0v18" />
          <path d="M6 14h36M18 8v6M30 8v6" />
        </svg>`;
      case "iron_door":
        return `<svg ${common}>
          <path d="M10 44V14a14 14 0 0 1 28 0v30" />
          <path d="M24 10v34M10 24h28M10 34h28" />
          <circle cx="20" cy="29" r="1.5" />
          <circle cx="28" cy="29" r="1.5" />
        </svg>`;
      case "torii":
        return `<svg ${common}>
          <path d="M5 10c8 3 30 3 38 0" stroke-width="2.5" />
          <path d="M8 17h32" />
          <path d="M14 11v33M34 11v33" stroke-width="2.4" />
          <path d="M24 11v6" />
          <path d="M10 44h8M30 44h8" />
        </svg>`;
      case "castle":
        return `<svg ${common}>
          <path d="M16 14l8-8 8 8H16z" />
          <path d="M11 25l4-5h18l4 5H11z" />
          <rect x="15" y="14" width="18" height="6" />
          <rect x="13" y="25" width="22" height="9" />
          <path d="M8 44l4-10h24l4 10H8z" />
        </svg>`;
      case "landscape":
        return `<svg ${common}>
          <circle cx="36" cy="12" r="5" />
          <path d="M4 36L17 16l9 12 6-7 12 15H4z" />
          <path d="M4 42c6-2 12 2 18 0s12-2 22 0" />
        </svg>`;
      case "tower":
        return `<svg ${common}>
          <path d="M24 3v7" />
          <path d="M21 10h6l3 22h-12l3-22z" />
          <rect x="17" y="20" width="14" height="4" />
          <path d="M18 32l-5 12M30 32l5 12" />
          <path d="M15 41a9 6 0 0 1 18 0" />
          <path d="M10 44h28" />
        </svg>`;
      case "bridge":
        return `<svg ${common}>
          <path d="M4 26c10-12 30-12 40 0" />
          <path d="M4 30h40" />
          <path d="M12 21v9M20 18v12M28 18v12M36 21v9" />
          <path d="M6 38c6-3 12 3 18 0s12-3 18 0" />
        </svg>`;
      case "iron_grille":
      default:
        return `<svg ${common}>
          <rect x="8" y="6" width="32" height="36" rx="16" />
          <path d="M24 6v36M8 24h32" />
          <circle cx="24" cy="24" r="7" />
          <path d="M17 15c3 4 11 4 14 0M17 33c3-4 11-4 14 0" />
        </svg>`;
    }
  }

  // ==========================================================================
  // 4. テスト用ダミー画像ジェネレーター（レトロ建築標本風イラスト合成）
  // ==========================================================================
  function generateDummyArchitecturalPhoto(cell, town) {
    const canvas = document.createElement("canvas");
    const size = 520;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    const pal = cell.dummy_palette || {
      bg: "#7A4938",
      accent: "#E5DEC9",
      detail: "#1B263B"
    };

    // 背景グラデーション
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, pal.bg);
    grad.addColorStop(1, pal.detail);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 建築図面風のグリッド線
    ctx.strokeStyle = "rgba(255, 248, 231, 0.12)";
    ctx.lineWidth = 1;
    for (let x = 0; x < size; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let y = 0; y < size; y += 26) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    // 太陽光・ビネット効果
    const radial = ctx.createRadialGradient(size * 0.5, size * 0.42, 30, size * 0.5, size * 0.5, size * 0.65);
    radial.addColorStop(0, "rgba(255, 245, 220, 0.25)");
    radial.addColorStop(1, "rgba(10, 15, 25, 0.55)");
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, size, size);

    // 中央の建築モチーフ描画
    ctx.save();
    ctx.translate(size / 2, size * 0.44);
    ctx.strokeStyle = pal.accent;
    ctx.fillStyle = "rgba(255, 250, 240, 0.14)";
    ctx.lineWidth = 4;

    drawArchitecturalMotifOnCanvas(ctx, cell.icon_type, pal.accent);
    ctx.restore();

    // 四隅のファインダー枠線
    ctx.strokeStyle = "rgba(217, 182, 108, 0.85)";
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, size - 36, size - 36);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(26, 26, size - 52, size - 52);

    // 上部標本ラベル
    ctx.fillStyle = "rgba(17, 25, 39, 0.78)";
    ctx.fillRect(26, 26, size - 52, 44);
    ctx.fillStyle = "#D9B66C";
    ctx.font = "bold 15px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      `SPECIMEN ${town.specimen_prefix}-${String(cell.position).padStart(2, "0")} [TEST ARCHIVE]`,
      40,
      53
    );

    // 下部キャプション帯
    ctx.fillStyle = "rgba(17, 25, 39, 0.86)";
    ctx.fillRect(26, size - 118, size - 52, 92);
    ctx.strokeStyle = "#B5893E";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(26, size - 118);
    ctx.lineTo(size - 26, size - 118);
    ctx.stroke();

    ctx.fillStyle = "#FAF6EE";
    ctx.font = "bold 20px 'Shippori Mincho', serif";
    ctx.textAlign = "center";
    ctx.fillText(cell.title, size / 2, size - 82);

    ctx.fillStyle = "#D9B66C";
    ctx.font = "14px sans-serif";
    ctx.fillText(`📍 ${cell.spot_name}`, size / 2, size - 54);

    ctx.fillStyle = "rgba(242, 236, 225, 0.75)";
    ctx.font = "12px sans-serif";
    ctx.fillText(`照準: ${cell.crop_target}`, size / 2, size - 34);

    return canvas.toDataURL("image/jpeg", 0.86);
  }

  // 写真なしで「発見！採集スタンプ」を押した際の『建築スケッチ標本画』ジェネレーター
  function generateFieldSketchSpecimen(cell, town) {
    const canvas = document.createElement("canvas");
    const size = 520;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // 温かみのあるクラフト羊皮紙調背景
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, "#F6F0E4");
    grad.addColorStop(1, "#E5DAC3");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 方眼ノート・設計図グリッド線
    ctx.strokeStyle = "rgba(138, 118, 88, 0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x < size; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let y = 0; y < size; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    // ペン画風の建築モチーフ描画（ダークネイビー＆セピアインク）
    ctx.save();
    ctx.translate(size / 2, size * 0.43);
    ctx.fillStyle = "rgba(27, 38, 59, 0.08)";
    ctx.lineWidth = 3.5;
    drawArchitecturalMotifOnCanvas(ctx, cell.icon_type, "#1B263B");
    ctx.restore();

    // 手帳枠線
    ctx.strokeStyle = "#1B263B";
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, size - 36, size - 36);

    ctx.strokeStyle = "#B5893E";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(25, 25, size - 50, size - 50);

    // 上部ヘッダー（FIELD SKETCH STAMP）
    ctx.fillStyle = "#1B263B";
    ctx.fillRect(25, 25, size - 50, 42);
    ctx.fillStyle = "#D9B66C";
    ctx.font = "bold 14px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      `FIELD SKETCH // ${town.specimen_prefix}-${String(cell.position).padStart(2, "0")} [NO PHOTO]`,
      38,
      51
    );

    // 朱肉風の丸印スタンプ（現地確認印）
    ctx.save();
    ctx.translate(size - 86, 122);
    ctx.rotate(-0.14);
    ctx.strokeStyle = "rgba(158, 42, 43, 0.82)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 38, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(158, 42, 43, 0.85)";
    ctx.font = "bold 13px 'Shippori Mincho', serif";
    ctx.textAlign = "center";
    ctx.fillText("現地発見", 0, -4);
    ctx.fillText("採集之印", 0, 14);
    ctx.restore();

    // 下部キャプション帯
    ctx.fillStyle = "rgba(27, 38, 59, 0.92)";
    ctx.fillRect(25, size - 116, size - 50, 91);
    ctx.fillStyle = "#FAF6EE";
    ctx.font = "bold 20px 'Shippori Mincho', serif";
    ctx.textAlign = "center";
    ctx.fillText(cell.title, size / 2, size - 80);

    ctx.fillStyle = "#D9B66C";
    ctx.font = "14px sans-serif";
    ctx.fillText(`📍 ${cell.spot_name}`, size / 2, size - 52);

    ctx.fillStyle = "rgba(242, 236, 225, 0.78)";
    ctx.font = "12px sans-serif";
    ctx.fillText("✒️ 手帳スケッチ標本（後から写真を追加可能）", size / 2, size - 32);

    return canvas.toDataURL("image/jpeg", 0.86);
  }

  function drawArchitecturalMotifOnCanvas(ctx, iconType, strokeColor) {
    ctx.strokeStyle = strokeColor;
    switch (iconType) {
      case "clock_tower":
        // 時計塔
        ctx.strokeRect(-55, -70, 110, 160);
        ctx.beginPath();
        ctx.moveTo(-65, -70);
        ctx.lineTo(0, -125);
        ctx.lineTo(65, -70);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 白帯
        ctx.fillStyle = strokeColor;
        ctx.fillRect(-55, -35, 110, 10);
        ctx.fillRect(-55, 35, 110, 10);
        // 文字盤
        ctx.beginPath();
        ctx.arc(0, 0, 28, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -18);
        ctx.moveTo(0, 0);
        ctx.lineTo(14, 8);
        ctx.stroke();
        break;

      case "crown_tower":
        // 帝冠・段状塔屋
        ctx.strokeRect(-70, -20, 140, 110);
        ctx.strokeRect(-52, -55, 104, 35);
        ctx.strokeRect(-34, -85, 68, 30);
        ctx.beginPath();
        ctx.moveTo(-45, -85);
        ctx.lineTo(0, -115);
        ctx.lineTo(45, -85);
        ctx.stroke();
        for (let x = -45; x <= 45; x += 30) {
          ctx.strokeRect(x - 8, -5, 16, 80);
        }
        break;

      case "dome":
        // ドーム屋根
        ctx.beginPath();
        ctx.arc(0, -15, 75, Math.PI, 0, false);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -90);
        ctx.lineTo(0, -120);
        ctx.stroke();
        ctx.strokeRect(-85, -15, 170, 24);
        for (let x = -65; x <= 65; x += 32.5) {
          ctx.beginPath();
          ctx.moveTo(x, 9);
          ctx.lineTo(x, 90);
          ctx.stroke();
        }
        break;

      case "columns":
      case "capital":
        // イオニア・コリント列柱
        ctx.strokeRect(-95, -85, 190, 22);
        ctx.beginPath();
        ctx.arc(-55, -45, 22, 0, Math.PI * 2);
        ctx.arc(55, -45, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-55, -45, 10, 0, Math.PI * 2);
        ctx.arc(55, -45, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeRect(-42, -55, 84, 20);
        for (let x = -35; x <= 35; x += 17.5) {
          ctx.beginPath();
          ctx.moveTo(x, -35);
          ctx.lineTo(x, 95);
          ctx.stroke();
        }
        break;

      case "medallion":
        // バロックメダリオン
        ctx.beginPath();
        ctx.moveTo(-105, -20);
        ctx.lineTo(0, -95);
        ctx.lineTo(105, -20);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 5, 52, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 5, 34, 0, Math.PI * 2);
        ctx.stroke();
        break;

      case "torii":
        // 鳥居・社寺
        ctx.beginPath();
        ctx.moveTo(-105, -75);
        ctx.quadraticCurveTo(0, -55, 105, -75);
        ctx.stroke();
        ctx.strokeRect(-85, -45, 170, 12);
        ctx.strokeRect(-55, -65, 16, 155);
        ctx.strokeRect(39, -65, 16, 155);
        ctx.strokeRect(-10, -65, 20, 20);
        break;

      case "castle":
        // 城郭・天守
        ctx.beginPath();
        ctx.moveTo(-55, -65);
        ctx.lineTo(0, -110);
        ctx.lineTo(55, -65);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeRect(-45, -65, 90, 32);
        ctx.beginPath();
        ctx.moveTo(-80, -10);
        ctx.lineTo(-55, -33);
        ctx.lineTo(55, -33);
        ctx.lineTo(80, -10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeRect(-62, -10, 124, 48);
        ctx.beginPath();
        ctx.moveTo(-85, 90);
        ctx.lineTo(-65, 38);
        ctx.lineTo(65, 38);
        ctx.lineTo(85, 90);
        ctx.closePath();
        ctx.stroke();
        break;

      case "landscape":
        // 風景・山岳・海
        ctx.beginPath();
        ctx.arc(65, -75, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-105, 55);
        ctx.lineTo(-20, -65);
        ctx.lineTo(35, 10);
        ctx.lineTo(65, -25);
        ctx.lineTo(105, 55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-105, 80);
        ctx.bezierCurveTo(-40, 65, 40, 95, 105, 75);
        ctx.stroke();
        break;

      case "tower":
        // ランドマークタワー
        ctx.beginPath();
        ctx.moveTo(0, -125);
        ctx.lineTo(0, -90);
        ctx.moveTo(-16, -90);
        ctx.lineTo(16, -90);
        ctx.lineTo(34, 35);
        ctx.lineTo(-34, 35);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeRect(-32, -30, 64, 16);
        ctx.beginPath();
        ctx.moveTo(-34, 35);
        ctx.lineTo(-65, 92);
        ctx.moveTo(34, 35);
        ctx.lineTo(65, 92);
        ctx.arc(0, 92, 42, Math.PI, 0, false);
        ctx.stroke();
        break;

      case "bridge":
        // 名橋・水辺
        ctx.beginPath();
        ctx.moveTo(-105, 20);
        ctx.quadraticCurveTo(0, -55, 105, 20);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-105, 35);
        ctx.lineTo(105, 35);
        ctx.stroke();
        for (let x = -70; x <= 70; x += 35) {
          ctx.beginPath();
          ctx.moveTo(x, -10);
          ctx.lineTo(x, 35);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(-95, 70);
        ctx.bezierCurveTo(-30, 55, 30, 85, 95, 65);
        ctx.stroke();
        break;

      case "arch_brick":
      case "iron_door":
      case "iron_grille":
      default:
        // アーチ＆鉄格子・煉瓦
        ctx.strokeRect(-90, -90, 180, 180);
        ctx.beginPath();
        ctx.arc(0, -10, 62, Math.PI, 0, false);
        ctx.lineTo(62, 90);
        ctx.lineTo(-62, 90);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -72);
        ctx.lineTo(0, 90);
        ctx.moveTo(-62, 15);
        ctx.lineTo(62, 15);
        ctx.stroke();
        break;
    }
  }

  // ==========================================================================
  // 5. カメラ・画像ファイルの読み込み＆撮影日抽出・正方形中央トリミング圧縮
  // ==========================================================================
  function parseExifDateString(str) {
    if (!str || typeof str !== "string") return null;
    const match = str.trim().match(/^(\d{4})[:\-/.](\d{2})[:\-/.](\d{2})/);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return `${match[1]}.${match[2]}.${match[3]}`;
  }

  function parseTiffExifDate(view, tiffStart, maxEnd) {
    if (tiffStart + 8 > maxEnd) return null;
    const byteOrder = view.getUint16(tiffStart, false);
    let littleEndian;
    if (byteOrder === 0x4949) {
      littleEndian = true;
    } else if (byteOrder === 0x4d4d) {
      littleEndian = false;
    } else {
      return null;
    }

    if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return null;
    const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
    const ifd0Pos = tiffStart + ifd0Offset;
    if (ifd0Pos + 2 > maxEnd) return null;

    const readAsciiTag = (valueOffset, count) => {
      const strPos = tiffStart + valueOffset;
      const len = Math.min(count, 20);
      if (strPos < 0 || strPos + len > maxEnd) return null;
      let s = "";
      for (let i = 0; i < len; i++) {
        const ch = view.getUint8(strPos + i);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      return parseExifDateString(s);
    };

    const scanIfd = (ifdPos) => {
      if (ifdPos + 2 > maxEnd) return {};
      const numEntries = view.getUint16(ifdPos, littleEndian);
      const result = {};
      for (let i = 0; i < numEntries; i++) {
        const entryPos = ifdPos + 2 + i * 12;
        if (entryPos + 12 > maxEnd) break;
        const tag = view.getUint16(entryPos, littleEndian);
        const type = view.getUint16(entryPos + 2, littleEndian);
        const count = view.getUint32(entryPos + 4, littleEndian);
        const valOffset = view.getUint32(entryPos + 8, littleEndian);

        // ExifIFDPointer (0x8769)
        if (tag === 0x8769) {
          result.exifIfdOffset = valOffset;
        }
        // ASCII日付タグ: 0x9003(DateTimeOriginal), 0x9004(DateTimeDigitized), 0x0132(DateTime)
        if (type === 2 && count >= 10 && (tag === 0x9003 || tag === 0x9004 || tag === 0x0132)) {
          const d = readAsciiTag(valOffset, count);
          if (d) {
            result[tag] = d;
          }
        }
      }
      return result;
    };

    const ifd0 = scanIfd(ifd0Pos);
    if (ifd0.exifIfdOffset) {
      const subIfd = scanIfd(tiffStart + ifd0.exifIfdOffset);
      if (subIfd[0x9003]) return subIfd[0x9003]; // DateTimeOriginal (撮影日を最優先)
      if (subIfd[0x9004]) return subIfd[0x9004]; // DateTimeDigitized
    }
    if (ifd0[0x9003]) return ifd0[0x9003];
    if (ifd0[0x0132]) return ifd0[0x0132]; // DateTime
    return null;
  }

  function parseExifDateFromBuffer(buffer) {
    if (!buffer || buffer.byteLength < 12) return null;
    const view = new DataView(buffer);

    // JPEG SOI (0xFFD8) の場合、APP1 (0xFFE1) セグメント内のExifを走査
    if (view.getUint16(0, false) === 0xffd8) {
      let offset = 2;
      const length = view.byteLength;

      while (offset + 4 <= length) {
        const marker = view.getUint16(offset, false);
        offset += 2;

        if (marker === 0xffda || marker === 0xffd9) break;
        if ((marker & 0xff00) !== 0xff00) break;

        const segLength = view.getUint16(offset, false);
        if (segLength < 2 || offset + segLength > length) break;

        if (
          marker === 0xffe1 &&
          segLength >= 14 &&
          view.getUint32(offset + 2, false) === 0x45786966 &&
          view.getUint16(offset + 6, false) === 0x0000
        ) {
          const tiffStart = offset + 8;
          const dateFromTiff = parseTiffExifDate(view, tiffStart, offset + segLength);
          if (dateFromTiff) return dateFromTiff;
        }

        offset += segLength;
      }
    }

    // XMP等のメタデータ文字列に DateTimeOriginal が含まれる場合のフォールバック
    try {
      const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
      let ascii = "";
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        ascii += c >= 32 && c <= 126 ? String.fromCharCode(c) : " ";
      }
      const xmpMatch = ascii.match(/DateTimeOriginal[>"=\s]+(\d{4}[:\-]\d{2}[:\-]\d{2})/);
      if (xmpMatch) {
        const parsed = parseExifDateString(xmpMatch[1]);
        if (parsed) return parsed;
      }
    } catch (e) {
      // 無視
    }

    return null;
  }

  function extractPhotoDateFromFile(file, callback) {
    const fallbackToLastModified = () => {
      if (file && typeof file.lastModified === "number" && file.lastModified > 0) {
        const d = formatDateObj(new Date(file.lastModified));
        if (d) return callback(d);
      }
      callback(formatDateObj(new Date()));
    };

    if (!file || typeof FileReader === "undefined") {
      return fallbackToLastModified();
    }

    try {
      const slice = file.slice(0, 131072); // 先頭128KBからEXIFを検査
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const exifDate = parseExifDateFromBuffer(e.target.result);
          if (exifDate) {
            return callback(exifDate);
          }
        } catch (err) {
          console.warn("EXIF撮影日の解析をスキップしました:", err);
        }
        fallbackToLastModified();
      };
      reader.onerror = function () {
        fallbackToLastModified();
      };
      reader.readAsArrayBuffer(slice);
    } catch (err) {
      fallbackToLastModified();
    }
  }

  function processUploadedImageFile(file, callback) {
    extractPhotoDateFromFile(file, function (capturedDate) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
          const canvas = document.createElement("canvas");
          const targetSize = 800;
          canvas.width = targetSize;
          canvas.height = targetSize;
          const ctx = canvas.getContext("2d");

          // 中央正方形トリミング計算（高精細800×800px）
          const minSide = Math.min(img.width, img.height);
          const sx = (img.width - minSide) / 2;
          const sy = (img.height - minSide) / 2;

          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, targetSize, targetSize);
          const compressedDataUrl = encodeCanvasHighQuality(canvas, 0.86);
          callback(compressedDataUrl, capturedDate);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ==========================================================================
  // 6. マス達成登録 ＆ ビンゴ／コンプリート判定
  // mode: "photo" (ユーザー写真) | "sketch" (写真なしスタンプ) | "dummy" (テスト画像)
  // ==========================================================================
  function registerCellPhoto(cellId, photoDataUrl, mode = "photo", customDate = null) {
    const found = findCellAndTown(cellId);
    if (!found) return;
    const { town } = found;

    // 登録前のビンゴ状態を記録
    const wasAlreadyCollected = Boolean(state.collectedCells[cellId]);
    const prevProgress = getTownProgress(town);
    const prevAchievedIds = new Set(state.achievedBingos[town.id] || []);
    prevProgress.activeLines.forEach((l) => prevAchievedIds.add(l.id));

    // 写真と採集日（時間なし・写真の撮影日があれば優先）を保存
    const formattedDate = customDate ? formatDateOnly(customDate) : formatDateObj(new Date());
    const isSketch = mode === "sketch";
    const isDummy = mode === "dummy";
    const hasPhoto = !isSketch && !isDummy && Boolean(photoDataUrl);

    state.collectedCells[cellId] = {
      photoDataUrl,
      capturedAt: formattedDate,
      mode: mode,
      isSketch: isSketch,
      isDummy: isDummy,
      hasPhoto: hasPhoto
    };

    // ユーザー写真は大容量のIndexedDBへ保存、スケッチ・ダミーの場合は不要な写真データをIndexedDBから削除
    if (hasPhoto) {
      idbPutPhoto(cellId, photoDataUrl);
    } else {
      idbDeletePhoto(cellId);
    }

    if (!wasAlreadyCollected) {
      unreadCompendiumCount += 1;
    }
    // 採集時はスポット名も自動開放
    state.unlockedHints[cellId] = true;

    // 登録後のビンゴ状態を計算
    const newProgress = getTownProgress(town);
    const newlyFormedLines = newProgress.activeLines.filter((l) => !prevAchievedIds.has(l.id));

    state.achievedBingos[town.id] = newProgress.activeLines.map((l) => l.id);
    lastAnimatedCellId = cellId;
    saveState();

    // UI全体を再描画
    renderAll();

    // モーダルを閉じる
    closeCellModal();

    // 9マスすべて埋まった場合は「COMPLETE!」特別演出、新規ライン成立時は「BINGO!」演出
    if (!prevProgress.isComplete && newProgress.isComplete) {
      setTimeout(() => {
        showCelebrationOverlay("COMPLETE", town, newProgress.activeLines);
      }, 320);
    } else if (newlyFormedLines.length > 0) {
      setTimeout(() => {
        showCelebrationOverlay("BINGO", town, newlyFormedLines);
      }, 320);
    }
  }

  function removeCellPhoto(cellId) {
    const found = findCellAndTown(cellId);
    if (!found) return;
    const { town } = found;

    delete state.collectedCells[cellId];
    idbDeletePhoto(cellId);
    if (unreadCompendiumCount > 0) {
      unreadCompendiumCount -= 1;
    }
    const updatedProgress = getTownProgress(town);
    state.achievedBingos[town.id] = updatedProgress.activeLines.map((l) => l.id);
    saveState();
    renderAll();
    openCellModal(cellId);
  }

  // ==========================================================================
  // 7. 画面描画：ヘッダー・ホーム（街セレクト画面）
  // ==========================================================================
  function renderHeaderAndStats() {
    const stats = getOverallStats();
    document.getElementById("header-total-count").textContent = stats.totalCollected;
    document.getElementById("home-stat-parts").textContent = `${stats.totalCollected} / ${stats.totalCells}`;
    document.getElementById("home-stat-bingos").textContent = `${stats.totalBingos} 本`;
    document.getElementById("home-stat-completes").textContent = `${stats.completedTowns} / ${stats.totalTowns}`;

    const sectionTitle = document.getElementById("home-area-section-title");
    if (sectionTitle) {
      sectionTitle.textContent = `探索エリアを選択（全国全${INITIAL_TOWNS.length}コース）`;
    }

    const badge = document.getElementById("nav-compendium-badge");
    if (unreadCompendiumCount > 0) {
      badge.style.display = "inline-block";
      badge.textContent = unreadCompendiumCount;
    } else {
      badge.style.display = "none";
    }
  }

  const MACRO_REGIONS = ["すべて", "北海道", "東北", "関東", "甲信越", "東海", "北陸", "近畿", "中国・四国", "九州"];

  function getFilteredTowns() {
    let list = INITIAL_TOWNS;
    if (activeRegionFilter !== "すべて") {
      list = list.filter((t) => (t.region_group || "関東") === activeRegionFilter);
      if (activeSubRegionFilter !== "すべて") {
        list = list.filter((t) => t.prefecture_group === activeSubRegionFilter);
      }
    }
    return list;
  }

  function renderRegionFilterBar(barElementId, subBarElementId) {
    const filterBar = document.getElementById(barElementId);
    if (!filterBar) return;

    filterBar.innerHTML = "";

    MACRO_REGIONS.forEach((reg) => {
      const count =
        reg === "すべて"
          ? INITIAL_TOWNS.length
          : INITIAL_TOWNS.filter((t) => (t.region_group || "関東") === reg).length;

      if (count === 0 && reg !== "すべて") return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `filter-chip ${activeRegionFilter === reg ? "active" : ""}`;
      btn.textContent = `${reg} (${count})`;
      btn.addEventListener("click", () => {
        activeRegionFilter = reg;
        activeSubRegionFilter = "すべて";
        renderHomeTownCards();
        renderTownSpecimenPlates();
      });
      filterBar.appendChild(btn);
    });

    // サブエリア（都道府県・エリア）フィルタの描画
    const subBar = subBarElementId ? document.getElementById(subBarElementId) : null;
    if (!subBar) return;

    if (activeRegionFilter === "すべて") {
      subBar.style.display = "none";
      subBar.innerHTML = "";
      return;
    }

    const townsInRegion = INITIAL_TOWNS.filter((t) => (t.region_group || "関東") === activeRegionFilter);
    const subGroups = [];
    townsInRegion.forEach((t) => {
      if (t.prefecture_group && !subGroups.includes(t.prefecture_group)) {
        subGroups.push(t.prefecture_group);
      }
    });

    if (subGroups.length <= 1) {
      subBar.style.display = "none";
      subBar.innerHTML = "";
      return;
    }

    subBar.style.display = "flex";
    subBar.innerHTML = "";

    const allSubOptions = ["すべて", ...subGroups];
    allSubOptions.forEach((sub) => {
      const count =
        sub === "すべて"
          ? townsInRegion.length
          : townsInRegion.filter((t) => t.prefecture_group === sub).length;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `filter-chip sub-chip ${activeSubRegionFilter === sub ? "active" : ""}`;
      btn.textContent = sub === "すべて" ? `${activeRegionFilter}すべて (${count})` : `${sub} (${count})`;
      btn.addEventListener("click", () => {
        activeSubRegionFilter = sub;
        renderHomeTownCards();
        renderTownSpecimenPlates();
      });
      subBar.appendChild(btn);
    });
  }

  function getAreaGoogleMapUrl(town) {
    const query = town.area_map_query || `${town.region} ${town.title}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function renderHomeTownCards() {
    renderRegionFilterBar("home-region-filters", "home-subregion-filters");
    const container = document.getElementById("town-cards-container");
    container.innerHTML = "";

    const filteredTowns = getFilteredTowns();

    filteredTowns.forEach((town) => {
      const prog = getTownProgress(town);
      const percent = Math.round((prog.clearedCount / prog.totalCells) * 100);
      const isSelected = town.id === state.selectedTownId;

      let statusLabel = "未着手";
      let statusClass = "";
      if (prog.isComplete) {
        statusLabel = "★ COMPLETE!";
        statusClass = "status-complete";
      } else if (prog.clearedCount > 0) {
        statusLabel = `探索中 (${prog.clearedCount}/9)`;
        statusClass = "status-active";
      }

      const regionTag = town.region_group
        ? `${town.region_group}・${town.prefecture_group}`
        : town.prefecture_group || "関東";
      const areaMapUrl = getAreaGoogleMapUrl(town);

      const card = document.createElement("article");
      card.className = `town-card ${isSelected ? "selected-town" : ""}`;
      card.innerHTML = `
        <div class="town-card-banner" style="background: ${town.theme_color || "var(--navy-base)"};">
          <div>
            <div class="town-banner-kicker">[${regionTag}] ${town.subtitle}</div>
            <h3 class="town-banner-title">${town.title}</h3>
          </div>
          <span class="town-status-stamp ${statusClass}">${statusLabel}</span>
        </div>
        <div class="town-card-body">
          <div class="town-meta-row">
            <span class="town-meta-chip">📍 ${town.region}</span>
            <span class="town-meta-chip">🏛️ ${town.era_focus}</span>
            <span class="town-meta-chip">⏱️ ${town.difficulty}</span>
          </div>
          <p class="town-description">${town.description}</p>
          <div class="town-progress-panel">
            <div class="town-progress-stats">
              <span>現在の達成状況</span>
              <div class="town-progress-Right">
                <span class="stat-pill-inline">クリアマス: <strong>${prog.clearedCount}</strong> / 9</span>
                <span class="stat-pill-inline">ビンゴ: <strong>${prog.bingoCount}</strong> 本</span>
              </div>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
          <div class="town-card-actions">
            <button type="button" class="btn-primary-expedition" data-start-town="${town.id}">
              <span>🧭 ${prog.clearedCount > 0 ? "この街の探索を再開する" : "この街でビンゴを始める"}</span>
              <span>▶</span>
            </button>
            <a
              href="${areaMapUrl}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn-card-map-link"
              title="この街の探索エリアをGoogleマップで開く"
            >
              <span>🗺️ 地図</span>
            </a>
          </div>
        </div>
      `;

      card.querySelector("[data-start-town]").addEventListener("click", () => {
        state.selectedTownId = town.id;
        saveState();
        renderAll();
        switchMainView("view-bingo");
      });

      container.appendChild(card);
    });
  }

  // ==========================================================================
  // 8. 画面描画：3×3 宝探しビンゴ画面（メイン画面）
  // ==========================================================================
  function renderBingoBoard() {
    const town = getTownById(state.selectedTownId);
    const prog = getTownProgress(town);

    document.getElementById("bingo-specimen-code").textContent = `SPECIMEN CARD: ${town.specimen_prefix}`;
    document.getElementById("bingo-town-title").textContent = town.title;
    document.getElementById("bingo-cleared-counter").textContent = `${prog.clearedCount} / ${prog.totalCells} マス`;
    document.getElementById("bingo-lines-counter").textContent = `${prog.bingoCount} 本 ${
      prog.isComplete ? "(COMPLETE!)" : ""
    }`;
    document.getElementById("bingo-status-summary-text").textContent = `${prog.bingoCount} / 8 LINES`;

    const stageMapBtn = document.getElementById("btn-stage-area-map");
    if (stageMapBtn) {
      stageMapBtn.href = getAreaGoogleMapUrl(town);
    }

    const gridEl = document.getElementById("bingo-grid");
    gridEl.innerHTML = "";

    town.cells.forEach((cell) => {
      const collected = state.collectedCells[cell.id];
      const inBingoLine = prog.cellsInBingoLines.has(cell.id);
      const isJustCleared = lastAnimatedCellId === cell.id;

      const cellEl = document.createElement("div");
      cellEl.className = [
        "bingo-cell",
        collected ? "cleared" : "uncleared",
        inBingoLine ? "in-bingo-line" : "",
        isJustCleared ? "just-cleared" : ""
      ]
        .filter(Boolean)
        .join(" ");
      cellEl.setAttribute("role", "gridcell");
      cellEl.setAttribute("tabindex", "0");
      cellEl.setAttribute("aria-label", `マス${cell.position}: ${cell.title}`);

      const numCode = `#0${cell.position}`;

      if (collected) {
        const isSketch = Boolean(collected.isSketch || collected.mode === "sketch");
        const stampText = isSketch ? "✒️ 発見済" : "📷 採集済";
        const stampExtraClass = isSketch ? "sketch-stamp" : "";

        // 達成マス：登録写真またはスケッチ標本画を全面表示＋クリア済みスタンプ演出
        cellEl.innerHTML = `
          <img class="cell-captured-photo" src="${collected.photoDataUrl}" alt="${cell.title}" />
          <div class="cell-cleared-overlay">
            <span class="cell-cleared-number">${numCode}</span>
            <div class="cell-cleared-title">${cell.title}</div>
          </div>
          <div class="collected-wax-stamp ${stampExtraClass}">${stampText}</div>
        `;
      } else {
        // 未達成マス：マスのタイトル＋切り抜き風プレビュー枠（建築パーツシルエット＋crop_targetバッジ）
        cellEl.innerHTML = `
          <div class="cell-top-meta">
            <span class="cell-number">${numCode}</span>
            <span class="cell-era-dot">${cell.category}</span>
          </div>
          <div class="cell-crop-viewfinder">
            <div class="cell-silhouette-icon">
              ${getArchitecturalSilhouetteSVG(cell.icon_type, 26)}
            </div>
            <div class="cell-crop-badge" title="${cell.crop_target}">
              🎯 ${cell.crop_target}
            </div>
          </div>
          <div class="cell-title-bar">${cell.title}</div>
        `;
      }

      cellEl.addEventListener("click", () => {
        openCellModal(cell.id);
      });

      gridEl.appendChild(cellEl);
    });

    // アニメーションフラグをクリア
    lastAnimatedCellId = null;

    // 8ラインバッジ一覧の描画
    const badgesWrap = document.getElementById("bingo-badges-container");
    badgesWrap.innerHTML = "";
    const activeIds = new Set(prog.activeLines.map((l) => l.id));

    BINGO_LINES.forEach((line) => {
      const achieved = activeIds.has(line.id);
      const badge = document.createElement("span");
      badge.className = `bingo-line-badge ${achieved ? "achieved" : ""}`;
      badge.innerHTML = `${achieved ? "★" : "○"} ${line.label}`;
      badgesWrap.appendChild(badge);
    });
  }

  // ==========================================================================
  // 9. マス詳細モーダル（段階的ヒント・Google Map ポイント表示・カメラ起動）
  // ==========================================================================
  function getCellGoogleMapExternalUrl(cell, useSpotQuery) {
    if (useSpotQuery || typeof cell.lat !== "number" || typeof cell.lng !== "number") {
      const q = cell.map_query || cell.spot_name;
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${cell.lat},${cell.lng}`;
  }

  function getCellGoogleMapEmbedUrl(cell, mode) {
    if (mode === "spot" || typeof cell.lat !== "number" || typeof cell.lng !== "number") {
      const q = cell.map_query || cell.spot_name;
      return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&hl=ja&z=17&output=embed`;
    }
    return `https://maps.google.com/maps?q=${cell.lat},${cell.lng}&ll=${cell.lat},${cell.lng}&hl=ja&z=17&output=embed`;
  }

  function updateModalMapUI(cell, hintUnlocked) {
    const coordsEl = document.getElementById("modal-cell-coords");
    if (coordsEl) {
      if (typeof cell.lat === "number" && typeof cell.lng === "number") {
        coordsEl.textContent = `${cell.lat.toFixed(4)}°N, ${cell.lng.toFixed(4)}°E`;
      } else {
        coordsEl.textContent = "MAP POINT";
      }
    }

    const hintMapLink = document.getElementById("link-hint-google-map");
    if (hintMapLink) {
      hintMapLink.href = getCellGoogleMapExternalUrl(cell, hintUnlocked || inlineMapPinMode === "spot");
    }

    const spotMapLink = document.getElementById("link-spot-google-map");
    if (spotMapLink) {
      spotMapLink.href = getCellGoogleMapExternalUrl(cell, true);
      spotMapLink.innerHTML = `<span>🗺️ Google マップで「${cell.spot_name}」の詳細・経路を見る ↗</span>`;
    }

    const toggleLabel = document.getElementById("btn-toggle-inline-map-label");
    const mapWrap = document.getElementById("modal-inline-map-wrap");
    const frameBox = document.getElementById("modal-inline-map-frame-box");
    const captionEl = document.getElementById("inline-map-caption");
    const modeSwitchBtn = document.getElementById("btn-switch-map-pin-mode");

    if (!mapWrap || !frameBox) return;

    if (inlineMapVisible) {
      mapWrap.style.display = "block";
      if (toggleLabel) toggleLabel.textContent = "🗺️ マップ表示を閉じる ▲";
      const embedUrl = getCellGoogleMapEmbedUrl(cell, inlineMapPinMode);
      const currentIframe = frameBox.querySelector("iframe");
      if (!currentIframe || currentIframe.getAttribute("data-src") !== embedUrl) {
        frameBox.innerHTML = `<iframe src="${embedUrl}" data-src="${embedUrl}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${cell.title} 地図"></iframe>`;
      }
      if (captionEl) {
        captionEl.textContent =
          inlineMapPinMode === "spot"
            ? `🏛️ 対象スポット: ${cell.spot_name}`
            : `📍 ヒント地点 (${cell.lat ? cell.lat.toFixed(4) : ""}, ${cell.lng ? cell.lng.toFixed(4) : ""})`;
      }
      if (modeSwitchBtn) {
        modeSwitchBtn.innerHTML =
          inlineMapPinMode === "spot"
            ? "<span>📍 座標ピンに切替</span>"
            : "<span>🏛️ 建物名ピンに切替</span>";
      }
    } else {
      mapWrap.style.display = "none";
      if (toggleLabel) toggleLabel.textContent = "🗺️ この場でマップポイントを見る ▼";
      frameBox.innerHTML = "";
    }
  }

  function openCellModal(cellId) {
    const found = findCellAndTown(cellId);
    if (!found) return;
    const { cell, town } = found;
    const wasModalOpen = Boolean(activeModalCellId);
    activeModalCellId = cellId;

    const collected = state.collectedCells[cell.id];
    const hintUnlocked = Boolean(state.unlockedHints[cell.id]) || Boolean(collected);

    // モーダルを開いた時は、すでにヒント2開放済みならスポット名ピン、未開放なら座標ピンを初期モードにする
    inlineMapVisible = false;
    inlineMapPinMode = hintUnlocked ? "spot" : "coords";

    document.getElementById("modal-cell-code").textContent = `${town.specimen_prefix}-0${cell.position}`;
    document.getElementById("modal-cell-category").textContent = cell.category;
    document.getElementById("modal-cell-subcategory").textContent = cell.sub_category;
    document.getElementById("modal-cell-title").textContent = cell.title;
    document.getElementById("modal-crop-target").textContent = cell.crop_target;

    // プレビュー枠
    const frameEl = document.getElementById("modal-photo-frame");
    const isSketch = Boolean(collected && (collected.isSketch || collected.mode === "sketch"));

    if (collected) {
      const dateStr = formatDateOnly(collected.capturedAt);
      const badgeLabel = isSketch
        ? `✒️ 現地発見スタンプ済 (${dateStr})`
        : `📷 写真採集済 (${dateStr})`;
      const badgeExtraClass = isSketch ? "sketch-stamp" : "";

      frameEl.innerHTML = `
        <img src="${collected.photoDataUrl}" alt="${cell.title}" />
        <div class="collected-wax-stamp ${badgeExtraClass}" style="top: 12px; right: 12px; font-size: 0.75rem; padding: 4px 10px;">
          ${badgeLabel}
        </div>
      `;
    } else {
      frameEl.innerHTML = `
        <div style="color: var(--navy-base); opacity: 0.85; margin-bottom: 8px;">
          ${getArchitecturalSilhouetteSVG(cell.icon_type, 64)}
        </div>
        <div style="font-family: var(--font-serif); font-size: 0.85rem; font-weight: 700; color: var(--navy-base);">
          【未採集パーツ】現地で実物を探そう（写真は任意）
        </div>
        <div style="font-size: 0.74rem; color: var(--ink-muted); margin-top: 4px; text-align: center; padding: 0 12px;">
          撮影できない場所でも「写真なしで採集スタンプ」でクリアできます
        </div>
      `;
    }

    // 段階的ヒント設定
    document.getElementById("modal-hint-1").textContent = cell.hint_level_1;
    document.getElementById("modal-hint-2").textContent = cell.hint_level_2;
    document.getElementById("modal-spot-name").textContent = `${cell.spot_name}（${cell.built_year}）`;
    document.getElementById("modal-architect-note").textContent = cell.architect_note;

    const unlockBtn = document.getElementById("btn-unlock-hint-2");
    const unlockedSection = document.getElementById("modal-unlocked-section");

    if (hintUnlocked) {
      unlockBtn.style.display = "none";
      unlockedSection.style.display = "block";
    } else {
      unlockBtn.style.display = "flex";
      unlockedSection.style.display = "none";
    }

    // Google マップ連携パネルを更新
    updateModalMapUI(cell, hintUnlocked);

    // ボタンラベル調整（写真なしスタンプボタン ／ 保存済み写真ボタン ／ カメラ撮影ボタン）
    const stampOnlyBtn = document.getElementById("btn-stamp-only-clear");
    const stampOnlyLabel = document.getElementById("btn-stamp-only-label");
    const albumLabel = document.getElementById("btn-trigger-album-label");
    const cameraLabel = document.getElementById("btn-trigger-camera-label");
    const resetBtn = document.getElementById("btn-reset-cell");

    if (!collected) {
      stampOnlyBtn.style.display = "flex";
      stampOnlyLabel.textContent = "✒️ 発見！写真なしで採集スタンプを押す";
      if (albumLabel) albumLabel.textContent = "保存済み写真・アルバムから選ぶ";
      cameraLabel.textContent = "カメラで今すぐ撮影する";
      resetBtn.style.display = "none";
    } else if (isSketch) {
      stampOnlyBtn.style.display = "none";
      if (albumLabel) albumLabel.textContent = "保存済み写真・アルバムから追加";
      cameraLabel.textContent = "カメラで撮影して追加";
      resetBtn.style.display = "inline-block";
    } else {
      stampOnlyBtn.style.display = "flex";
      stampOnlyLabel.textContent = "✒️ 写真なしのスケッチ標本に切り替える";
      if (albumLabel) albumLabel.textContent = "別の保存済み写真に変更";
      cameraLabel.textContent = "カメラで撮り直す";
      resetBtn.style.display = "inline-block";
    }

    // アプリ内で過去に保存・登録した写真履歴一覧を描画
    const historyBox = document.getElementById("modal-photo-history-box");
    const historyList = document.getElementById("modal-photo-history-list");
    if (historyBox && historyList) {
      const savedPhotos = [];
      const seenUrls = new Set();
      Object.entries(state.collectedCells).forEach(([cid, rec]) => {
        if (isPhotoRegistered(rec)) {
          if (!seenUrls.has(rec.photoDataUrl)) {
            seenUrls.add(rec.photoDataUrl);
            const info = findCellAndTown(cid);
            savedPhotos.push({
              photoDataUrl: rec.photoDataUrl,
              capturedAt: formatDateOnly(rec.capturedAt),
              label: info ? info.cell.title : cid
            });
          }
        }
      });

      if (savedPhotos.length > 0) {
        historyBox.style.display = "block";
        historyList.innerHTML = "";
        savedPhotos.forEach((item) => {
          const thumbBtn = document.createElement("button");
          thumbBtn.type = "button";
          thumbBtn.className = "photo-history-thumb";
          thumbBtn.title = `「${item.label}」の保存済み写真をこのマスに設定`;
          thumbBtn.innerHTML = `<img src="${item.photoDataUrl}" alt="${item.label}" />`;
          thumbBtn.addEventListener("click", () => {
            registerCellPhoto(cell.id, item.photoDataUrl, "photo", item.capturedAt);
          });
          historyList.appendChild(thumbBtn);
        });
      } else {
        historyBox.style.display = "none";
      }
    }

    document.getElementById("cell-modal-backdrop").classList.add("open");
    if (!wasModalOpen) {
      pushBrowserHistoryEntry({ view: currentViewId, modal: cellId });
    }
  }

  function closeCellModal() {
    document.getElementById("cell-modal-backdrop").classList.remove("open");
    const frameBox = document.getElementById("modal-inline-map-frame-box");
    if (frameBox) frameBox.innerHTML = "";
    inlineMapVisible = false;
    activeModalCellId = null;
  }

  // ==========================================================================
  // 10. コレクション図鑑画面（街タイル図鑑 ＆ ディテールパーツ図鑑）
  // ==========================================================================
  function renderCompendium() {
    renderTownSpecimenPlates();
    renderDetailPartsCatalog();
  }

  // 10-A. 街タイル図鑑（収集済みの街標本カード）
  function renderTownSpecimenPlates() {
    renderRegionFilterBar("tiles-region-filters", "tiles-subregion-filters");
    const container = document.getElementById("specimen-plates-container");
    container.innerHTML = "";

    const filteredTowns = getFilteredTowns();

    filteredTowns.forEach((town) => {
      const prog = getTownProgress(town);
      const plate = document.createElement("article");
      plate.className = `specimen-plate-card ${prog.isComplete ? "is-complete" : ""}`;

      const mosaicCellsHtml = town.cells
        .map((cell) => {
          const item = state.collectedCells[cell.id];
          if (item) {
            return `<div class="plate-mosaic-cell" data-open-cell="${cell.id}" style="cursor:pointer;" title="${cell.title}">
              <img src="${item.photoDataUrl}" alt="${cell.title}" />
            </div>`;
          }
          return `<div class="plate-mosaic-cell" data-open-cell="${cell.id}" style="cursor:pointer;" title="未採集: ${cell.title}">
            <span class="plate-mosaic-empty">#0${cell.position}</span>
          </div>`;
        })
        .join("");

      plate.innerHTML = `
        <div class="plate-header">
          <div>
            <div class="plate-code">ARCHIVE PLATE // ${town.specimen_prefix}</div>
            <h3 class="plate-title">${town.title}</h3>
          </div>
          <span class="town-status-stamp ${prog.isComplete ? "status-complete" : "status-active"}">
            ${prog.isComplete ? "★ COMPLETE 標本完成" : `収集率 ${prog.clearedCount} / 9`}
          </span>
        </div>

        <div class="plate-mosaic-grid">
          ${mosaicCellsHtml}
        </div>

        <div class="plate-footer">
          <span>達成ビンゴライン: <strong style="color: var(--brass-light);">${prog.bingoCount} 本</strong></span>
          <span>エリア: ${town.region}</span>
          <div class="plate-actions">
            <button type="button" class="btn-plate-action" data-goto-town="${town.id}">
              <span>🧭 ビンゴ盤面を開く</span>
            </button>
            <button type="button" class="btn-plate-action primary" data-download-plate="${town.id}">
              <span>🖼️ 記念標本シートを保存</span>
            </button>
          </div>
        </div>
      `;

      plate.querySelectorAll("[data-open-cell]").forEach((el) => {
        el.addEventListener("click", () => {
          openCellModal(el.getAttribute("data-open-cell"));
        });
      });

      plate.querySelector("[data-goto-town]").addEventListener("click", () => {
        state.selectedTownId = town.id;
        saveState();
        renderAll();
        switchMainView("view-bingo");
      });

      plate.querySelector("[data-download-plate]").addEventListener("click", () => {
        exportCommemorativeSheet(town);
      });

      container.appendChild(plate);
    });
  }

  // 街タイル1枚の記念標本シート画像をCanvasで合成してダウンロード
  function exportCommemorativeSheet(town) {
    const canvas = document.createElement("canvas");
    const W = 900;
    const H = 1120;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    // 背景（ダークネイビー×ゴールドフレーム）
    ctx.fillStyle = "#111927";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#B5893E";
    ctx.lineWidth = 4;
    ctx.strokeRect(24, 24, W - 48, H - 48);

    ctx.strokeStyle = "rgba(217, 182, 108, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(34, 34, W - 68, H - 68);

    // タイトルヘッダー
    ctx.fillStyle = "#D9B66C";
    ctx.font = "bold 18px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText(`ARCHITECTURAL SPECIMEN CARD // ${town.subtitle}`, W / 2, 78);

    ctx.fillStyle = "#FAF6EE";
    ctx.font = "bold 34px 'Shippori Mincho', serif";
    ctx.fillText(town.title, W / 2, 124);

    const prog = getTownProgress(town);
    ctx.fillStyle = "#C2B295";
    ctx.font = "18px sans-serif";
    ctx.fillText(
      `${town.region} ｜ 採集数: ${prog.clearedCount}/9 ｜ ビンゴ: ${prog.bingoCount}ライン`,
      W / 2,
      160
    );

    // 3x3 グリッド描画処理（非同期画像ロード）
    const gridStartX = 75;
    const gridStartY = 195;
    const cellSize = 238;
    const gap = 18;

    const loadPromises = town.cells.map((cell, idx) => {
      return new Promise((resolve) => {
        const col = idx % 3;
        const row = Math.floor(idx / 3);
        const x = gridStartX + col * (cellSize + gap);
        const y = gridStartY + row * (cellSize + gap);

        const item = state.collectedCells[cell.id];
        if (item && item.photoDataUrl) {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, x, y, cellSize, cellSize);
            ctx.fillStyle = "rgba(17, 25, 39, 0.78)";
            ctx.fillRect(x, y + cellSize - 36, cellSize, 36);
            ctx.fillStyle = "#FAF6EE";
            ctx.font = "bold 14px serif";
            ctx.textAlign = "center";
            ctx.fillText(cell.title, x + cellSize / 2, y + cellSize - 13);
            ctx.strokeStyle = "#B5893E";
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, cellSize, cellSize);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = item.photoDataUrl;
        } else {
          ctx.fillStyle = "#1B263B";
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.strokeStyle = "rgba(181, 137, 62, 0.5)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, cellSize, cellSize);
          ctx.fillStyle = "#D9B66C";
          ctx.font = "bold 18px monospace";
          ctx.textAlign = "center";
          ctx.fillText(`#0${cell.position} UNCOLLECTED`, x + cellSize / 2, y + cellSize / 2 - 8);
          ctx.fillStyle = "#C2B295";
          ctx.font = "14px serif";
          ctx.fillText(cell.title, x + cellSize / 2, y + cellSize / 2 + 20);
          resolve();
        }
      });
    });

    Promise.all(loadPromises).then(() => {
      // フッター署名
      ctx.fillStyle = "#D9B66C";
      ctx.font = "16px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText("TOWN ARCHITECTURE BINGO — FIELD EXPEDITION ARCHIVE", W / 2, H - 58);

      const link = document.createElement("a");
      link.download = `specimen_${town.id}.jpg`;
      link.href = canvas.toDataURL("image/jpeg", 0.9);
      link.click();
    });
  }

  // 10-B. ディテールパーツ図鑑（写真登録した個別パーツ一覧）
  function renderDetailPartsCatalog() {
    const filterBar = document.getElementById("parts-category-filters");
    const catalogContainer = document.getElementById("parts-catalog-container");

    // 写真登録済みパーツのみ抽出（写真なしスタンプやテスト用ダミーは表示しない）
    const collectedEntries = [];
    INITIAL_TOWNS.forEach((town) => {
      town.cells.forEach((cell) => {
        const record = state.collectedCells[cell.id];
        if (isPhotoRegistered(record)) {
          collectedEntries.push({
            cell,
            town,
            record
          });
        }
      });
    });

    // カテゴリ一覧
    const categories = ["すべて"];
    INITIAL_TOWNS.forEach((town) => {
      town.cells.forEach((cell) => {
        if (!categories.includes(cell.category)) {
          categories.push(cell.category);
        }
      });
    });

    filterBar.innerHTML = "";
    categories.forEach((cat) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `filter-chip ${activePartsCategory === cat ? "active" : ""}`;
      chip.textContent = cat;
      chip.addEventListener("click", () => {
        activePartsCategory = cat;
        renderDetailPartsCatalog();
      });
      filterBar.appendChild(chip);
    });

    const filtered =
      activePartsCategory === "すべて"
        ? collectedEntries
        : collectedEntries.filter((item) => item.cell.category === activePartsCategory);

    if (filtered.length === 0) {
      catalogContainer.innerHTML = `
        <div class="empty-catalog-state">
          <div style="font-size: 2rem; margin-bottom: 8px;">🔍</div>
          <h3 style="font-family: var(--font-serif); color: var(--navy-base); margin-bottom: 6px;">
            ${
              collectedEntries.length === 0
                ? "まだ写真登録された建築パーツがありません"
                : `「${activePartsCategory}」の写真登録パーツはまだありません`
            }
          </h3>
          <p style="font-size: 0.8rem; line-height: 1.6; margin-bottom: 14px;">
            「3×3 ビンゴ探索」画面でマスをタップし、カメラで撮影した写真やアルバムの写真を登録すると、ここにディテール標本が並びます（※写真なしのスタンプのみのマスは表示されません）。
          </p>
          <button type="button" class="btn-primary-expedition" id="btn-empty-goto-bingo" style="max-width: 240px; margin: 0 auto;">
            <span>🧭 3×3 ビンゴ探索へ行く</span>
          </button>
        </div>
      `;
      const gotoBtn = document.getElementById("btn-empty-goto-bingo");
      if (gotoBtn) {
        gotoBtn.addEventListener("click", () => switchMainView("view-bingo"));
      }
      return;
    }

    const grid = document.createElement("div");
    grid.className = "parts-catalog-grid";

    filtered.forEach(({ cell, town, record }) => {
      const card = document.createElement("article");
      card.className = "part-specimen-card";
      card.innerHTML = `
        <div class="part-photo-wrap">
          <img src="${record.photoDataUrl}" alt="${cell.title}" />
          <span class="part-category-ribbon">${cell.category}</span>
        </div>
        <div class="part-card-body">
          <div>
            <div style="font-family: var(--font-mono); font-size: 0.62rem; color: var(--brass-dark); margin-bottom: 2px;">
              ${town.specimen_prefix}-0${cell.position} ｜ 📷 写真標本
            </div>
            <h4 class="part-card-title">${cell.title}</h4>
            <p class="part-card-spot">📍 ${cell.spot_name}</p>
          </div>
          <div class="part-card-date">
            <span>採集日</span>
            <span>${formatDateOnly(record.capturedAt)}</span>
          </div>
        </div>
      `;
      card.addEventListener("click", () => {
        openCellModal(cell.id);
      });
      grid.appendChild(card);
    });

    catalogContainer.innerHTML = "";
    catalogContainer.appendChild(grid);
  }

  // ==========================================================================
  // 11. BINGO! & COMPLETE! 祝福演出オーバーレイと紙吹雪アニメーション
  // ==========================================================================
  function showCelebrationOverlay(mode, town, lines) {
    const overlay = document.getElementById("celebration-overlay");
    const medallion = document.getElementById("celebration-medallion");
    const kicker = document.getElementById("celebration-kicker");
    const headline = document.getElementById("celebration-headline");
    const desc = document.getElementById("celebration-desc");
    const pillsWrap = document.getElementById("celebration-pills");

    pillsWrap.innerHTML = "";

    if (mode === "COMPLETE") {
      medallion.textContent = "完";
      kicker.textContent = "GRAND ARCHITECTURAL ARCHIVE";
      headline.textContent = "COMPLETE!";
      desc.textContent = `おめでとうございます！「${town.title}」の全9マスを採集し、街標本カードが完全コンプリートしました！`;
      const pill = document.createElement("span");
      pill.className = "celebration-pill";
      pill.textContent = "👑 全9パーツ＆全8ライン完全制覇";
      pillsWrap.appendChild(pill);
    } else {
      medallion.textContent = "祝";
      kicker.textContent = "LINE ACHIEVED";
      headline.textContent = "BINGO!";
      desc.textContent = `「${town.title}」で新たなビンゴラインが成立しました！この調子で残りの建築パーツも採集しましょう。`;
      lines.forEach((line) => {
        const pill = document.createElement("span");
        pill.className = "celebration-pill";
        pill.textContent = `★ ${line.label}`;
        pillsWrap.appendChild(pill);
      });
    }

    overlay.classList.add("active");
    pushBrowserHistoryEntry({ view: currentViewId, celebration: true });
    startConfettiAnimation();
  }

  function closeCelebrationOverlay() {
    const overlay = document.getElementById("celebration-overlay");
    overlay.classList.remove("active");
    stopConfettiAnimation();
  }

  function startConfettiAnimation() {
    stopConfettiAnimation();
    const canvas = document.getElementById("confetti-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ["#D9B66C", "#B5893E", "#9E2A2B", "#FAF6EE", "#5C80BC"];
    const particles = Array.from({ length: 85 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: 7 + Math.random() * 6,
      h: 10 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: 2.2 + Math.random() * 3.5,
      vx: (Math.random() - 0.5) * 2.2,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.14
    }));

    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        if (p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      confettiAnimId = requestAnimationFrame(frame);
    }

    confettiAnimId = requestAnimationFrame(frame);
  }

  function stopConfettiAnimation() {
    if (confettiAnimId) {
      cancelAnimationFrame(confettiAnimId);
      confettiAnimId = null;
    }
  }

  // ==========================================================================
  // 12. ビュー切り替え・スマホのバックボタン（History API）対応・イベント設定
  // ==========================================================================
  function pushBrowserHistoryEntry(meta) {
    if (typeof history === "undefined" || typeof history.pushState !== "function") return;
    try {
      history.pushState(Object.assign({ app: "town_bingo" }, meta || {}), "");
      hasHistoryGuard = true;
    } catch (err) {
      // ローカル環境等で制限される場合は無視
    }
  }

  function initHistoryNavigation() {
    if (typeof history === "undefined" || typeof history.replaceState !== "function") return;
    try {
      history.replaceState({ app: "town_bingo", root: true, view: "view-home" }, "");
    } catch (err) {
      // 無視
    }

    // ユーザーの初回操作時にトップ画面用の履歴ガードを1件積む（スマホブラウザのUser Activation要件対応）
    const ensureInitialGuard = () => {
      if (!hasHistoryGuard) {
        pushBrowserHistoryEntry({ view: currentViewId, guard: true });
      }
    };
    window.addEventListener("pointerdown", ensureInitialGuard, { once: true, passive: true });
    window.addEventListener("touchstart", ensureInitialGuard, { once: true, passive: true });

    window.addEventListener("popstate", () => {
      // 1. 祝福オーバーレイ表示中ならオーバーレイを閉じる
      const celebrationOverlay = document.getElementById("celebration-overlay");
      if (celebrationOverlay && celebrationOverlay.classList.contains("active")) {
        closeCelebrationOverlay();
        pushBrowserHistoryEntry({ view: currentViewId, guard: true });
        return;
      }

      // 2. マス詳細モーダルが開いていればモーダルを閉じる
      if (activeModalCellId) {
        closeCellModal();
        pushBrowserHistoryEntry({ view: currentViewId, guard: true });
        return;
      }

      // 3. トップ（ホーム・街選択画面）ならページ遷移はしない
      if (currentViewId === "view-home") {
        pushBrowserHistoryEntry({ view: "view-home", guard: true });
        return;
      }

      // 4. サブ画面（ビンゴ探索・コレクション図鑑）なら直前の画面またはトップへ戻る
      const prevView = viewHistoryStack.length > 0 ? viewHistoryStack.pop() : "view-home";
      switchMainView(prevView, { fromHistory: true });
      pushBrowserHistoryEntry({ view: currentViewId, guard: true });
    });
  }

  function switchMainView(targetViewId, options = {}) {
    if (targetViewId === "view-compendium") {
      unreadCompendiumCount = 0;
      const badge = document.getElementById("nav-compendium-badge");
      if (badge) badge.style.display = "none";
    }

    if (targetViewId === "view-home") {
      // トップに戻った場合は履歴スタックをクリアし、トップからさらに戻る遷移が起きないようにする
      viewHistoryStack = [];
    } else if (!options.fromHistory && targetViewId !== currentViewId) {
      viewHistoryStack.push(currentViewId);
      pushBrowserHistoryEntry({ view: targetViewId });
    }

    currentViewId = targetViewId;

    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.toggle("active", sec.id === targetViewId);
    });
    document.querySelectorAll(".nav-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-target") === targetViewId);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function switchCompendiumSubtab(subtab) {
    const isTiles = subtab === "tiles";
    document.getElementById("subtab-btn-tiles").classList.toggle("active", isTiles);
    document.getElementById("subtab-btn-parts").classList.toggle("active", !isTiles);
    document.getElementById("compendium-tiles-panel").style.display = isTiles ? "block" : "none";
    document.getElementById("compendium-parts-panel").style.display = isTiles ? "none" : "block";
  }

  function renderAll() {
    renderHeaderAndStats();
    renderHomeTownCards();
    renderBingoBoard();
    renderCompendium();
  }

  function initEvents() {
    initHistoryNavigation();

    // ボトムナビゲーション切り替え
    document.querySelectorAll(".nav-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchMainView(btn.getAttribute("data-target"));
      });
    });

    // ヘッダーロゴでホームへ
    document.getElementById("header-brand-home").addEventListener("click", () => {
      switchMainView("view-home");
    });

    // ビンゴ画面から街選択へ戻る
    document.getElementById("btn-back-to-home").addEventListener("click", () => {
      switchMainView("view-home");
    });

    // ビンゴ画面から標本図鑑へ
    document.getElementById("btn-view-in-compendium").addEventListener("click", () => {
      switchMainView("view-compendium");
    });

    // 図鑑サブタブ切り替え
    document.querySelectorAll(".compendium-subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchCompendiumSubtab(btn.getAttribute("data-subtab"));
      });
    });

    // モーダル閉じる
    document.getElementById("btn-close-cell-modal").addEventListener("click", closeCellModal);
    document.getElementById("cell-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "cell-modal-backdrop") closeCellModal();
    });

    // 段階的ヒント開放ボタン（Hint Level 2 & Spot Name 開放）
    document.getElementById("btn-unlock-hint-2").addEventListener("click", () => {
      if (!activeModalCellId) return;
      state.unlockedHints[activeModalCellId] = true;
      saveState();
      document.getElementById("btn-unlock-hint-2").style.display = "none";
      document.getElementById("modal-unlocked-section").style.display = "block";
      const found = findCellAndTown(activeModalCellId);
      if (found) {
        inlineMapPinMode = "spot";
        updateModalMapUI(found.cell, true);
      }
    });

    // ヒント地点のGoogleマップをモーダル内で開閉するボタン
    const toggleMapBtn = document.getElementById("btn-toggle-inline-map");
    if (toggleMapBtn) {
      toggleMapBtn.addEventListener("click", () => {
        if (!activeModalCellId) return;
        const found = findCellAndTown(activeModalCellId);
        if (!found) return;
        inlineMapVisible = !inlineMapVisible;
        const hintUnlocked = Boolean(state.unlockedHints[activeModalCellId]) || Boolean(state.collectedCells[activeModalCellId]);
        updateModalMapUI(found.cell, hintUnlocked);
      });
    }

    // マップピン表示モード切替（座標ピン ⇔ 建物名ピン）
    const switchMapModeBtn = document.getElementById("btn-switch-map-pin-mode");
    if (switchMapModeBtn) {
      switchMapModeBtn.addEventListener("click", () => {
        if (!activeModalCellId) return;
        const found = findCellAndTown(activeModalCellId);
        if (!found) return;
        inlineMapPinMode = inlineMapPinMode === "coords" ? "spot" : "coords";
        const hintUnlocked = Boolean(state.unlockedHints[activeModalCellId]) || Boolean(state.collectedCells[activeModalCellId]);
        updateModalMapUI(found.cell, hintUnlocked);
      });
    }

    // 写真なしで発見・採集スタンプを押すボタン
    document.getElementById("btn-stamp-only-clear").addEventListener("click", () => {
      if (!activeModalCellId) return;
      const found = findCellAndTown(activeModalCellId);
      if (!found) return;
      const sketchUrl = generateFieldSketchSpecimen(found.cell, found.town);
      registerCellPhoto(activeModalCellId, sketchUrl, "sketch");
    });

    // 端末の保存済み写真・アルバム選択ボタン（capture属性なし）
    const albumInput = document.getElementById("album-file-input");
    const triggerAlbumBtn = document.getElementById("btn-trigger-album");
    if (triggerAlbumBtn && albumInput) {
      triggerAlbumBtn.addEventListener("click", () => {
        albumInput.value = "";
        albumInput.click();
      });

      albumInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file || !activeModalCellId) return;
        const targetCellId = activeModalCellId;
        processUploadedImageFile(file, (dataUrl, capturedDate) => {
          registerCellPhoto(targetCellId, dataUrl, "photo", capturedDate);
        });
      });
    }

    // カメラ直接起動ボタン（capture="environment"）
    const fileInput = document.getElementById("camera-file-input");
    document.getElementById("btn-trigger-camera").addEventListener("click", () => {
      fileInput.value = "";
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !activeModalCellId) return;
      const targetCellId = activeModalCellId;
      processUploadedImageFile(file, (dataUrl, capturedDate) => {
        registerCellPhoto(targetCellId, dataUrl, "photo", capturedDate);
      });
    });

    // テスト用ダミー画像でクリアにするボタン
    document.getElementById("btn-debug-dummy-clear").addEventListener("click", () => {
      if (!activeModalCellId) return;
      const found = findCellAndTown(activeModalCellId);
      if (!found) return;
      const dummyUrl = generateDummyArchitecturalPhoto(found.cell, found.town);
      registerCellPhoto(activeModalCellId, dummyUrl, "dummy");
    });

    // 登録写真の削除ボタン
    document.getElementById("btn-reset-cell").addEventListener("click", () => {
      if (!activeModalCellId) return;
      removeCellPhoto(activeModalCellId);
    });

    // 祝福オーバーレイのボタン
    document.getElementById("btn-celebration-continue").addEventListener("click", () => {
      closeCelebrationOverlay();
    });

    document.getElementById("btn-celebration-compendium").addEventListener("click", () => {
      closeCelebrationOverlay();
      switchMainView("view-compendium");
    });

    // バックアップ書き出し（JSONファイルダウンロード）
    const exportBtn = document.getElementById("btn-export-backup");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const backupPayload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          data: state
        };
        const blob = new Blob([JSON.stringify(backupPayload)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        a.href = url;
        a.download = `town_bingo_backup_${dateStr}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // バックアップ復元（JSONファイル読み込み・既存データとマージ）
    const importBtn = document.getElementById("btn-import-backup");
    const backupInput = document.getElementById("backup-file-input");
    if (importBtn && backupInput) {
      importBtn.addEventListener("click", () => {
        backupInput.value = "";
        backupInput.click();
      });

      backupInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result);
            const incoming = parsed.data || parsed;
            if (!incoming || typeof incoming !== "object") {
              throw new Error("Invalid format");
            }
            const incomingCells = {};
            if (incoming.collectedCells && typeof incoming.collectedCells === "object") {
              Object.keys(incoming.collectedCells).forEach((cid) => {
                const rec = incoming.collectedCells[cid];
                if (rec && typeof rec === "object") {
                  incomingCells[cid] = Object.assign({}, rec, {
                    capturedAt: formatDateOnly(rec.capturedAt)
                  });
                }
              });
            }
            // 既存の採集記録を保ちつつバックアップデータを統合（写真データはIndexedDBへも移行）
            state.unlockedHints = Object.assign({}, state.unlockedHints, incoming.unlockedHints || {});
            state.collectedCells = Object.assign({}, state.collectedCells, incomingCells);
            state.achievedBingos = Object.assign({}, state.achievedBingos, incoming.achievedBingos || {});
            if (incoming.selectedTownId) {
              state.selectedTownId = incoming.selectedTownId;
            }
            hydrateCellsAndMigrateStorage();
            alert("バックアップデータを復元・統合しました！");
          } catch (err) {
            alert("バックアップファイルの読み込みに失敗しました。正しいJSONファイルを選択してください。");
          }
        };
        reader.readAsText(file);
      });
    }

    // アプリの最新プログラムを取得（Service Worker キャッシュ更新＆リロード）
    const updateBtn = document.getElementById("btn-check-app-update");
    if (updateBtn) {
      updateBtn.addEventListener("click", async () => {
        try {
          if ("serviceWorker" in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
              await reg.update();
            }
          }
          window.location.reload();
        } catch (err) {
          window.location.reload();
        }
      });
    }
  }

  // Service Worker 登録（オフライン動作＆アップデート両立）
  function registerServiceWorker() {
    if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("Service Worker registration skipped:", err);
      });
    }
  }

  // 初期化実行
  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    hydrateCellsAndMigrateStorage();
    renderAll();
    registerServiceWorker();
  });
})();
