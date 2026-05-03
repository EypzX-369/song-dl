import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8000;

const headers = {
    "accept-encoding": "gzip, deflate, br, zstd",
    "origin": "https://ht.flvto.online",
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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

app.use(cors());

app.get("/api/dl", async (req, res) => {
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
            if (!videoId) throw new Error("Invalid YouTube URL");
        }

        else if (isSpotify(q)) {
            const query = await spotifyToQuery(q);
            videoId = await searchYouTube(query);
        }

        else {
            videoId = await searchYouTube(q);
        }

        const data = await download(videoId);

        res.json({
            status: true,
            creator: "Izumi",
            result: data
        });

    } catch (err) {
        res.status(500).json({
            status: false,
            message: err.message
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Running on http://localhost:${PORT}`);
});
