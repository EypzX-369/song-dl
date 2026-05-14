import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// ─── Allowed Origin ────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = "https://song-dl.eypz.in";

// ─── User Agents Pool ──────────────────────────────────────────────────────────
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── Cookie Store ──────────────────────────────────────────────────────────────
const cookieStore = {
    flvto: null,
    lastRefreshed: null,
};

// ─── Delay Helper ──────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Domain Guard Middleware ───────────────────────────────────────────────────
const domainGuard = (req, res, next) => {
    const origin = req.headers["origin"];
    const referer = req.headers["referer"];

    if (origin && origin !== ALLOWED_ORIGIN) {
        return res.status(403).json({ status: false, message: "Forbidden: Access denied." });
    }
    if (referer && !referer.startsWith(ALLOWED_ORIGIN)) {
        return res.status(403).json({ status: false, message: "Forbidden: Access denied." });
    }
    next();
};

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || origin === ALLOWED_ORIGIN) {
                callback(null, true);
            } else {
                callback(new Error("CORS: Not allowed"), false);
            }
        },
        methods: ["GET"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);

app.use("/api", domainGuard);

// ─── Browser Singleton ─────────────────────────────────────────────────────────
let browser;
const getBrowser = async () => {
    if (!browser) {
        browser = await puppeteerExtra.launch({
            headless: "shell",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--no-first-run",
                "--disable-extensions",
                "--disable-software-rasterizer",
            ],
        });

        browser.on("disconnected", () => {
            console.log("Browser disconnected. Resetting instance...");
            browser = null;
        });
    }
    return browser;
};

// ─── Cookie Helpers ────────────────────────────────────────────────────────────
async function refreshFlvtoCookies() {
    const instance = await getBrowser();
    const page = await instance.newPage();
    await page.setUserAgent(getRandomUA());

    try {
        await page.goto("https://ht.flvto.online/", { waitUntil: "networkidle2", timeout: 20000 });
        await delay(1500);
        const cookies = await page.cookies();
        cookieStore.flvto = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        cookieStore.lastRefreshed = Date.now();
        console.log("[Cookie] flvto cookies refreshed.");
    } catch (e) {
        console.error("[Cookie] Failed to refresh flvto cookies:", e.message);
    } finally {
        await page.close();
    }
}

async function getFlvtoCookies() {
    const AGE_LIMIT = 30 * 60 * 1000;
    if (
        !cookieStore.flvto ||
        !cookieStore.lastRefreshed ||
        Date.now() - cookieStore.lastRefreshed > AGE_LIMIT
    ) {
        await refreshFlvtoCookies();
    }
    return cookieStore.flvto || "";
}

// ─── Headers Builder ───────────────────────────────────────────────────────────
const buildHeaders = (cookies = "") => ({
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://ht.flvto.online",
    referer: "https://ht.flvto.online/",
    "user-agent": getRandomUA(),
    ...(cookies ? { cookie: cookies } : {}),
});

// ─── Utility Helpers ───────────────────────────────────────────────────────────
function extractVideoId(input) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m && m[1]) return m[1];
    }
    return null;
}

function extractPlaylistId(url) {
    const m = url.match(/[?&]list=([^&]+)/);
    return m ? m[1] : null;
}

function isSpotify(url) { return url.includes("spotify.com"); }
function isYoutube(url) { return url.includes("youtube.com") || url.includes("youtu.be"); }
function isYoutubePlaylist(url) { return isYoutube(url) && url.includes("list="); }
function isSpotifyPlaylist(url) { return isSpotify(url) && url.includes("/playlist/"); }

async function searchYouTube(query) {
    const res = await axios.get(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        { headers: { "user-agent": getRandomUA() } }
    );
    const match = res.data.match(/"videoId":"(.*?)"/);
    if (!match) throw new Error("No YouTube results found");
    return match[1];
}

async function spotifyToQuery(url) {
    const res = await axios.get(url, { headers: { "user-agent": getRandomUA() } });
    const titleMatch = res.data.match(/<title>(.*?)<\/title>/i);
    if (!titleMatch) throw new Error("Spotify parse failed");
    return titleMatch[1].replace(/\s*-\s*Spotify/i, "").trim();
}

// ─── flvto Downloader ──────────────────────────────────────────────────────────
async function download(videoId) {
    const body = JSON.stringify({ id: videoId, fileType: "mp3" });

    for (let i = 0; i < 12; i++) {
        const cookies = await getFlvtoCookies();
        const res = await fetch("https://ht.flvto.online/converter", {
            method: "POST",
            headers: buildHeaders(cookies),
            body,
        });

        const json = await res.json();

        if (json.status === "ok" || json.status === "success") {
            return {
                title: json.title,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                url: json.link,
                duration: json.duration,
            };
        }

        if (json.status === "fail") throw new Error("Converter reported failure");

        await delay(4000);
    }

    throw new Error("Download timed out");
}

