const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { format } = require('date-fns');

const dbPath = '/persistent/birds.db';  // ✅ Ensure dbPath is set before use
const FRONTEND_DIR = path.join(__dirname, 'public'); // ✅ Directory for frontend files

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

// Improved error handling for database connection
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("❌ Could not connect to database:", err.message);
        process.exit(1); // Exit process if database connection fails
    } else {
        console.log("✅ Connected to SQLite database.");
    }
});

// ✅ Serve static files from the public folder
app.use(express.static(FRONTEND_DIR));

// ✅ Serve "home.html" at "/home" 
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// ✅ Serve ".html" at "/admin" 
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Remove redundant express.static(FRONTEND_DIR)
app.use('/api', (req, res, next) => {
    next(); // Allow API routes to be handled first
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

app.post('/api/update-photographer', (req, res) => {
    const { photo_id, photographer } = req.body;

    if (!photo_id || !photographer) {
        return res.status(400).json({ error: "Missing photo_id or photographer name" });
    }

    // Step 1: Check if photographer exists in users table
    const checkUserQuery = `SELECT id FROM users WHERE name = ?`;

    db.get(checkUserQuery, [photographer], (err, user) => {
        if (err) {
            console.error("❌ Error checking user:", err);
            return res.status(500).json({ error: "Database error checking user" });
        }

        if (!user) {
            // Step 2: If user does not exist, insert them
            const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
            db.run(insertUserQuery, [photographer], function (err) {
                if (err) {
                    console.error("❌ Error inserting user:", err);
                    return res.status(500).json({ error: "Database error inserting user" });
                }

                const newUserId = this.lastID;

                // Step 3: Update bird_photos with new user ID
                const updatePhotoQuery = `UPDATE bird_photos SET photographer_id = ? WHERE id = ?`;
                db.run(updatePhotoQuery, [newUserId, photo_id], function (err) {
                    if (err) {
                        console.error("❌ Error updating photo:", err);
                        return res.status(500).json({ error: "Database error updating photo" });
                    }

                    console.log(`✅ Photographer updated for photo ${photo_id}: ${photographer} (New User ID: ${newUserId})`);
                    res.json({ message: "Photographer updated successfully", photo_id, photographer });
                });
            });
        } else {
            // Step 4: If user exists, just update bird_photos with existing user ID
            const updatePhotoQuery = `UPDATE bird_photos SET photographer_id = ? WHERE id = ?`;
            db.run(updatePhotoQuery, [user.id, photo_id], function (err) {
                if (err) {
                    console.error("❌ Error updating photo:", err);
                    return res.status(500).json({ error: "Database error updating photo" });
                }

                console.log(`✅ Photographer updated for photo ${photo_id}: ${photographer} (Existing User ID: ${user.id})`);
                res.json({ message: "Photographer updated successfully", photo_id, photographer });
            });
        }
    });
});



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
    console.log("🔍 Received request for /api/photos");

    if (!db) {
        console.error("❌ Database connection is not established.");
        return res.status(500).json({ error: "Database connection failed" });
    }

    const query = `
        SELECT bird_photos.id, bird_photos.image_filename, bird_photos.date_taken, 
               bird_photos.location, bird_photos.latitude, bird_photos.longitude, 
               COALESCE(users.name, 'Unknown') AS photographer,  
               COALESCE(
                   GROUP_CONCAT(bird_species.common_name, ', '), 'Unknown'
               ) AS species_names
        FROM bird_photos
        LEFT JOIN bird_photo_species ON bird_photos.id = bird_photo_species.photo_id
        LEFT JOIN bird_species ON bird_photo_species.species_id = bird_species.id
        LEFT JOIN users ON bird_photos.photographer_id = users.id
        WHERE bird_photos.approved = 1 
        GROUP BY bird_photos.id
        ORDER BY RANDOM()
        LIMIT 100;
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ error: "Error fetching photos" });
        }

        if (!rows || rows.length === 0) {
            console.warn("⚠️ No photos found in the database.");
            return res.json([]);
        }

        console.log(`✅ Fetched ${rows.length} photos from database.`);

        // Format data properly
        rows.forEach(row => {
            if (row.date_taken) {
                try {
                    row.date_taken = format(new Date(row.date_taken), "d MMMM yyyy");
                } catch (error) {
                    console.warn(`⚠️ Invalid date format for ${row.image_filename}:`, row.date_taken);
                    row.date_taken = "Unknown date";
                }
            } else {
                row.date_taken = "Unknown date";
            }

            // Prevent double URL encoding issues
            if (row.image_filename && row.image_filename.startsWith("http")) {
                row.image_filename = row.image_filename;
            } else {
                row.image_filename = `https://firebasestorage.googleapis.com/v0/b/bird-pictures-953b0.firebasestorage.app/o/${encodeURIComponent(row.image_filename)}?alt=media`;
            }
        });

        res.json(rows);
    });
});



