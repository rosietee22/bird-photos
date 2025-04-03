const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const { format } = require('date-fns');
const session = require('express-session');

const dbPath = '/persistent/birds.db'; // ✅ Ensure dbPath is set before use
const FRONTEND_DIR = path.join(__dirname, 'public'); // ✅ Directory for frontend files

const app = express();

// --- SESSION CONFIGURATION START ---
app.set('trust proxy', 1);

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'SUPER_SECRET_KEY',
        resave: false,
        saveUninitialized: true,
        cookie: {
            maxAge: 1000 * 60 * 60, // 1 hour
            secure: 'auto',
            httpOnly: true,
            sameSite: 'lax'
        }
    })
);
// --- SESSION CONFIGURATION END ---

// Add Cross-Origin-Opener-Policy header
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

// Database init
let db = null;
try {
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            console.error("❌ Could not connect to database:", err.message);
            if (fs.existsSync(dbPath)) {
                db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err2) => {
                    if (err2) {
                        console.error("❌ Also failed read-only:", err2.message);
                        process.exit(1);
                    } else {
                        console.warn("⚠️ Connected in READ-ONLY mode.");
                    }
                });
            } else {
                process.exit(1);
            }
        } else {
            console.log("✅ Connected to SQLite database (read-write).");
            db.run('PRAGMA journal_mode=WAL;', (pragmaErr) => {
                if (pragmaErr) {
                    console.warn("⚠️ Could not set WAL:", pragmaErr.message);
                } else {
                    console.log("✅ Set PRAGMA journal_mode=WAL.");
                }
            });
        }
    });
} catch (e) {
    console.error("❌ Exception during DB connection:", e.message);
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(FRONTEND_DIR));

// Auth middleware
function requireLogin(req, res, next) {
    if (req.session && req.session.loggedIn) {
        return next();
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        console.warn("⚠️ Unauthorized API access attempt blocked by requireLogin.");
        return res.status(401).json({ error: 'Authentication required.' });
    } else {
        return res.redirect('/login');
    }
}

// --- Page Routes ---
app.get('/home', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'home.html'));
});

app.get('/admin', requireLogin, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'upload.html'));
});

app.get('/approval', requireLogin, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'approval.html'));
});