// ─── Spotify Playlist Scraper ──────────────────────────────────────────────────
async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();
    const page = await instance.newPage();
    await page.setUserAgent(getRandomUA());
    let capturedData = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => {
        if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on("response", async (response) => {
        if (response.url().includes("get_playlist.php")) {
            try { capturedData = await response.json(); } catch (e) {}
        }
    });

    try {
        await page.goto("https://spotisaver.net/", { waitUntil: "networkidle2", timeout: 30000 });
        await page.type('input[type="text"]', url, { delay: 20 });
        await page.keyboard.press("Enter");

        for (let i = 0; i < 40; i++) {
            if (capturedData) break;
            await delay(500);
        }

        if (!capturedData) throw new Error("Failed to intercept Spotify playlist data");

        return {
            info: {
                type: "playlist",
                source: "spotify",
                name: capturedData.playlist_info?.name || "Unknown",
                owner: capturedData.playlist_info?.owner || "Unknown",
                total_tracks: capturedData.playlist_info?.total_tracks || 0,
                external_url: capturedData.playlist_info?.external_url || "",
                images_url:
                    capturedData.playlist_info?.images?.[1]?.url ||
                    capturedData.playlist_info?.images?.[0]?.url ||
                    "",
            },
            tracks: (capturedData.tracks || []).map((t) => ({
                name: t.name,
                artist: Array.isArray(t.artists) ? t.artists.join(", ") : t.artists,
                id: t.id,
                share_url: t.external_url,
            })),
        };
    } finally {
        await page.close();
    }
}

// ─── YouTube Playlist Scraper ──────────────────────────────────────────────────
async function scrapeYouTubePlaylist(url) {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) throw new Error("Invalid YouTube playlist URL");

    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

    const res = await axios.get(playlistUrl, {
        headers: { "user-agent": getRandomUA() },
    });

    const html = res.data;

    // Extract initial data JSON embedded in the page
    const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (!match) throw new Error("Could not parse YouTube playlist page");

    let ytData;
    try {
        ytData = JSON.parse(match[1]);
    } catch (e) {
        throw new Error("Failed to parse YouTube playlist JSON");
    }

    // Navigate the JSON structure to the playlist contents
    const sidebar = ytData?.sidebar?.playlistSidebarRenderer?.items?.[0]
        ?.playlistSidebarPrimaryInfoRenderer;

    const playlistName =
        sidebar?.title?.runs?.[0]?.text ||
        ytData?.header?.playlistHeaderRenderer?.title?.simpleText ||
        "Unknown Playlist";

    const ownerRuns =
        sidebar?.videoOwner?.videoOwnerRenderer?.title?.runs ||
        ytData?.header?.playlistHeaderRenderer?.ownerText?.runs;
    const owner = ownerRuns?.[0]?.text || "Unknown";

    // Tracks live under contents
    const videoItems =
        ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
            ?.itemSectionRenderer?.contents?.[0]
            ?.playlistVideoListRenderer?.contents || [];

    const tracks = videoItems
        .filter((item) => item?.playlistVideoRenderer)
        .map((item) => {
            const v = item.playlistVideoRenderer;
            const videoId = v?.videoId || "";
            const title = v?.title?.runs?.[0]?.text || v?.title?.simpleText || "Unknown";
            const artist =
                v?.shortBylineText?.runs?.[0]?.text ||
                v?.longBylineText?.runs?.[0]?.text ||
                "Unknown";
            const duration =
                v?.lengthText?.simpleText || v?.lengthSeconds || "";
            const thumbnail =
                v?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
                `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

            return {
                name: title,
                artist,
                videoId,
                url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
                thumbnail,
                duration,
            };
        });

    const totalTracks =
        ytData?.header?.playlistHeaderRenderer?.numVideosText?.runs?.[0]?.text ||
        String(tracks.length);

    return {
        info: {
            type: "playlist",
            source: "youtube",
            name: playlistName,
            owner,
            total_tracks: totalTracks,
            external_url: playlistUrl,
            images_url: tracks[0]?.thumbnail || "",
        },
        tracks,
    };
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot Running"));

// /api/dl?q=<youtube url | spotify track url | search query>
app.get("/api/dl", async (req, res) => {
    let { q } = req.query;
    if (!q) return res.status(400).json({ status: false, message: "Query 'q' is required" });

    try {
        let videoId;

        if (isYoutube(q)) {
            videoId = extractVideoId(q);
            if (!videoId) throw new Error("Invalid YouTube URL");
        } else if (isSpotify(q)) {
            const query = await spotifyToQuery(q);
            videoId = await searchYouTube(query);
        } else {
            videoId = await searchYouTube(q);
        }

        const data = await download(videoId);
        res.json({ status: true, creator: "Eypz", result: data });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// /api/playlist?url=<spotify playlist url | youtube playlist url>
app.get("/api/playlist", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, message: "URL is required" });

    try {
        let data;

        if (isSpotifyPlaylist(url)) {
            data = await scrapeSpotifyPlaylist(url);
        } else if (isYoutubePlaylist(url)) {
            data = await scrapeYouTubePlaylist(url);
        } else {
            return res.status(400).json({
                status: false,
                message: "URL must be a Spotify playlist or YouTube playlist",
            });
        }

        res.json({ status: true, creator: "Eypz", result: data });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 Running on http://localhost:${PORT}`);
    await getBrowser();
    await refreshFlvtoCookies();
});
