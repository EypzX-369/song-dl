import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// ─── Allowed Domain ───────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = "https://song-dl.eypz.in";

// ─── User Agents Pool ─────────────────────────────────────────────────────────
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── Cookie Store ─────────────────────────────────────────────────────────────
const cookieStore = {
    flvto: null,
    lastRefreshed: null,
};

// ─── Domain Guard Middleware ──────────────────────────────────────────────────
const domainGuard = (req, res, next) => {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const host = req.headers['host'];

    // Allow direct server-to-server (no origin/referer) only if host matches
    const originOk = !origin || origin === ALLOWED_ORIGIN;
    const refererOk = !referer || referer.startsWith(ALLOWED_ORIGIN);

    if (!originOk || !refererOk) {
        return res.status(403).json({
            status: false,
            message: "Forbidden: Access denied. Only requests from download.eypz.in are allowed."
        });
    }

    next();
};

// ─── CORS (strict) ────────────────────────────────────────────────────────────
app.use(cors({
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
}));

// Apply domain guard to all /api routes
app.use("/api", domainGuard);

// ─── Browser ──────────────────────────────────────────────────────────────────
let browser;
const getBrowser = async () => {
    if (!browser) {
        browser = await puppeteerExtra.launch({
            headless: 'shell',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--no-first-run',
                '--disable-extensions',
                '--disable-software-rasterizer',
            ]
        });

        browser.on('disconnected', () => {
            console.log("Browser disconnected. Resetting instance...");
            browser = null;
        });
    }
    return browser;
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Cookie Helpers ───────────────────────────────────────────────────────────

// Refresh flvto cookies using a headless browser visit
async function refreshFlvtoCookies() {
    const instance = await getBrowser();
    const page = await instance.newPage();
    const ua = getRandomUA();
    await page.setUserAgent(ua);

    try {
        await page.goto("https://ht.flvto.online/", {
            waitUntil: "networkidle2",
            timeout: 20000,
        });
        await delay(1500);

        const cookies = await page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        cookieStore.flvto = cookieHeader;
        cookieStore.lastRefreshed = Date.now();
        console.log("[Cookie] flvto cookies refreshed.");
    } catch (e) {
        console.error("[Cookie] Failed to refresh flvto cookies:", e.message);
    } finally {
        await page.close();
    }
}

// Get cookies, refresh if older than 30 minutes or missing
async function getFlvtoCookies() {
    const AGE_LIMIT = 30 * 60 * 1000;
    if (!cookieStore.flvto || !cookieStore.lastRefreshed || (Date.now() - cookieStore.lastRefreshed > AGE_LIMIT)) {
        await refreshFlvtoCookies();
    }
    return cookieStore.flvto || "";
}

// ─── Headers Builder ──────────────────────────────────────────────────────────
const buildHeaders = (cookies = "") => ({
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "origin": "https://ht.flvto.online",
    "referer": "https://ht.flvto.online/",
    "user-agent": getRandomUA(),
    ...(cookies ? { "cookie": cookies } : {}),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractVideoId(input) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m && m[1]) return m[1];
    }
    return null;
}

function isSpotify(url) { return url.includes("spotify.com"); }
function isYoutube(url) { return url.includes("youtube.com") || url.includes("youtu.be"); }

async function searchYouTube(query) {
    const res = await axios.get(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        { headers: { "user-agent": getRandomUA() } }
    );
    const match = res.data.match(/"videoId":"(.*?)"/);
    if (!match) throw new Error("No results found");
    return match[1];
}

async function spotifyToQuery(url) {
    const res = await axios.get(url, {
        headers: { "user-agent": getRandomUA() }
    });
    const titleMatch = res.data.match(/<title>(.*?)<\/title>/i);
    if (!titleMatch) throw new Error("Spotify parse failed");
    return titleMatch[1].replace(/\s*-\s*Spotify/i, "").trim();
}

// ─── Downloader (with cookies) ────────────────────────────────────────────────
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

        await delay(4000);
    }

    throw new Error("Timeout");
}

// ─── Spotify Playlist Scraper ─────────────────────────────────────────────────
async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();
    const page = await instance.newPage();
    const ua = getRandomUA();
    await page.setUserAgent(ua);
    let capturedData = null;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('response', async (response) => {
        if (response.url().includes('get_playlist.php')) {
            try { capturedData = await response.json(); } catch (e) {}
        }
    });

    try {
        await page.goto('https://spotisaver.net/', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.type('input[type="text"]', url, { delay: 20 });
        await page.keyboard.press('Enter');

        for (let i = 0; i < 40; i++) {
            if (capturedData) break;
            await delay(500);
        }

        if (!capturedData) throw new Error("Failed to intercept data");

        return {
            info: {
                type: "playlist",
                name: capturedData.playlist_info?.name || "Unknown",
                owner: capturedData.playlist_info?.owner || "Unknown",
                total_tracks: capturedData.playlist_info?.total_tracks || 0,
                external_url: capturedData.playlist_info?.external_url || "",
                images_url: capturedData.playlist_info?.images?.[1]?.url || capturedData.playlist_info?.images?.[0]?.url || ""
            },
            tracks: (capturedData.tracks || []).map(t => ({
                name: t.name,
                artist: Array.isArray(t.artists) ? t.artists.join(', ') : t.artists,
                id: t.id,
                share_url: t.external_url
            }))
        };
    } finally {
        await page.close();
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Bot Running'));

app.get("/api/playlist", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, message: "URL is required" });

    try {
        const data = await scrapeSpotifyPlaylist(url);
        res.json({ status: true, creator: "Eypz", result: data });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

app.get("/api/dl", async (req, res) => {
    let { q } = req.query;
    if (!q) return res.status(400).json({ status: false, message: "Query 'q' is required" });

    try {
        let videoId;
        if (isYoutube(q)) {
            videoId = extractVideoId(q);
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 Running on http://localhost:${PORT}`);
    await getBrowser();
    await refreshFlvtoCookies(); // warm up cookies on startup
});
