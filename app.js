import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

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

// FIX: Removed duplicate 'delay' declaration
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
    const res = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0" }
    });

    const match = res.data.match(/"videoId":"(.*?)"/);
    if (!match) throw new Error("No results found");

    return match[1];
}

async function spotifyToQuery(url) {
    const res = await axios.get(url);
    const titleMatch = res.data.match(/<title>(.*?)<\/title>/i);
    if (!titleMatch) throw new Error("Spotify parse failed");

    return titleMatch[1].replace(/\s*-\s*Spotify/i, "").trim();
}

async function download(videoId) {
    const body = JSON.stringify({ id: videoId, fileType: "mp3" });

    for (let i = 0; i < 12; i++) {
        // Note: Using global fetch (available in Node 18+)
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
        // Optimized: Added 'other' to block tracking/analytics
        if (['image', 'stylesheet', 'font', 'media', 'other'].includes(req.resourceType())) {
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
        // Optimized: domcontentloaded is much faster than networkidle2
        await page.goto('https://spotisaver.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Optimized: Instant DOM injection instead of typing
        await page.evaluate((targetUrl) => {
            const input = document.querySelector('input[type="text"]');
            if (input) {
                input.value = targetUrl;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, url);
        
        await page.keyboard.press('Enter');

        for (let i = 0; i < 30; i++) {
            if (capturedData) break;
            await delay(300);
        }

        if (!capturedData) throw new Error("Failed to intercept data");

        return {
            info: {
                type: "playlist",
                name: capturedData.playlist_info?.name,
                owner: capturedData.playlist_info?.owner,
                total_tracks: capturedData.playlist_info?.total_tracks,
                external_url: capturedData.playlist_info?.external_url,
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

app.use(cors());

app.get("/api/playlist", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: false, message: "URL is required" });

    try {
        const data = await scrapeSpotifyPlaylist(url);
        res.json({ 
            status: true, 
            creator: "Eypz", 
            result: data 
        });
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
            if (!videoId) throw new Error("Invalid YouTube URL");
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
        res.status(500).json({ status: false, message: err.message });
    }
});

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 Running on http://localhost:${PORT}`);
    await getBrowser(); 
});
