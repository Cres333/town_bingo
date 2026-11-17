// ============================================================================
// 街のパーツ収集・宝探しビンゴ — オフライン＆自動更新対応 Service Worker (sw.js)
// ============================================================================
// 【仕組み】
// ・自宅Wi-Fi等でPCサーバーに繋がる時は「最新ファイル」を自動取得してキャッシュを更新します。
// ・外出先（オフライン・PC電源OFF時）は即座にスマホ内のキャッシュから起動します。
// ・写真やクリア状況はブラウザの localStorage に保存されるため、アップデートしても消えません。

const CACHE_NAME = "town-bingo-pwa-cache-v14";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
];

// インストール時に基本ファイル一式をスマホ内にキャッシュ
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

// 有効化時に古いキャッシュがあれば整理して即座に制御開始
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

// ネットワーク優先（1.2秒タイムアウト付き）＋オフラインキャッシュフォールバック
function fetchWithTimeout(request, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("network-timeout"));
    }, timeoutMs);

    fetch(request, { cache: "no-store" })
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    fetchWithTimeout(req, 1200)
      .then((networkResponse) => {
        // 正常に取得できたらキャッシュを最新に上書き保存
        if (networkResponse && networkResponse.status === 200) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, cloned);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // 外出先（PCサーバー停止中・オフライン時）はキャッシュから即座に返す
        return caches.match(req).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        });
      })
  );
});