// Login
app.get('/login', (req, res) => {
    if (req.session.loggedIn) {
        return res.redirect('/approval');
    }
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Login - Bird Pictures</title><link rel="stylesheet" href="styles.css"/></head>
      <body>
        <div class="login-container">
          <h2 style="margin-top: 0;">Login</h2>
          <form method="POST" action="/login">
            <label style="font-size:13px;"><strong>Password:</strong></label>
            <br>
            <input type="password" name="password" required/>
            <br>
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
      </html>
    `);
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === (process.env.ADMIN_PASSWORD || 'wildlife')) {
        req.session.loggedIn = true;
        req.session.save(err => {
            if (err) {
                console.error("Session save error:", err);
                return res.status(500).send("Error logging in.");
            }
            res.redirect('/approval');
        });
    } else {
        res.status(401).send('Invalid password. <a href="/login">Try again</a>');
    }
});

// eBird species preload
const speciesCache = {};
let allSpecies = [];
async function preloadSpecies() {
    const cacheFile = './species_cache.json';
    try {
        if (fs.existsSync(cacheFile)) {
            console.log("✅ Loading species from cache...");
            const fileContent = fs.readFileSync(cacheFile, 'utf8');
            allSpecies = JSON.parse(fileContent);
            console.log(`✅ Loaded ${allSpecies.length} species from cache.`);
        } else {
            console.log("🔄 Fetching full eBird species list (cache file not found)...");
            const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
            allSpecies = response.data.map(s => s.comName);
            fs.writeFileSync(cacheFile, JSON.stringify(allSpecies));
            console.log(`✅ Cached ${allSpecies.length} species.`);
        }
    } catch (error) {
        console.error("❌ Failed to load/fetch eBird species list:", error.message);
    }
}
preloadSpecies();

// --- /api/photos (Approved) ---
app.get('/api/photos', (req, res) => {
    console.log("🔍 Received request for /api/photos");
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const query = `
        SELECT
            bp.id, 
            bp.image_filename, 
            bp.date_taken, 
            bp.location,
            bp.latitude, 
            bp.longitude, 
            bp.species_suggestions,
            COALESCE(u.name, 'Unknown') AS photographer,
            COALESCE(
                REPLACE(GROUP_CONCAT(DISTINCT bs.common_name), ',', ', '),
                'Unknown'
            ) AS species_names
        FROM bird_photos bp
        LEFT JOIN bird_photo_species bps ON bp.id = bps.photo_id
        LEFT JOIN bird_species bs ON bps.species_id = bs.id
        LEFT JOIN users u ON bp.photographer_id = u.id
        WHERE bp.approved = 1
        GROUP BY bp.id
        ORDER BY RANDOM()
        LIMIT 100;
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching photos:", err.message);
            return res.status(500).json({ error: "Error fetching photos" });
        }
        // Format date
        rows.forEach(row => {
            row.date_taken_formatted = "Unknown date";
            if (row.date_taken) {
                try {
                    const utcDate = new Date(row.date_taken);
                    if (!isNaN(utcDate)) {
                        row.date_taken_formatted = format(utcDate, "d MMMM yy");
                    } else {
                        row.date_taken_formatted = "Invalid date";
                    }
                } catch (formatError) {
                    console.warn(`⚠️ Invalid date format:`, formatError.message);
                }
            }
        });
        console.log(`✅ Fetched ${rows.length} approved photos.`);
        res.json(rows);
    });
});