app.get('/api/species-suggestions', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) {
        return res.json([]);
    }

    const lowerQuery = query.toLowerCase();

    if (speciesCache[lowerQuery]) {
        return res.json(speciesCache[lowerQuery]);
    }

    // Improved search: Matches anywhere in the species name, prioritizes those that start with the query
    const speciesList = allSpecies
        .filter(name => name.toLowerCase().includes(lowerQuery)) // Matches anywhere in the name
        .sort((a, b) => {
            const aStartsWith = a.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            const bStartsWith = b.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            return aStartsWith - bStartsWith; // Prioritize species that start with the query
        })
        .slice(0, 5); // Limit results to 5 suggestions

    speciesCache[lowerQuery] = speciesList;
    res.json(speciesList);
});

app.post('/api/update-species', async (req, res) => {
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    try {
        // Step 1: Check if species exists and retrieve its id and scientific_name
        const findSpeciesQuery = `SELECT id, scientific_name FROM bird_species WHERE common_name = ?`;

        db.get(findSpeciesQuery, [common_name], async (err, species) => {
            if (err) {
                console.error("❌ Error finding species:", err.message);
                return res.status(500).json({ error: "Failed to find species" });
            }

            if (!species) {
                // Step 2: Fetch species details from eBird API
                let scientificName = null;
                let family = null;
                let orderName = null;
                let status = "Not Extinct";

                try {
                    const response = await fetch(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
                    const speciesData = await response.json();
                    const speciesMatch = speciesData.find(s => s.comName.toLowerCase() === common_name.toLowerCase());

                    if (speciesMatch) {
                        scientificName = speciesMatch.sciName;
                        family = speciesMatch.familyComName;
                        orderName = speciesMatch.order;
                        if (speciesMatch.extinct) status = "Extinct";
                    } else {
                        console.warn(`⚠️ No eBird match found for: ${common_name}`);
                    }
                } catch (apiError) {
                    console.error("❌ Error fetching eBird data:", apiError);
                }

                // Step 3: Insert new species with the extra details
                const insertSpeciesQuery = `
                    INSERT INTO bird_species (common_name, scientific_name, family, order_name, status) 
                    VALUES (?, ?, ?, ?, ?)
                `;

                db.run(insertSpeciesQuery, [common_name, scientificName, family, orderName, status], function (err) {
                    if (err) {
                        console.error("❌ Error inserting species:", err.message);
                        return res.status(500).json({ error: "Failed to insert species" });
                    }

                    console.log(`✅ Inserted new species: ${common_name} (${scientificName})`);
                    linkSpeciesToPhoto(photo_id, this.lastID, res);
                });

            } else {
                // If species exists, update its extra information if missing
                if (!species.scientific_name) {
                    try {
                        const response = await fetch(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
                        const speciesData = await response.json();
                        const speciesMatch = speciesData.find(s => s.comName.toLowerCase() === common_name.toLowerCase());

                        if (speciesMatch) {
                            const updateQuery = `
                                UPDATE bird_species 
                                SET scientific_name = ?, family = ?, order_name = ?, status = ?
                                WHERE id = ?
                            `;
                            db.run(updateQuery, [
                                speciesMatch.sciName, speciesMatch.familyComName, speciesMatch.order,
                                speciesMatch.extinct ? "Extinct" : "Not Extinct",
                                species.id
                            ]);
                            console.log(`✅ Updated species: ${common_name} (${speciesMatch.sciName})`);
                        }
                    } catch (error) {
                        console.error("⚠️ Failed to fetch scientific name for existing species:", error);
                    }
                }

                // Step 4: Link species to the photo
                linkSpeciesToPhoto(photo_id, species.id, res);
            }
        });
    } catch (error) {
        console.error("❌ Server error updating species:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/api/pending-photos', (req, res) => {
    const query = `
      SELECT bird_photos.id, bird_photos.image_filename, bird_photos.date_taken, 
             bird_photos.location, bird_photos.latitude, bird_photos.longitude, 
             COALESCE(users.name, 'Unknown') AS photographer,  
             COALESCE(
                 GROUP_CONCAT(bird_species.common_name, ', '), 'Unknown'
             ) AS species_names
      FROM bird_photos
      LEFT JOIN bird_photo_species ON bird_photos.id = bird_photo_species.photo_id
      LEFT JOIN bird_species ON bird_photo_species.species_id = bird_species.id
      LEFT JOIN users ON bird_photos.photographer_id = users.id  
      WHERE bird_photos.approved != 1
      GROUP BY bird_photos.id
      ORDER BY bird_photos.date_taken DESC;
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching pending photos:", err);
            return res.status(500).json({ error: "Error fetching pending photos" });
        }
        res.json(rows);
    });
});


app.post('/api/add-photo', (req, res) => {
    const { image_url, date_taken, location, latitude, longitude } = req.body;
  
    if (!image_url) {
      return res.status(400).json({ error: "Missing image_url" });
    }
  
    const query = `
      INSERT INTO bird_photos (image_filename, date_taken, location, latitude, longitude, approved)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
  
    db.run(query, [image_url, date_taken || null, location || "Unknown", latitude || null, longitude || null], function(err) {
      if (err) {
        console.error("❌ Error adding photo:", err.message);
        return res.status(500).json({ error: "Failed to add photo" });
      }
  
      // ✅ Return metadata clearly to frontend
      res.json({
        photo_id: this.lastID,
        image_url,
        date_taken,
        location,
        latitude,
        longitude
      });
    });
  });
  
  app.post('/api/update-photo-details', (req, res) => {
    const { photo_id, date_taken, location, photographer } = req.body;
  
    if (!photo_id) {
      return res.status(400).json({ error: "Missing photo_id" });
    }
  
    db.run(`
      UPDATE bird_photos SET
        date_taken = ?, 
        location = ?, 
        photographer = ?
      WHERE id = ?
    `, [date_taken || null, location || 'Unknown', photographer || 'Unknown', photo_id], function(err) {
      if (err) {
        console.error("❌ Error updating photo details:", err.message);
        return res.status(500).json({ error: "Failed to update photo details" });
      }
      console.log(`✅ Photo ${photo_id} updated successfully.`);
      res.json({ message: "Details updated successfully", photo_id });
    });
  });
    

  
app.post('/api/approve-photo', (req, res) => {
    const { photo_id } = req.body;
    if (!photo_id) {
        return res.status(400).json({ error: "Missing photo_id" });
    }
    const query = `UPDATE bird_photos SET approved = 1 WHERE id = ?`;
    db.run(query, [photo_id], function (err) {
        if (err) {
            console.error("❌ Error approving photo:", err);
            return res.status(500).json({ error: "Error approving photo" });
        }
        console.log(`✅ Photo ${photo_id} approved`);
        res.json({ message: "Photo approved", photo_id });
    });
});


// ✅ Helper function to link species to photo (supports multiple species per image)
function linkSpeciesToPhoto(photo_id, species_id, res) {
    const checkExistingQuery = `
        SELECT * FROM bird_photo_species WHERE photo_id = ? AND species_id = ?
    `;

    db.get(checkExistingQuery, [photo_id, species_id], (err, row) => {
        if (err) {
            console.error("❌ Error checking existing link:", err.message);
            return res.status(500).json({ error: "Failed to check existing species link" });
        }

        if (row) {
            console.log(`⚠️ Species ${species_id} is already linked to photo ${photo_id}, skipping.`);
            return res.json({ message: "Species already linked", photo_id, species_id });
        }

        const insertRelationQuery = `
            INSERT INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)
        `;

        db.run(insertRelationQuery, [photo_id, species_id], function (err) {
            if (err) {
                console.error("❌ Error linking species to photo:", err.message);
                return res.status(500).json({ error: "Failed to link species to photo" });
            }

            console.log(`✅ Linked species ${species_id} to photo ${photo_id}`);
            res.json({ message: "Species updated successfully", photo_id, species_id });
        });
    });
}


function filterPhotos() {
    const selectedSpecies = document.getElementById("species-filter").value;

    if (selectedSpecies === "all") {
        displayPhotos(allPhotos); // Show all photos if "All Species" is selected
    } else {
        const filteredPhotos = allPhotos.filter(photo =>
            photo.species_names && photo.species_names.includes(selectedSpecies)
        );
        displayPhotos(filteredPhotos); // Show only matching species
    }
}



app.post('/api/update-location', (req, res) => {
    const { photo_id, location } = req.body;

    if (!photo_id || !location) {
        return res.status(400).json({ error: "Missing photo_id or location" });
    }

    const query = `UPDATE bird_photos SET location = ? WHERE id = ?`;

    db.run(query, [location, photo_id], function (err) {
        if (err) {
            console.error("❌ Error updating location:", err.message);
            return res.status(500).json({ error: "Failed to update location" });
        }
        console.log(`✅ Location updated for photo ${photo_id}: ${location}`);
        res.json({ message: "Location updated successfully", photo_id, location });
    });
});

app.post('/api/remove-species', (req, res) => {
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    const query = `
        DELETE FROM bird_photo_species 
        WHERE photo_id = ? 
        AND species_id = (SELECT id FROM bird_species WHERE common_name = ?)
    `;

    db.run(query, [photo_id, common_name], function (err) {
        if (err) {
            console.error("❌ Error removing species:", err.message);
            return res.status(500).json({ error: "Failed to remove species" });
        }
        console.log(`✅ Species removed from photo ${photo_id}: ${common_name}`);
        res.json({ message: "Species removed successfully", photo_id, common_name });
    });
});



// ✅ Serve index.html for any non-API request (Frontend Routing)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running at https://birdpics.pics/`);
});