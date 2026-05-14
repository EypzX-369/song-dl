import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// =======================
// SECURITY CONFIG
// =======================

const ALLOWED_DOMAIN = "https://dl-song.eypz.in";
const ADMIN_API_KEY = "admineypz";
const JWT_SECRET = process.env.JWT_SECRET || "eypz_super_secret";

// =======================
// TRUST PROXY
// =======================

app.set("trust proxy", true);

// =======================
// MIDDLEWARE
// =======================

app.use(express.json());
app.use(cookieParser());

app.use(cors({
    origin: ALLOWED_DOMAIN,
    credentials: true
}));

// =======================
// RATE LIMITER
// =======================

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        status: false,
        message: "Too many requests"
    }
});

app.use("/api", limiter);

// =======================
// BLOCKED IPS
// =======================

const blockedIPs = new Set([
    // "1.1.1.1"
]);

// =======================
// BLOCK BAD TOOLS
// =======================

const blockedAgents = [
    "PostmanRuntime",
    "Insomnia",
    "curl",
    "python",
    "wget"
];

app.use((req, res, next) => {
    const ua = req.headers["user-agent"] || "";

    const blocked = blockedAgents.some(v =>
        ua.toLowerCase().includes(v.toLowerCase())
    );

    if (blocked) {
        return res.status(403).json({
            status: false,
            message: "Client blocked"
        });
    }

    next();
});

// =======================
// AUTH ROUTE
// =======================

app.get("/auth", (req, res) => {
    const origin = req.headers.origin || "";
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

    const token = jwt.sign(
        {
            domain: ALLOWED_DOMAIN,
            created: Date.now(),
            random: crypto.randomBytes(16).toString("hex")
        },
        JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );

    res.cookie("song_auth", token, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 1000 * 60 * 60 * 24 * 7
    });

    res.json({
        status: true,
        creator: "Eypz",
        message: "Authenticated"
    });
});

// =======================
// PROTECTION MIDDLEWARE
// =======================

function protectAPI(req, res, next) {

    const apikey = req.query.apikey;

    // ===================
    // ADMIN BYPASS
    // ===================

    if (apikey === ADMIN_API_KEY) {
        return next();
    }

    // ===================
    // IP CHECK
    // ===================

    const ip =
        req.headers["cf-connecting-ip"] ||
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress;

    if (blockedIPs.has(ip)) {
        return res.status(403).json({
            status: false,
            message: "IP blocked"
        });
    }

    // ===================
    // DOMAIN CHECK
    // ===================

    const origin = req.headers.origin || "";
    const referer = req.headers.referer || "";

    if (
        origin !== ALLOWED_DOMAIN &&
        !referer.startsWith(ALLOWED_DOMAIN)
    ) {
        return res.status(403).json({
            status: false,
            message: "Invalid origin"
        });
    }

    // ===================
    // CUSTOM HEADER CHECK
    // ===================

    const customOrigin = req.headers["x-song-origin"];

    if (customOrigin !== "dl-song.eypz.in") {
        return res.status(403).json({
            status: false,
            message: "Invalid headers"
        });
    }

    // ===================
    // COOKIE CHECK
    // ===================

    const token = req.cookies.song_auth;

    if (!token) {
        return res.status(401).json({
            status: false,
            message: "No auth cookie"
        });
    }

    // ===================
    // JWT VERIFY
    // ===================

    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({
            status: false,
            message: "Invalid token"
        });
    }
}

// =======================
// PUPPETEER
// =======================

let browser;

const getBrowser = async () => {

    if (!browser) {

        browser = await puppeteerExtra.launch({
            headless: "shell",
            executablePath:
                process.env.PUPPETEER_EXECUTABLE_PATH ||
                "/usr/bin/chromium-browser",

            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--no-first-run",
                "--disable-extensions",
                "--disable-software-rasterizer",
            ]
        });

        browser.on("disconnected", () => {
            console.log("Browser disconnected");
            browser = null;
        });
    }

    return browser;
};

const delay = (ms) =>
    new Promise(r => setTimeout(r, ms));

// =======================
// FLVTO HEADERS
// =======================

const headers = {
    "accept-encoding": "gzip, deflate, br, zstd",
    "origin": "https://dl-song.eypz.in",
    "referer": "https://dl-song.eypz.in/",
    "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "x-song-origin": "dl-song.eypz.in"
};

// =======================
// HELPERS
// =======================

function extractVideoId(input) {

    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/
    ];

    for (const p of patterns) {
        const m = input.match(p);

        if (m && m[1]) {
            return m[1];
        }
    }

    return null;
}

