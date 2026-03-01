const fetch = require('node-fetch');
const crypto = require('crypto');

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const MAIN_URL = "https://api.hlowb.com";

// --- IMPORTANT ---
// You MUST replace this with the exact value found in the CNCVerse build files!
// If this is wrong, the AES decryption will immediately fail.
const CASTLE_SUFFIX = "T!BgJB"; 

async function getTMDBDetails(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const title = mediaType === 'tv' ? data.name : data.title;
        const year = (mediaType === 'tv' ? data.first_air_date : data.release_date)?.substring(0, 4);
        return { title, year };
    } catch (err) {
        return { title: `TMDB ID ${tmdbId}`, year: null };
    }
}

async function getSecurityKey() {
    try {
        const url = `${MAIN_URL}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.code === 200) return data.data;
        return null;
    } catch (e) {
        return null;
    }
}

function deriveKey(apiKeyB64) {
    const apiKeyBytes = Buffer.from(apiKeyB64, 'base64');
    const suffixBytes = Buffer.from(CASTLE_SUFFIX, 'ascii');
    let keyMaterial = Buffer.concat([apiKeyBytes, suffixBytes]);
    
    if (keyMaterial.length < 16) {
        const padding = Buffer.alloc(16 - keyMaterial.length, 0);
        keyMaterial = Buffer.concat([keyMaterial, padding]);
    } else if (keyMaterial.length > 16) {
        keyMaterial = keyMaterial.slice(0, 16);
    }
    return keyMaterial;
}

function decryptData(encryptedB64, apiKeyB64) {
    try {
        const aesKey = deriveKey(apiKeyB64);
        const encryptedData = Buffer.from(encryptedB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, aesKey);
        let decrypted = decipher.update(encryptedData, null, 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (err) {
        console.error("[CastleTV] AES Decryption failed! Is your CASTLE_SUFFIX correct?");
        return null;
    }
}

async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    console.log(`[CastleTV] Fetching streams for TMDB ID: ${tmdbId}`);
    
    if (CASTLE_SUFFIX === "REPLACE_ME_WITH_REAL_SUFFIX") {
        console.error("[CastleTV] Aborting: You forgot to replace the CASTLE_SUFFIX!");
        return [];
    }

    try {
        const mediaInfo = await getTMDBDetails(tmdbId, mediaType);
        const securityKey = await getSecurityKey();
        if (!securityKey) throw new Error("Failed to get security key");

        // 1. Search for the Movie/Show
        const searchUrl = `${MAIN_URL}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&keyword=${encodeURIComponent(mediaInfo.title)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=30`;
        const searchRes = await fetch(searchUrl);
        const searchEncrypted = await searchRes.text();
        const searchData = decryptData(searchEncrypted, securityKey);
        
        if (!searchData || !searchData.data || !searchData.data.rows) return [];
        
        const match = searchData.data.rows.find(r => r.title.toLowerCase() === mediaInfo.title.toLowerCase());
        if (!match) {
            console.log(`[CastleTV] No exact match found for ${mediaInfo.title}`);
            return [];
        }

        // 2. Get Details to find the correct Episode ID
        const detailsUrl = `${MAIN_URL}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en-US&movieId=${match.id}&packageName=com.external.castle`;
        const detailsRes = await fetch(detailsUrl);
        const detailsEncrypted = await detailsRes.text();
        const detailsData = decryptData(detailsEncrypted, securityKey);
        
        if (!detailsData || !detailsData.data) return [];
        
        let targetEpisodeId = null;
        if (mediaType === 'tv') {
            const epMatch = detailsData.data.episodes?.find(e => e.number === parseInt(episodeNum));
            if (epMatch) targetEpisodeId = epMatch.id;
        } else {
            targetEpisodeId = detailsData.data.episodes?.[0]?.id;
        }

        if (!targetEpisodeId) {
            console.log(`[CastleTV] Could not extract target episode ID.`);
            return [];
        }

        // 3. Post for the M3U8 Video Links
        const streams = [];
        const resolutions = [3, 2, 1]; // 1080p, 720p, 480p
        
        for (const res of resolutions) {
            const videoUrl = `${MAIN_URL}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`;
            const postBody = {
                mode: "1",
                appMarket: "GuanWang",
                clientType: "1",
                woolUser: "false",
                apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
                androidVersion: "13",
                movieId: match.id.toString(),
                episodeId: targetEpisodeId.toString(),
                isNewUser: "true",
                resolution: res.toString(),
                packageName: "com.external.castle"
            };

            const videoReq = await fetch(videoUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(postBody)
            });

            const videoEncrypted = await videoReq.text();
            const videoData = decryptData(videoEncrypted, securityKey);

            if (videoData && videoData.data && videoData.data.videoUrl && !videoData.data.permissionDenied) {
                const qualityLabel = res === 3 ? "1080p" : res === 2 ? "720p" : "480p";
                
                // Injecting Stremio Proxy Headers to bypass firewall blocks
                streams.push({
                    name: "CastleTV",
                    title: `${mediaInfo.title} - ${qualityLabel}`,
                    url: videoData.data.videoUrl,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: {
                                "Referer": MAIN_URL,
                                "User-Agent": "okhttp/4.12.0"
                            }
                        }
                    }
                });
            }
        }
        
        console.log(`[CastleTV] Found ${streams.length} streams!`);
        return streams;

    } catch (error) {
        console.error(`[CastleTV] Master Error: ${error.message}`);
        return [];
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