// --- /api/pending-photos ---
app.get('/api/pending-photos', (req, res) => {
    console.log("🔍 Request for /api/pending-photos.");
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const query = `
      SELECT
          bp.id, 
          bp.image_filename, 
          bp.date_taken, 
          bp.location,
          bp.latitude, 
          bp.longitude, 
          bp.species_suggestions,
          COALESCE(u.name, 'Unknown') AS photographer,
          COALESCE(
              REPLACE(GROUP_CONCAT(DISTINCT bs.common_name), ',', ', '),
              'Unknown'
          ) AS species_names
      FROM bird_photos bp
      LEFT JOIN bird_photo_species bps ON bp.id = bps.photo_id
      LEFT JOIN bird_species bs ON bps.species_id = bs.id
      LEFT JOIN users u ON bp.photographer_id = u.id
      WHERE bp.approved != 1 OR bp.approved IS NULL
      GROUP BY bp.id
      ORDER BY bp.id DESC;
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching pending photos:", err.message);
            return res.status(500).json({ error: "Error fetching pending photos" });
        }
        rows.forEach(row => {
            row.date_taken_formatted = "Unknown date";
            if (row.date_taken) {
                try {
                    const utcDate = new Date(row.date_taken);
                    if (!isNaN(utcDate)) {
                        row.date_taken_formatted = format(utcDate, "d MMMM yy");
                    } else {
                        row.date_taken_formatted = "Invalid date";
                    }
                } catch (formatError) {
                    console.warn(`⚠️ Invalid date format:`, formatError.message);
                }
            }
        });
        console.log(`✅ Fetched ${rows.length} pending photos.`);
        res.json(rows);
    });
});

// --- /api/add-photo ---
app.post('/api/add-photo', (req, res) => {
    // If you want to protect this route (e.g., from Cloud Function only), do it here
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const { image_url, date_taken, location, latitude, longitude, photographer, species_suggestions } = req.body;
    if (!image_url) {
        return res.status(400).json({ error: "Missing image_url" });
    }

    const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
    const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
    const photographerName = photographer || "Unknown";

    db.get(findUserQuery, [photographerName], (err, user) => {
        if (err) {
            console.error("DB error finding user:", err.message);
            return res.status(500).json({ error: "DB error finding user" });
        }
        const insertPhoto = (p_id) => {
            const query = `
                INSERT INTO bird_photos
                  (image_filename, date_taken, location, latitude, longitude, approved, photographer_id, species_suggestions)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            `;
            const params = [
                image_url,
                date_taken || null,
                location || "Unknown",
                latitude || null,
                longitude || null,
                p_id,
                species_suggestions || null
            ];
            db.run(query, params, function (err2) {
                if (err2) {
                    console.error("Failed to add photo record:", err2.message);
                    return res.status(500).json({ error: "Failed to add photo record" });
                }
                console.log(`✅ Photo record added. ID: ${this.lastID}, Suggestion: ${species_suggestions}`);
                return res.status(201).json({ photo_id: this.lastID });
            });
        };

        if (user) {
            insertPhoto(user.id);
        } else if (photographerName !== "Unknown") {
            db.run(insertUserQuery, [photographerName], function (insertErr) {
                if (insertErr) {
                    console.error("Failed to add photographer:", insertErr.message);
                    return res.status(500).json({ error: "Failed to add photographer" });
                }
                insertPhoto(this.lastID);
            });
        } else {
            insertPhoto(null);
        }
    });
});

// --- /api/species-suggestions (public text-based)
app.get('/api/species-suggestions', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) {
        return res.json([]);
    }
    const lowerQuery = query.toLowerCase();
    // Filter from allSpecies
    const filtered = allSpecies
        .filter(name => name.toLowerCase().includes(lowerQuery))
        .sort((a, b) => {
            const aStarts = a.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            const bStarts = b.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            return aStarts - bStarts || a.localeCompare(b);
        })
        .slice(0, 7);

    res.json(filtered);
});

// --- /api/update-species (requires login if you want to protect it) ---
app.post('/api/update-species', (req, res) => {
    if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;
    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    // Try to find existing species
    const findSpeciesQuery = `SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`;
    db.get(findSpeciesQuery, [common_name], async (err, species) => {
        if (err) {
            console.error("DB error finding species:", err.message);
            return res.status(500).json({ error: "Failed to find species" });
        }
        if (species) {
            linkSpeciesToPhoto(photo_id, species.id, res, common_name);
        } else {
            // Insert new species if not found
            let scientificName = null, family = null, orderName = null, status = "LC";

            try {
                const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`, {
                    headers: { "User-Agent": "BirdPhotosApp/1.0" }
                });
                const speciesMatch = response.data.find(s => s.comName.toLowerCase() === common_name.toLowerCase());
                if (speciesMatch) {
                    scientificName = speciesMatch.sciName;
                    family = speciesMatch.familyComName;
                    orderName = speciesMatch.order;
                    // Use speciesMatch.extinct? or speciesMatch.reportAs? etc.
                } else {
                    console.warn(`⚠️ No eBird match for: ${common_name}`);
                }
            } catch (apiError) {
                console.error("❌ Error contacting eBird:", apiError.message);
            }

            const insertSpeciesQuery = `
                INSERT INTO bird_species (common_name, scientific_name, family, order_name, status)
                VALUES (?, ?, ?, ?, ?)
            `;
            db.run(insertSpeciesQuery, [common_name, scientificName, family, orderName, status], function (insertErr) {
                if (insertErr) {
                    console.error("❌ Error inserting species:", insertErr.message);
                    return res.status(500).json({ error: "Failed to insert species" });
                }
                linkSpeciesToPhoto(photo_id, this.lastID, res, common_name);
            });
        }
    });
});

