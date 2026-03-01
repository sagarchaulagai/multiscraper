const fetch = require('node-fetch');

const MAIN_URL = "https://kisskh.id";
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const VIDEO_KEY_URL = "https://script.google.com/macros/s/AKfycbzn8B31PuDxzaMa9_CQ0VGEDasFqfzI5bXvjaIZH4DM8DNq9q6xj1ALvZNz_JT3jF0suA/exec?id=";

// The Ultimate Disguise: Using got-scraping to spoof Chrome's TLS fingerprint
async function safeFetchJson(url, refererUrl = `${MAIN_URL}/`) {
    // We use a dynamic import because got-scraping is an ESM library
    const { gotScraping } = await import('got-scraping');
    
    try {
        const res = await gotScraping({
            url: url,
            headers: {
                "Referer": refererUrl
            },
            responseType: 'text',
            timeout: { request: 8000 } // 8 second killswitch
        });

        const text = res.body;
        if (text.trim().startsWith('<')) {
            throw new Error("Blocked by Cloudflare JS Challenge (Received HTML)");
        }
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`Spoofer Error: ${err.message}`);
    }
}

// We can still use normal fetch for TMDB because they don't block us
async function getTMDBDetails(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const title = mediaType === 'tv' ? data.name : data.title;
        return { title };
    } catch (err) {
        return { title: `TMDB ID ${tmdbId}` };
    }
}

async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    console.log(`[KissKH] Fetching streams for TMDB ID: ${tmdbId}`);

    try {
        const mediaInfo = await getTMDBDetails(tmdbId, mediaType);
        
        // 1. Search KissKH Database (Using Spoofer)
        const searchUrl = `${MAIN_URL}/api/DramaList/Search?q=${encodeURIComponent(mediaInfo.title)}&type=0`;
        const searchData = await safeFetchJson(searchUrl);

        if (!searchData || searchData.length === 0) {
            console.log(`[KissKH] No search results found for ${mediaInfo.title}`);
            return [];
        }

        // Find the best match
        const match = searchData.find(item => item.title.toLowerCase().includes(mediaInfo.title.toLowerCase()));
        if (!match) {
            console.log(`[KissKH] No exact title match found for ${mediaInfo.title}`);
            return [];
        }

        // 2. Get Details to find the correct Episode ID
        const formattedTitle = match.title.replace(/[^a-zA-Z0-9]/g, "-");
        const detailsUrl = `${MAIN_URL}/api/DramaList/Drama/${match.id}?isq=false`;
        
        const detailsData = await safeFetchJson(detailsUrl, `${MAIN_URL}/Drama/${formattedTitle}?id=${match.id}`);

        if (!detailsData || !detailsData.episodes || detailsData.episodes.length === 0) return [];

        let targetEpisode = null;
        if (mediaType === 'tv') {
            targetEpisode = detailsData.episodes.find(e => Math.floor(e.number) === parseInt(episodeNum));
        } else {
            targetEpisode = detailsData.episodes[0];
        }

        if (!targetEpisode) {
            console.log(`[KissKH] Episode ${episodeNum} not found in their list.`);
            return [];
        }

        // 3. Generate Video Unlock Token (kkey)
        const keyReqUrl = `${VIDEO_KEY_URL}${targetEpisode.id}&version=2.8.10`;
        const keyData = await safeFetchJson(keyReqUrl);
        const kkey = keyData.key;

        if (!kkey) {
            console.log(`[KissKH] Failed to generate security token.`);
            return [];
        }

        // 4. Get Final Video Link
        const videoApiUrl = `${MAIN_URL}/api/DramaList/Episode/${targetEpisode.id}.png?err=false&ts=&time=&kkey=${kkey}`;
        const videoReferer = `${MAIN_URL}/Drama/${formattedTitle}/Episode-${targetEpisode.number}?id=${match.id}&ep=${targetEpisode.id}&page=0&pageSize=100`;

        const videoData = await safeFetchJson(videoApiUrl, videoReferer);

        const streams = [];

        // Note: KissKH often uses an origin header for video playback
        if (videoData.Video) {
            streams.push({
                name: "KissKH",
                title: `${mediaInfo.title} - HD`,
                url: videoData.Video,
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            "Origin": MAIN_URL,
                            "Referer": `${MAIN_URL}/`
                        }
                    }
                }
            });
        }

        if (videoData.ThirdParty) {
             streams.push({
                name: "KissKH (Alt)",
                title: `${mediaInfo.title} - Alt Server`,
                url: videoData.ThirdParty,
                 behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            "Origin": MAIN_URL,
                            "Referer": `${MAIN_URL}/`
                        }
                    }
                }
            });
        }

        console.log(`[KissKH] Successfully extracted ${streams.length} streams!`);
        return streams;

    } catch (error) {
        console.error(`[KissKH] Master Error: ${error.message}`);
        return [];
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