function isSpotify(url) {
    return url.includes("spotify.com");
}

function isYoutube(url) {
    return (
        url.includes("youtube.com") ||
        url.includes("youtu.be")
    );
}

// =======================
// SEARCH YOUTUBE
// =======================

async function searchYouTube(query) {

    const res = await axios.get(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        {
            headers: {
                "user-agent": headers["user-agent"]
            }
        }
    );

    const match = res.data.match(/"videoId":"(.*?)"/);

    if (!match) {
        throw new Error("No results found");
    }

    return match[1];
}

// =======================
// SPOTIFY TITLE
// =======================

async function spotifyToQuery(url) {

    const res = await axios.get(url, {
        headers
    });

    const titleMatch = res.data.match(
        /<title>(.*?)<\/title>/i
    );

    if (!titleMatch) {
        throw new Error("Spotify parse failed");
    }

    return titleMatch[1]
        .replace(/\s*-\s*Spotify/i, "")
        .trim();
}

// =======================
// DOWNLOAD
// =======================

async function download(videoId) {

    const body = JSON.stringify({
        id: videoId,
        fileType: "mp3"
    });

    for (let i = 0; i < 12; i++) {

        const res = await fetch(
            "https://ht.flvto.online/converter",
            {
                method: "POST",
                headers,
                body
            }
        );

        const json = await res.json();

        if (
            json.status === "ok" ||
            json.status === "success"
        ) {

            return {
                title: json.title,
                thumbnail:
                    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                url: json.link,
                duration: json.duration
            };
        }

        await delay(4000);
    }

    throw new Error("Timeout");
}

// =======================
// SPOTIFY PLAYLIST SCRAPER
// =======================

async function scrapeSpotifyPlaylist(url) {

    const instance = await getBrowser();

    const page = await instance.newPage();

    let capturedData = null;

    await page.setRequestInterception(true);

    page.on("request", (req) => {

        if (
            ["image", "stylesheet", "font", "media"]
                .includes(req.resourceType())
        ) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on("response", async (response) => {

        if (
            response.url().includes("get_playlist.php")
        ) {
            try {
                capturedData = await response.json();
            } catch {}
        }
    });

    try {

        await page.goto(
            "https://spotisaver.net/",
            {
                waitUntil: "networkidle2",
                timeout: 30000
            }
        );

        await page.type(
            'input[type="text"]',
            url,
            {
                delay: 20
            }
        );

        await page.keyboard.press("Enter");

        for (let i = 0; i < 40; i++) {

            if (capturedData) {
                break;
            }

            await delay(500);
        }

        if (!capturedData) {
            throw new Error(
                "Failed to intercept data"
            );
        }

        return {
            info: {
                type: "playlist",
                name:
                    capturedData.playlist_info?.name ||
                    "Unknown",

                owner:
                    capturedData.playlist_info?.owner ||
                    "Unknown",

                total_tracks:
                    capturedData.playlist_info?.total_tracks ||
                    0,

                external_url:
                    capturedData.playlist_info?.external_url ||
                    "",

                images_url:
                    capturedData.playlist_info?.images?.[1]?.url ||
                    capturedData.playlist_info?.images?.[0]?.url ||
                    ""
            },

            tracks: (
                capturedData.tracks || []
            ).map(t => ({
                name: t.name,

                artist: Array.isArray(t.artists)
                    ? t.artists.join(", ")
                    : t.artists,

                id: t.id,
                share_url: t.external_url
            }))
        };

    } finally {
        await page.close();
    }
}

// =======================
// ROUTES
// =======================

app.get("/", (req, res) => {
    res.send("Bot Running");
});

// =======================
// PLAYLIST API
// =======================

app.get(
    "/api/playlist",
    protectAPI,
    async (req, res) => {

        const { url } = req.query;

        if (!url) {
            return res.status(400).json({
                status: false,
                message: "URL is required"
            });
        }

        try {

            const data =
                await scrapeSpotifyPlaylist(url);

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
    }
);

// =======================
// SONG DOWNLOADER API
// =======================

app.get(
    "/api/dl",
    protectAPI,
    async (req, res) => {

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

                const query =
                    await spotifyToQuery(q);

                videoId =
                    await searchYouTube(query);

            } else {

                videoId =
                    await searchYouTube(q);
            }

            const data =
                await download(videoId);

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
    }
);

// =======================
// START SERVER
// =======================

app.listen(
    PORT,
    "0.0.0.0",
    async () => {

        console.log(
            `Running on http://localhost:${PORT}`
        );

        await getBrowser();
    }
);