// Helper: linkSpeciesToPhoto
function linkSpeciesToPhoto(photo_id, species_id, res, common_name) {
    if (!db) {
        console.error("DB is not available in linkSpeciesToPhoto");
        return;
    }
    const checkExisting = `SELECT 1 FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
    db.get(checkExisting, [photo_id, species_id], (err, row) => {
        if (err) {
            console.error("❌ Error checking existing link:", err.message);
            if (!res.headersSent) return res.status(500).json({ error: "DB error" });
        }
        if (row) {
            console.log(`ℹ️ Link already exists: Photo ${photo_id}, Species ${species_id}`);
            if (!res.headersSent) return res.json({ message: "Species already linked" });
        } else {
            const insertRel = `INSERT INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)`;
            db.run(insertRel, [photo_id, species_id], function (err2) {
                if (err2) {
                    console.error("❌ Error linking species:", err2.message);
                    if (!res.headersSent) return res.status(500).json({ error: "Failed linking species" });
                }
                console.log(`✅ Linked species ${species_id} (${common_name}) to photo ${photo_id}`);
                if (!res.headersSent) res.json({ message: "Species linked successfully" });
            });
        }
    });
}

// --- /api/remove-species
app.post('/api/remove-species', (req, res) => {
    if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;
    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }
    const findQ = `SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`;
    db.get(findQ, [common_name], (err, species) => {
        if (err) {
            console.error("DB error finding species:", err.message);
            return res.status(500).json({ error: "DB error" });
        }
        if (!species) {
            return res.status(404).json({ error: "Species not found" });
        }
        const delQ = `DELETE FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
        db.run(delQ, [photo_id, species.id], function (err2) {
            if (err2) {
                console.error("❌ Error removing species link:", err2.message);
                return res.status(500).json({ error: "DB error removing link" });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: "Species link not found for this photo" });
            }
            console.log(`✅ Species removed from photo ${photo_id}: ${common_name}`);
            res.json({ message: "Species removed successfully" });
        });
    });
});

