import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import puppeteer from 'puppeteer'; // Added direct import
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// Global browser instance to save resources
let browser;
const getBrowser = async () => {
    if (!browser) {
        browser = await puppeteerExtra.launch({ 
            headless: "new",
            // This is the key part for Alpine/Docker
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
    }
    return browser;
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// --- EXISTING HELPERS ---
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

const isSpotify = (url) => url.includes("spotify.com");
const isYoutube = (url) => url.includes("youtube.com") || url.includes("youtu.be");

async function searchYouTube(query) {
    const res = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0" }
    });
    const match = res.data.match(/"videoId":"(.*?)"/);
    if (!match) throw new Error("No results found");
    return match[1];
}

async function download(videoId) {
    const headers = { "origin": "https://ht.flvto.online" };
    const body = JSON.stringify({ id: videoId, fileType: "mp3" });

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

// --- NEW SPOTIFY PLAYLIST SCRAPER ---
async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();
    const page = await instance.newPage();
    let capturedData = null;

    page.on('response', async (response) => {
        if (response.url().includes('get_playlist.php')) {
            try { capturedData = await response.json(); } catch (e) {}
        }
    });

    try {
        await page.goto('https://spotisaver.net/', { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', url, { delay: 30 });
        await page.keyboard.press('Enter');

        // Wait up to 10 seconds for the API to be intercepted
        for (let i = 0; i < 20; i++) {
            if (capturedData) break;
            await delay(500);
        }

        if (!capturedData) throw new Error("Failed to intercept playlist data");

        return {
            info: capturedData.playlist_info,
            tracks: capturedData.tracks.map(t => ({
                name: t.name,
                artist: t.artists.join(', '),
                id: t.id,
                share_url: t.external_url
            }))
        };
    } finally {
        await page.close(); // Important: Close the tab, not the browser
    }
}

// --- ROUTES ---
app.use(cors());

// Existing Single DL Route
app.get("/api/dl", async (req, res) => {
    let { q } = req.query;
    if (!q) return res.status(400).json({ status: false, message: "Query 'q' is required" });

    try {
        let videoId;
        if (isYoutube(q)) {
            videoId = extractVideoId(q);
        } else if (isSpotify(q)) {
            const resData = await axios.get(q);
            const titleMatch = resData.data.match(/<title>(.*?)<\/title>/i);
            const query = titleMatch ? titleMatch[1].replace(/\s*-\s*Spotify/i, "").trim() : q;
            videoId = await searchYouTube(query);
        } else {
            videoId = await searchYouTube(q);
        }

        const data = await download(videoId);
        res.json({ status: true, creator: "Izumi", result: data });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// New Playlist Route
app.get("/api/playlist", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, message: "URL is required" });

    try {
        if (isSpotify(url)) {
            const data = await scrapeSpotifyPlaylist(url);
            res.json({ status: true, creator: "Izumi", result: data });
        } else {
            res.status(400).json({ status: false, message: "Only Spotify playlists are supported for this route currently" });
        }
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 Running on http://localhost:${PORT}`);
    await getBrowser(); // Pre-warm browser
});
