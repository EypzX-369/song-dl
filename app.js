import "dotenv/config";
import express from "express";
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
            // 'shell' is the optimized, faster version of headless Chrome
            headless: 'shell', 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--disable-extensions'
            ]
        });
    }
    return browser;
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();
    const page = await instance.newPage();
    let capturedData = null;

    try {
        // --- SPEED OPTIMIZATION: Aggressive Blocking ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Intercept the specific API response
        page.on('response', async (response) => {
            if (response.url().includes('get_playlist.php')) {
                try { capturedData = await response.json(); } catch (e) {}
            }
        });

        // 1. Wait for 'domcontentloaded' instead of 'networkidle2' (saves ~5-10s)
        await page.goto('https://spotisaver.net/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 2. Direct DOM injection instead of slow .type() (saves ~2-3s)
        await page.evaluate((spotifyUrl) => {
            const input = document.querySelector('input[type="text"]');
            if (input) {
                input.value = spotifyUrl;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, url);

        // 3. Trigger search
        await page.keyboard.press('Enter');

        // 4. Tight polling for intercepted data
        for (let i = 0; i < 30; i++) {
            if (capturedData) break;
            await delay(300); 
        }

        if (!capturedData) throw new Error("Timeout: Failed to intercept Spotify data");

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
        // Ensure page is always closed to prevent memory leaks in Koyeb
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

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 API active on port ${PORT}`);
    // Pre-warm the browser instance
    await getBrowser(); 
});
