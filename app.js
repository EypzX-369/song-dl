import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import puppeteer from 'puppeteer';
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
                '--disable-dev-shm-usage', // Critical for Docker/Koyeb
                '--disable-gpu',
                '--no-zygote',
                '--no-first-run',
                '--disable-extensions',
                '--disable-software-rasterizer',
                // REMOVED: '--single-process' (This often causes crashes in Alpine/Docker)
            ]
        });

        // If the browser disconnects, null out the variable so it can restart
        browser.on('disconnected', () => {
            console.log("Browser disconnected. Resetting instance...");
            browser = null;
        });
    }
    return browser;
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeSpotifyPlaylist(url) {
    const instance = await getBrowser();
    const page = await instance.newPage();
    let capturedData = null;

    // --- SPEED OPTIMIZATION: Block heavy assets ---
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
        await page.type('input[type="text"]', url, { delay: 10 });
        await page.keyboard.press('Enter');

        for (let i = 0; i < 20; i++) {
            if (capturedData) break;
            await delay(500);
        }

        if (!capturedData) throw new Error("Failed to intercept data");

        // --- REFORMATTING JSON ---
        return {
            info: {
                type: "playlist",
                name: capturedData.playlist_info.name,
                owner: capturedData.playlist_info.owner,
                total_tracks: capturedData.playlist_info.total_tracks,
                external_url: capturedData.playlist_info.external_url,
                images_url: capturedData.playlist_info.images?.[1]?.url || capturedData.playlist_info.images?.[0]?.url || ""
            },
            tracks: capturedData.tracks.map(t => ({
                name: t.name,
                artist: t.artists.join(', '),
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
            creator: "Eypz", // Updated creator name
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