// --- /api/update-photo-details
app.post('/api/update-photo-details', (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not ready" });
    const { photo_id, date_taken, location, photographer } = req.body;
    if (!photo_id) return res.status(400).json({ error: "Missing photo_id" });

    let fieldsToUpdate = [];
    let params = [];
    let photographerIdToSet = undefined;

    const doUpdate = () => {
        if (photographerIdToSet !== undefined) {
            fieldsToUpdate.push("photographer_id = ?");
            params.push(photographerIdToSet);
        }
        if (date_taken !== undefined) {
            fieldsToUpdate.push("date_taken = ?");
            params.push(date_taken || null);
        }
        if (location !== undefined) {
            fieldsToUpdate.push("location = ?");
            params.push(location || 'Unknown');
        }
        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ error: "No update fields provided" });
        }
        params.push(photo_id);
        const query = `UPDATE bird_photos SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;
        db.run(query, params, function (err) {
            if (err) {
                console.error("❌ Error updating photo details:", err.message);
                return res.status(500).json({ error: "Failed update photo details" });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: "Photo not found" });
            }
            console.log(`✅ Photo ${photo_id} updated successfully.`);
            return res.json({ message: "Details updated successfully" });
        });
    };

    // If we need to update "photographer"
    if (photographer !== undefined) {
        const photographerName = photographer || 'Unknown';
        const findUserQ = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
        const insertUserQ = `INSERT INTO users (name) VALUES (?)`;

        db.get(findUserQ, [photographerName], (err, user) => {
            if (err) {
                console.error("DB error finding user:", err.message);
                return res.status(500).json({ error: "DB error finding user" });
            }
            if (user) {
                photographerIdToSet = user.id;
                doUpdate();
            } else if (photographerName !== 'Unknown') {
                db.run(insertUserQ, [photographerName], function (insertErr) {
                    if (insertErr) {
                        console.error("DB error adding user:", insertErr.message);
                        return res.status(500).json({ error: "DB error adding user" });
                    }
                    photographerIdToSet = this.lastID;
                    doUpdate();
                });
            } else {
                photographerIdToSet = null;
                doUpdate();
            }
        });
    } else {
        doUpdate();
    }
});

// --- /api/approve-photo
app.post('/api/approve-photo', (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not ready" });
    const { photo_id } = req.body;
    if (!photo_id) return res.status(400).json({ error: "Missing photo_id" });

    const query = `UPDATE bird_photos SET approved = 1 WHERE id = ? AND (approved != 1 OR approved IS NULL)`;
    db.run(query, [photo_id], function (err) {
        if (err) {
            console.error("❌ Error approving photo:", err.message);
            return res.status(500).json({ error: "Error approving photo" });
        }
        if (this.changes === 0) {
            return res.status(200).json({ message: "Photo already approved or not found" });
        }
        console.log(`✅ Photo ${photo_id} approved.`);
        res.json({ message: "Photo approved successfully" });
    });
});

// --- /api/delete-photo
app.post('/api/delete-photo', (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not ready" });
    const { photo_id } = req.body;
    if (!photo_id) return res.status(400).json({ error: "Missing photo_id" });

    // 1) Find the record
    const selectQ = `SELECT image_filename FROM bird_photos WHERE id = ?`;
    db.get(selectQ, [photo_id], (err, row) => {
        if (err) {
            console.error("❌ DB error finding photo:", err.message);
            return res.status(500).json({ error: "DB error finding photo" });
        }
        if (!row) {
            return res.status(404).json({ error: "Photo record not found" });
        }
        const fileUrl = row.image_filename;

        // Wrap in a transaction
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            let success = true;

            // Delete from bird_photo_species
            db.run(`DELETE FROM bird_photo_species WHERE photo_id = ?`, [photo_id], function (linkErr) {
                if (linkErr) {
                    success = false;
                    console.error("❌ Error deleting species links:", linkErr.message);
                } else {
                    console.log(`✅ Deleted ${this.changes} species links for photo ${photo_id}`);
                }
            });

            // Delete from bird_photos
            db.run(`DELETE FROM bird_photos WHERE id = ?`, [photo_id], function (photoErr) {
                if (photoErr) {
                    success = false;
                    console.error("❌ Error deleting photo:", photoErr.message);
                } else if (this.changes === 0) {
                    success = false;
                    console.warn(`⚠️ Photo ${photo_id} not found during delete?`);
                } else {
                    console.log(`✅ Photo ${photo_id} deleted from DB.`);
                }
            });

            db.run(success ? "COMMIT;" : "ROLLBACK;", async (commitErr) => {
                if (commitErr || !success) {
                    console.error(commitErr ? `❌ Txn Error: ${commitErr.message}` : `❌ Txn rolled back.`);
                    if (!res.headersSent) res.status(500).json({ error: "DB delete failed" });
                    return;
                }
                console.log("✅ DB Deletion Txn successful.");

                // Optionally remove file from Firebase Storage – depends if you want that or not
                let decodedPath = null;
                if (fileUrl && fileUrl.includes('/o/')) {
                    try {
                        const urlObj = new URL(fileUrl);
                        const pathPart = urlObj.pathname.split('/o/')[1];
                        if (pathPart) {
                            decodedPath = decodeURIComponent(pathPart);
                        }
                    } catch (urlParseError) {
                        console.warn("⚠️ URL parse error in deletePhoto:", urlParseError.message);
                    }
                }

                if (decodedPath) {
                    // For real deletion, you'd do admin.storage().bucket(...).file(decodedPath).delete() if set up
                    console.log(`⚠️ Skipped Firebase file deletion. If needed, do it with your admin SDK. Path: "${decodedPath}"`);
                }

                if (!res.headersSent) {
                    res.json({ message: "Photo deleted successfully" });
                }
            });
        });
    });
});

// Fallback
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    } else {
        res.status(404).json({ error: "API endpoint not found" });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    if (db) {
        console.log(`🚀 Server running at http://localhost:${PORT} or https://birdpics.pics/`);
    } else {
        console.error("❌ Server starting but database connection FAILED.");
    }
});
