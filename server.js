const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { format } = require('date-fns');

const dbPath = '/persistent/birds.db';  // ✅ Ensure dbPath is set before use

// ✅ Ensure database exists before connecting to it
if (!fs.existsSync(dbPath)) {
    console.log("📥 Downloading birds.db from GitHub...");
    exec(`curl -o ${dbPath} https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/birds.db`, (error) => {
        if (error) {
            console.error("❌ Error downloading database:", error);
        } else {
            console.log("✅ Database downloaded successfully.");
        }
    });
} else {
    console.log("✅ Database file exists at", dbPath);
}

const app = express();
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("❌ Could not connect to database:", err.message);
    } else {
        console.log("✅ Connected to SQLite database.");
    }
});

const IMAGES_FOLDER = path.join(__dirname, 'public/images');

app.use(cors());
app.use(express.json());
app.use('/images', express.static(IMAGES_FOLDER));

const speciesCache = {};
let allSpecies = [];

// ✅ Run process_images.py on Firebase images after database is ready
db.serialize(() => {
    db.all("SELECT name FROM sqlite_master WHERE type='table';", [], (err, rows) => {
        if (err) {
            console.error("❌ Database error:", err);
        } else {
            console.log("✅ Tables in database:", rows);
            
            // ✅ Only run the script after confirming the database is ready
            console.log("📸 Processing images from Firebase...");
            exec("python3 process_images.py --firebase", (error, stdout, stderr) => {
                if (error) {
                    console.error(`❌ Error running process_images.py: ${error.message}`);
                    return;
                }
                if (stderr) {
                    console.error(`⚠️ Python script stderr: ${stderr}`);
                }
                console.log(`✅ Python script output:\n${stdout}`);
            });
        }
    });
});

// ✅ Keeps species suggestion functionality
async function preloadSpecies() {
    const cacheFile = './species_cache.json';

    if (fs.existsSync(cacheFile)) {
        console.log("✅ Loading species from cache...");
        allSpecies = JSON.parse(fs.readFileSync(cacheFile));
        return;
    }

    console.log("🔄 Fetching full eBird species list...");
    try {
        const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
        allSpecies = response.data.map(species => species.comName);
        fs.writeFileSync(cacheFile, JSON.stringify(allSpecies));
        console.log(`✅ Cached ${allSpecies.length} species.`);
    } catch (error) {
        console.error("❌ Failed to fetch eBird species list:", error);
    }
}

preloadSpecies();

app.get('/api/photos', (req, res) => {
    const query = `
        SELECT bird_photos.id, bird_photos.image_filename, bird_photos.date_taken, bird_photos.location, 
               bird_photos.latitude, bird_photos.longitude,
               COALESCE(GROUP_CONCAT(bird_species.common_name, ', '), 'Unknown') AS species_names
        FROM bird_photos
        LEFT JOIN bird_photo_species ON bird_photos.id = bird_photo_species.photo_id
        LEFT JOIN bird_species ON bird_photo_species.species_id = bird_species.id
        GROUP BY bird_photos.id
        ORDER BY RANDOM()
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ error: "Error fetching photos" });
        }

        rows.forEach(row => {
            if (row.date_taken) {
                row.date_taken = format(new Date(row.date_taken), "d MMMM yyyy");
            }

            // 🔹 Convert filename to Firebase Storage URL with token
            row.image_filename = `https://firebasestorage.googleapis.com/v0/b/bird-pictures-953b0.firebasestorage.app/o/${encodeURIComponent(row.image_filename)}?alt=media`;
        });

        res.json(rows);
    });
});

// ✅ Keeps `/api/species-suggestions` as requested
app.get('/api/species-suggestions', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) {
        return res.json([]);
    }

    const lowerQuery = query.toLowerCase();
    if (speciesCache[lowerQuery]) {
        return res.json(speciesCache[lowerQuery]);
    }

    const speciesList = allSpecies
        .filter(name => name.toLowerCase().startsWith(lowerQuery))
        .slice(0, 5);

    speciesCache[lowerQuery] = speciesList;
    res.json(speciesList);
});

// **Check Database Tables**
db.all("SELECT name FROM sqlite_master WHERE type='table';", [], (err, rows) => {
    if (err) {
        console.error("❌ Database error:", err);
    } else {
        console.log("✅ Tables in database:", rows);
    }
});

// **Start Server**
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
