const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { format } = require('date-fns');

const app = express();
const db = new sqlite3.Database('/persistent/birds.db');
const IMAGES_FOLDER = path.join(__dirname, 'public/images');

app.use(cors());
app.use(express.json());
app.use('/images', express.static(IMAGES_FOLDER));

const speciesCache = {};
let allSpecies = [];

console.log("📸 Syncing images one time on server start...");
exec("python3 process_images.py", (error, stdout, stderr) => {
    if (error) {
        console.error(`❌ Error running process_images.py: ${error.message}`);
        return;
    }
    if (stderr) {
        console.error(`⚠️ Python script stderr: ${stderr}`);
    }
    console.log(`✅ Python script output:\n${stdout}`);
});

// **Preload eBird Species List (Cached)**
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




// **Species Suggestions (Instant Search)**
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

// **Update Location**
app.post('/api/update-location', (req, res) => {
    const { photo_id, location } = req.body;
    if (!photo_id || !location) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    db.run("UPDATE bird_photos SET location = ? WHERE id = ?", 
        [location, photo_id], (err) => {
            if (err) {
                console.error("❌ Update Error:", err);
                return res.status(500).json({ error: "Failed to update location" });
            }
            res.json({ message: "✅ Location updated successfully!" });
        });
});

// **Update Species**
app.post('/api/update-species', async (req, res) => {
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    db.get("SELECT id FROM bird_species WHERE common_name = ?", [common_name], (err, speciesRow) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ error: "Database error" });
        }

        if (speciesRow) {
            // ✅ If species exists, link it to the photo
            db.run("INSERT OR IGNORE INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)", 
                   [photo_id, speciesRow.id], (err) => {
                if (err) {
                    console.error("❌ Insert Error:", err);
                    return res.status(500).json({ error: "Failed to associate species" });
                }
                res.json({ message: "✅ Species added successfully!" });
            });
        } else {
            // ✅ If species doesn't exist, insert it first
            db.run("INSERT INTO bird_species (common_name) VALUES (?)", [common_name], function (err) {
                if (err) {
                    console.error("❌ Insert Error:", err);
                    return res.status(500).json({ error: "Failed to add species" });
                }

                const newSpeciesId = this.lastID;
                db.run("INSERT INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)", 
                       [photo_id, newSpeciesId], (err) => {
                    if (err) {
                        console.error("❌ Insert Error:", err);
                        return res.status(500).json({ error: "Failed to associate new species" });
                    }
                    res.json({ message: `✅ New species '${common_name}' added and linked successfully!` });
                });
            });
        }
    });
});


app.post('/api/remove-species', (req, res) => {
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    db.get("SELECT id FROM bird_species WHERE common_name = ?", [common_name], (err, speciesRow) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ error: "Database error" });
        }

        if (!speciesRow) {
            return res.status(400).json({ error: "Species not found" });
        }

        db.run("DELETE FROM bird_photo_species WHERE photo_id = ? AND species_id = ?", 
            [photo_id, speciesRow.id], (err) => {
            if (err) {
                console.error("❌ Delete Error:", err);
                return res.status(500).json({ error: "Failed to remove species" });
            }
            res.json({ message: "✅ Species removed successfully!" });
        });
    });
});

app.get('/api/species-suggestions-ai', (req, res) => {
    const query = `
        SELECT id, image_filename, species_suggestions 
        FROM bird_photos
        WHERE species_suggestions IS NOT NULL
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ error: "Error fetching AI species suggestions" });
        }

        res.json(rows);
    });
});


// **Start Server**
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
