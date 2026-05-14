import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

const ALLOWED_DOMAIN = "https://song-dl.eypz.in";
const ADMIN_API_KEY = "admineypz";

app.use(express.json());
app.use(cookieParser());

app.use(cors({
    origin: ALLOWED_DOMAIN,
    credentials: true
}));

// =========================
// COOKIE TOKEN SYSTEM
// =========================

const validTokens = new Set();

function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

// Create auth cookie
app.get("/auth", (req, res) => {
    const origin = req.headers.origin;
    const referer = req.headers.referer || "";

    if (
        origin !== ALLOWED_DOMAIN &&
        !referer.startsWith(ALLOWED_DOMAIN)
    ) {
        return res.status(403).json({
            status: false,
            message: "Unauthorized domain"
        });
    }

    const token = generateToken();

    validTokens.add(token);

    res.cookie("song_auth", token, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 1000 * 60 * 60 * 24 * 7
    });

    res.json({
        status: true,
        message: "Authenticated"
    });
});

// =========================
// API PROTECTION
// =========================

function protectAPI(req, res, next) {
    const apikey = req.query.apikey;

    // Admin bypass
    if (apikey === ADMIN_API_KEY) {
        return next();
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer || "";

    // Block other domains
    if (
        origin !== ALLOWED_DOMAIN &&
        !referer.startsWith(ALLOWED_DOMAIN)
    ) {
        return res.status(403).json({
            status: false,
            message: "Access denied"
        });
    }

    // Validate cookie
    const token = req.cookies.song_auth;

    if (!token || !validTokens.has(token)) {
        return res.status(401).json({
            status: false,
            message: "Invalid cookie"
        });
    }

    next();
}

// =========================
// BLOCK TOOLS
// =========================

const blockedAgents = [
    "PostmanRuntime",
    "Insomnia"
];

app.use((req, res, next) => {
    const ua = req.headers["user-agent"] || "";

    const blocked = blockedAgents.some(v => ua.includes(v));

    if (blocked) {
        return res.status(403).json({
            status: false,
            message: "Tool blocked"
        });
    }

    next();
});

// =========================
// PUPPETEER
// =========================

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

const headers = {
    "accept-encoding": "gzip, deflate, br, zstd",
    "origin": "https://ht.flvto.online",
};

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

function isSpotify(url) {
    return url.includes("spotify.com");
}

function isYoutube(url) {
    return url.includes("youtube.com") || url.includes("youtu.be");
}

async function searchYouTube(query) {
    const res = await axios.get(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        {
            headers: {
                "user-agent": "Mozilla/5.0"
            }
        }
    );

    const match = res.data.match(/"videoId":"(.*?)"/);

    if (!match) throw new Error("No results found");

    return match[1];
}

async function spotifyToQuery(url) {
    const res = await axios.get(url);

    const titleMatch = res.data.match(/<title>(.*?)<\/title>/i);

    if (!titleMatch) throw new Error("Spotify parse failed");

    return titleMatch[1]
        .replace(/\s*-\s*Spotify/i, "")
        .trim();
}

async function download(videoId) {
    const body = JSON.stringify({
        id: videoId,
        fileType: "mp3"
    });

    for (let i = 0; i < 12; i++) {
        const res = await fetch("https://ht.flvto.online/converter", {
            method: "POST",
            headers,
            body
        });

        const json = await res.json();

        if (json.status === "ok" || json.status === "success") {
            return {
                title: json.title,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                url: json.link,
                duration: json.duration
            };
        }

        await delay(4000);
    }

    throw new Error("Timeout");
}

async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();

    const page = await instance.newPage();

    let capturedData = null;

    await page.setRequestInterception(true);

    page.on('request', (req) => {
        if (
            ['image', 'stylesheet', 'font', 'media']
                .includes(req.resourceType())
        ) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('response', async (response) => {
        if (response.url().includes('get_playlist.php')) {
            try {
                capturedData = await response.json();
            } catch (e) {}
        }
    });

    try {
        await page.goto('https://spotisaver.net/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        await page.type('input[type="text"]', url, {
            delay: 20
        });

        await page.keyboard.press('Enter');

        for (let i = 0; i < 40; i++) {
            if (capturedData) break;
            await delay(500);
        }

        if (!capturedData) {
            throw new Error("Failed to intercept data");
        }

        return {
            info: {
                type: "playlist",
                name: capturedData.playlist_info?.name || "Unknown",
                owner: capturedData.playlist_info?.owner || "Unknown",
                total_tracks: capturedData.playlist_info?.total_tracks || 0,
                external_url: capturedData.playlist_info?.external_url || "",
                images_url:
                    capturedData.playlist_info?.images?.[1]?.url ||
                    capturedData.playlist_info?.images?.[0]?.url ||
                    ""
            },

            tracks: (capturedData.tracks || []).map(t => ({
                name: t.name,
                artist: Array.isArray(t.artists)
                    ? t.artists.join(', ')
                    : t.artists,
                id: t.id,
                share_url: t.external_url
            }))
        };
    } finally {
        await page.close();
    }
}

// =========================
// ROUTES
// =========================

app.get('/', (req, res) => {
    res.send('Bot Running');
});

// Protected playlist API
app.get("/api/playlist", protectAPI, async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            status: false,
            message: "URL is required"
        });
    }

    try {
        const data = await scrapeSpotifyPlaylist(url);

        res.json({
            status: true,
            creator: "Eypz",
            result: data
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            message: err.message
        });
    }
});

// Protected downloader API
app.get("/api/dl", protectAPI, async (req, res) => {
    let { q } = req.query;

    if (!q) {
        return res.status(400).json({
            status: false,
            message: "Query 'q' is required"
        });
    }

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

        res.json({
            status: true,
            creator: "Eypz",
            result: data
        });
    } catch (err) {
        res.status(500).json({
            status: false,
            message: err.message
        });
    }
});

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Running on http://localhost:${PORT}`);
    await getBrowser();
});
