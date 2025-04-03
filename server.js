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

// --- MODIFIED SESSION CONFIGURATION START ---
// Trust the first proxy (important for environments like Render)
app.set('trust proxy', 1);

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'SUPER_SECRET_KEY', // Use a strong secret, preferably from env vars
        resave: false, // Don't save session if unmodified
        saveUninitialized: true, // Save new sessions even if empty (needed for login flow)
        cookie: {
            maxAge: 1000 * 60 * 60, // 1 hour
            secure: 'auto', // Sets Secure flag automatically based on connection (HTTPS)
            httpOnly: true, // Prevents client-side JS access to the cookie
            sameSite: 'lax' // Good default for session cookies
        }
        // Consider using a persistent session store for production if needed,
        // e.g., connect-sqlite3, but default MemoryStore might be okay for moderate use on Render.
    })
);
// --- MODIFIED SESSION CONFIGURATION END ---

// Add Cross-Origin-Opener-Policy header middleware
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

// Improved error handling for database connection
let db = null; // Initialize db as null
try {
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => { // Ensure read/write mode
        if (err) {
            console.error("❌ Could not connect to database:", err.message);
            // Optionally try read-only if read-write fails and db exists
            if (fs.existsSync(dbPath)) {
                 db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err2) => {
                     if (err2) {
                         console.error("❌ Also failed to open DB as read-only:", err2.message);
                         process.exit(1);
                     } else {
                         console.warn("⚠️ Connected to SQLite database in READ-ONLY mode.");
                     }
                 });
            } else {
                 process.exit(1); // Exit if connection fails and DB doesn't exist
            }
        } else {
            console.log("✅ Connected to SQLite database (read-write).");
            // Optional: Run PRAGMA journal_mode=WAL for potentially better performance
            db.run('PRAGMA journal_mode=WAL;', (pragmaErr) => {
                if (pragmaErr) {
                    console.warn("⚠️ Could not set PRAGMA journal_mode=WAL:", pragmaErr.message);
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


// Firebase Admin SDK (Commented out as likely not needed in server)
/*
const admin = require('firebase-admin');
try {
    admin.initializeApp({ storageBucket: 'bird-pictures-953b0.appspot.com' });
    console.log("✅ Firebase Admin SDK initialized.");
} catch(e) {
    console.error("❌ Firebase Admin SDK initialization failed:", e.message);
}
*/


// Middleware
app.use(cors()); // Enable CORS
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies


// Serve static files
app.use(express.static(FRONTEND_DIR));


// Authentication Middleware
function requireLogin(req, res, next) {
    // Check if session exists and loggedIn flag is true
    if (req.session && req.session.loggedIn) {
        return next(); // Proceed if logged in
    }
    // If AJAX request (like fetch), return 401 Unauthorized instead of redirecting to HTML
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
         console.warn("⚠️ Unauthorized API access attempt blocked by requireLogin.");
         return res.status(401).json({ error: 'Authentication required.' });
    } else {
         // For regular browser requests, redirect to login
         return res.redirect('/login');
    }
}

// --- Routes ---

// Frontend Page Routes
app.get('/home', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'home.html'));
});

app.get('/admin', requireLogin, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

app.get('/upload', (req, res) => {
    // This page doesn't require login itself, but actions initiated might
    res.sendFile(path.join(FRONTEND_DIR, 'upload.html'));
});

app.get('/approval', requireLogin, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'approval.html'));
});

// Login Routes
app.get('/login', (req, res) => {
    if (req.session.loggedIn) {
        return res.redirect('/approval'); // Redirect to approval if already logged in
    }
    // Simple login form
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Login - Bird Pictures</title><link rel="stylesheet" href="styles.css"/></head>
      <body><div class="login-container"><h2 style="margin-top: 0;">Login</h2><form method="POST" action="/login"><label style="font-size:13px;"><strong>Password:</strong></label><br><input type="password" name="password" required/><br><button type="submit">Login</button></form></div></body>
      </html>
    `);
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    // Use environment variable for password, fallback to default
    if (password === (process.env.ADMIN_PASSWORD || 'wildlife')) {
        req.session.loggedIn = true;
        // Ensure session is saved before redirecting, especially if store is async
        req.session.save(err => {
             if (err) {
                  console.error("Session save error:", err);
                  return res.status(500).send("Error logging in.");
             }
             res.redirect('/approval'); // Redirect to approval page after login
        });
    } else {
        res.status(401).send('Invalid password. <a href="/login">Try again</a>');
    }
});


// --- API Routes ---

// Preload species (eBird cache)
const speciesCache = {}; // For text suggestions
let allSpecies = []; // Full list from cache file

async function preloadSpecies() {
    const cacheFile = './species_cache.json'; // Ensure this path is correct relative to server.js
    try {
        if (fs.existsSync(cacheFile)) {
            console.log("✅ Loading species from cache...");
            const fileContent = fs.readFileSync(cacheFile, 'utf8');
            allSpecies = JSON.parse(fileContent);
            console.log(`✅ Loaded ${allSpecies.length} species from cache.`);
        } else {
            console.log("🔄 Fetching full eBird species list (cache file not found)...");
            const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
            allSpecies = response.data.map(species => species.comName);
            fs.writeFileSync(cacheFile, JSON.stringify(allSpecies));
            console.log(`✅ Cached ${allSpecies.length} species.`);
        }
    } catch (error) {
        console.error("❌ Failed to load or fetch eBird species list:", error.message);
    }
}
preloadSpecies(); // Load species on server start


// Get Approved Photos (Public - No Login Required)
app.get('/api/photos', (req, res) => {
    console.log("🔍 Received request for /api/photos");
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const query = `
        SELECT
            bp.id, bp.image_filename, bp.date_taken, bp.location,
            bp.latitude, bp.longitude, bp.species_suggestions,
            COALESCE(u.name, 'Unknown') AS photographer,
            COALESCE(GROUP_CONCAT(DISTINCT bs.common_name), 'Unknown') AS species_names
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
            console.error("❌ Database Error (fetching approved photos):", err.message);
            return res.status(500).json({ error: "Error fetching photos" });
        }
        // Format dates before sending
        rows.forEach(row => {
            row.date_taken_formatted = "Unknown date"; // Default
            if (row.date_taken) {
                 try {
                      const utcDate = new Date(row.date_taken);
                      if (!isNaN(utcDate)) {
                           row.date_taken_formatted = format(utcDate, "d MMMM yy"); // Use yy for year
                      } else {
                           row.date_taken_formatted = "Invalid date";
                      }
                 } catch (formatError) {
                      console.warn(`⚠️ Invalid date format for photo ${row.id}:`, row.date_taken, formatError.message);
                 }
            }
        });
        console.log(`✅ Fetched ${rows.length} approved photos.`);
        res.json(rows);
    });
});

// Get Pending Photos (Login Required)
app.get('/api/pending-photos', requireLogin, (req, res) => {
    console.log("🔍 Received request for /api/pending-photos by logged-in user.");
     if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const query = `
      SELECT
          bp.id, bp.image_filename, bp.date_taken, bp.location,
          bp.latitude, bp.longitude, bp.species_suggestions,
          COALESCE(u.name, 'Unknown') AS photographer,
          COALESCE(GROUP_CONCAT(DISTINCT bs.common_name), 'Unknown') AS species_names
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
         // Format dates before sending
         rows.forEach(row => {
             row.date_taken_formatted = "Unknown date"; // Default
             if (row.date_taken) {
                  try {
                       const utcDate = new Date(row.date_taken);
                       if (!isNaN(utcDate)) {
                             row.date_taken_formatted = format(utcDate, "d MMMM yy"); // Use yy for year
                       } else {
                            row.date_taken_formatted = "Invalid date";
                       }
                  } catch (formatError) {
                       console.warn(`⚠️ Invalid date format for photo ${row.id}:`, row.date_taken, formatError.message);
                  }
             }
         });
        console.log(`✅ Fetched ${rows.length} pending photos.`);
        res.json(rows);
    });
});

// Add Photo (Called by Cloud Function - Needs some form of auth)
app.post('/api/add-photo', (req, res) => {
    // TODO: Implement stronger auth than just a secret header if needed.
    // Or ensure the Cloud Function's service account has specific invoke permissions.
    const cloudFunctionSecret = req.headers['x-cloud-function-secret'];
     if (process.env.CLOUD_FUNCTION_SECRET && cloudFunctionSecret !== process.env.CLOUD_FUNCTION_SECRET) {
         console.warn("⚠️ Unauthorized attempt to call /api/add-photo (Secret Mismatch)");
         return res.status(403).json({ error: "Forbidden" });
     }

     if (!db) return res.status(503).json({ error: "Database connection not ready" });

    const { image_url, date_taken, location, latitude, longitude, photographer, species_suggestions } = req.body;

    if (!image_url) {
        return res.status(400).json({ error: "Missing image_url" });
    }

    // Use photographer_id instead of photographer_name if joining with users table
    // Find or create user first
     const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
     const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
     const photographerName = photographer || "Unknown";
     let photographerId = null;

     db.get(findUserQuery, [photographerName], (err, user) => {
          if (err) { /* handle error */ return res.status(500).json({ error: "DB error finding user" }); }

          const insertPhoto = (p_id) => {
               const query = `
                 INSERT INTO bird_photos
                   (image_filename, date_taken, location, latitude, longitude, approved, photographer_id, species_suggestions)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
               `;
               const params = [
                   image_url, date_taken || null, location || "Unknown", latitude || null, longitude || null, p_id, species_suggestions || null
               ];
               db.run(query, params, function (err) {
                   if (err) { /* handle error */ return res.status(500).json({ error: "Failed to add photo record" }); }
                   console.log(`✅ Photo record added. ID: ${this.lastID}, Suggestion: ${species_suggestions}`);
                   res.status(201).json({ photo_id: this.lastID, /* include other fields if needed */ });
               });
          };

          if (user) {
               insertPhoto(user.id);
          } else if (photographerName !== "Unknown") {
               db.run(insertUserQuery, [photographerName], function(insertErr) {
                   if (insertErr) { /* handle error */ return res.status(500).json({ error: "Failed to add photographer" }); }
                   insertPhoto(this.lastID);
               });
          } else {
               insertPhoto(null); // Insert null for photographer_id if name is "Unknown"
          }
     });
});

// Text-based Species Suggestions (Public)
app.get('/api/species-suggestions', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) {
        return res.json([]);
    }
    const lowerQuery = query.toLowerCase();

    // Use the preloaded allSpecies list
    const speciesList = allSpecies
        .filter(name => name.toLowerCase().includes(lowerQuery))
        .sort((a, b) => {
            const aStartsWith = a.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            const bStartsWith = b.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
            return aStartsWith - bStartsWith || a.localeCompare(b);
        })
        .slice(0, 7);

    res.json(speciesList);
});


// Update species link (Login Required)
app.post('/api/update-species', requireLogin, async (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    try {
        // Step 1: Find or create species ID
        const findSpeciesQuery = `SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`;
        db.get(findSpeciesQuery, [common_name], async (err, species) => {
            if (err) { /* handle error */ return res.status(500).json({ error: "Failed to find species" }); }

            if (species) {
                 linkSpeciesToPhoto(photo_id, species.id, res, common_name);
            } else {
                 // Fetch from eBird and insert
                 let scientificName = null, family = null, orderName = null, status = "LC";
                 try {
                     const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`, { headers: { "User-Agent": "BirdPhotosApp/1.0" } }); // Add User-Agent
                     const speciesMatch = response.data.find(s => s.comName.toLowerCase() === common_name.toLowerCase());
                     if (speciesMatch) { /* assign details */ }
                     else { console.warn(`⚠️ No eBird match found for: ${common_name}`); }
                 } catch (apiError) { console.error("❌ Error fetching eBird data:", apiError.message); }

                 const insertSpeciesQuery = `
                    INSERT INTO bird_species (common_name, scientific_name, family, order_name, status)
                    VALUES (?, ?, ?, ?, ?)`; // Adjusted column name
                 db.run(insertSpeciesQuery, [common_name, scientificName, family, orderName, status], function (err) {
                    if (err) { /* handle error */ return res.status(500).json({ error: "Failed to insert species" }); }
                    linkSpeciesToPhoto(photo_id, this.lastID, res, common_name);
                 });
            }
        });
    } catch (error) {
        console.error("❌ Server error updating species:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Helper function to link species to photo (internal use, no res needed if called internally)
function linkSpeciesToPhoto(photo_id, species_id, res, common_name) {
    if (!db) { console.error("DB unavailable in linkSpeciesToPhoto"); return; }
    const checkExistingQuery = `SELECT 1 FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
    db.get(checkExistingQuery, [photo_id, species_id], (err, row) => {
        if (err) { console.error("❌ Error checking link:", err.message); if (res && !res.headersSent) res.status(500).json({ error: "DB error" }); return; }
        if (row) { console.log(`ℹ️ Link already exists: Photo ${photo_id}, Species ${species_id}`); if (res && !res.headersSent) res.json({ message: "Species already linked" }); return; }

        const insertRelationQuery = `INSERT INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)`;
        db.run(insertRelationQuery, [photo_id, species_id], function (err) {
            if (err) { console.error("❌ Error inserting link:", err.message); if (res && !res.headersSent) res.status(500).json({ error: "DB error" }); return; }
            console.log(`✅ Linked species ${species_id} (${common_name}) to photo ${photo_id}`);
            if (res && !res.headersSent) res.json({ message: "Species linked successfully" });
        });
    });
}


// Remove species link (Login Required)
app.post('/api/remove-species', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;
    if (!photo_id || !common_name) { return res.status(400).json({ error: "Missing photo_id or common_name" }); }

    db.get(`SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`, [common_name], (err, species) => {
        if (err) { /* handle error */ return res.status(500).json({ error: "DB error" }); }
        if (!species) { return res.status(404).json({ error: "Species not found" }); }

        const query = `DELETE FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
        db.run(query, [photo_id, species.id], function (err) {
            if (err) { /* handle error */ return res.status(500).json({ error: "DB error" }); }
            if (this.changes === 0) { return res.status(404).json({ message: "Species link not found for this photo" }); }
            console.log(`✅ Species removed from photo ${photo_id}: ${common_name}`);
            res.json({ message: "Species removed successfully" });
        });
    });
});


// Update Photo Details (Login Required) - Consolidated endpoint
app.post('/api/update-photo-details', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, date_taken, location, photographer } = req.body;

    if (!photo_id) {
        return res.status(400).json({ error: "Missing photo_id" });
    }

    // Prepare update fields dynamically
    let fieldsToUpdate = [];
    let params = [];
    let photographerIdToSet = undefined; // Use undefined to distinguish from null

    const updateDb = () => {
        if (photographerIdToSet !== undefined) {
             fieldsToUpdate.push("photographer_id = ?");
             params.push(photographerIdToSet); // Push null or the ID
        }
        if (date_taken !== undefined) {
            fieldsToUpdate.push("date_taken = ?");
            params.push(date_taken || null); // Use null if empty string sent
        }
        if (location !== undefined) {
            fieldsToUpdate.push("location = ?");
            params.push(location || 'Unknown');
        }

        if (fieldsToUpdate.length === 0) {
             console.warn(`⚠️ No fields provided to update for photo ${photo_id}.`);
             return res.status(400).json({ error: "No update fields provided" });
        }

        params.push(photo_id); // Add photo_id for WHERE clause
        const query = `UPDATE bird_photos SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;

        db.run(query, params, function(err) {
            if (err) {
                 console.error("❌ Error updating photo details:", err.message);
                 return res.status(500).json({ error: "Failed to update photo details" });
            }
            if (this.changes === 0) {
                 console.warn(`⚠️ Photo ${photo_id} not found for update.`);
                 return res.status(404).json({ error: "Photo not found" });
            }
            console.log(`✅ Photo ${photo_id} details updated successfully.`);
            res.json({ message: "Details updated successfully", photo_id });
        });
    };

    // Handle photographer ID lookup only if photographer name is provided
    if (photographer !== undefined) {
         const photographerName = photographer || 'Unknown';
         const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
         const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;

         db.get(findUserQuery, [photographerName], (err, user) => {
              if (err) { /* handle error */ return res.status(500).json({ error: "DB error finding user" }); }
              if (user) {
                   photographerIdToSet = user.id;
                   updateDb(); // Update DB with existing user ID
              } else if (photographerName !== 'Unknown') {
                   db.run(insertUserQuery, [photographerName], function(insertErr) {
                        if (insertErr) { /* handle error */ return res.status(500).json({ error: "DB error adding user" }); }
                        photographerIdToSet = this.lastID;
                        updateDb(); // Update DB with new user ID
                   });
              } else {
                   photographerIdToSet = null; // Set photographer_id to NULL for 'Unknown'
                   updateDb(); // Update DB with null user ID
              }
         });
    } else {
         // If photographer name wasn't sent, proceed without updating it
         updateDb();
    }
});

// Remove older /api/update-photographer and /api/update-location routes as they are now handled by /api/update-photo-details


// Approve Photo (Login Required)
app.post('/api/approve-photo', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id } = req.body;
    if (!photo_id) { return res.status(400).json({ error: "Missing photo_id" }); }

    const query = `UPDATE bird_photos SET approved = 1 WHERE id = ? AND (approved != 1 OR approved IS NULL)`;
    db.run(query, [photo_id], function (err) {
        if (err) { /* handle error */ return res.status(500).json({ error: "Error approving photo" }); }
        if (this.changes === 0) { return res.status(200).json({ message: "Photo already approved or not found" }); }
        console.log(`✅ Photo ${photo_id} approved.`);
        res.json({ message: "Photo approved successfully" });
    });
});

// Delete Photo (Login Required)
app.post('/api/delete-photo', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id } = req.body;
    if (!photo_id) { return res.status(400).json({ error: "Missing photo_id" }); }

    const selectQuery = `SELECT image_filename FROM bird_photos WHERE id = ?`;
    db.get(selectQuery, [photo_id], (err, row) => {
        if (err) { /* handle error */ return res.status(500).json({ error: "DB error finding photo" }); }
        if (!row) { return res.status(404).json({ error: "Photo record not found" }); }
        const fileUrl = row.image_filename;

        db.serialize(() => { // Use serialize for ordered execution within transaction
            db.run("BEGIN TRANSACTION;");
            let success = true;

            // Delete species links
            db.run(`DELETE FROM bird_photo_species WHERE photo_id = ?`, [photo_id], function(linkErr) {
                if (linkErr) { success = false; console.error("❌ Error deleting species links:", linkErr.message); }
                else { console.log(`✅ Deleted ${this.changes} species links for photo ${photo_id}.`); }
            });

            // Delete photo record
            db.run(`DELETE FROM bird_photos WHERE id = ?`, [photo_id], function (photoErr) {
                 if (photoErr) { success = false; console.error("❌ Error deleting photo record:", photoErr.message); }
                 else if (this.changes === 0) { success = false; console.warn(`⚠️ Photo record ${photo_id} not found during delete attempt.`); }
                 else { console.log(`✅ Photo record ${photo_id} deleted from database.`); }
            });

            // Commit or Rollback Transaction
            db.run(success ? "COMMIT;" : "ROLLBACK;", async (commitErr) => {
                 if (commitErr || !success) {
                      console.error(commitErr ? `❌ Error committing/rolling back transaction: ${commitErr.message}`: `❌ Transaction rolled back due to previous errors.`);
                      // Only send error response if not already sent
                       if (!res.headersSent) res.status(500).json({ error: "Failed to complete photo deletion in database" });
                       return; // Stop here if DB operations failed
                 }

                 // --- If DB commit was successful, attempt File Deletion ---
                 console.log("✅ DB Deletion Transaction successful.");
                 let decodedPath = null;
                 if (fileUrl && fileUrl.includes('/o/')) { /* ... extract decodedPath ... */ }

                 if (decodedPath) {
                     try {
                          // TODO: Implement actual file deletion if Firebase Admin SDK is used here
                          console.warn(`⚠️ Firebase file deletion skipped. File path: "${decodedPath}"`);
                     } catch (storageErr) {
                          console.error(`❌ Error deleting file "${decodedPath}" from Firebase:`, storageErr.message);
                     }
                 } else { /* Warn if path couldn't be determined */ }

                 if (!res.headersSent) res.json({ message: "Photo deleted successfully" });
            });
        });
    });
});

// Fallback route for non-API calls (serves index.html for frontend routing)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    } else {
        res.status(404).json({ error: "API endpoint not found" });
    }
});


// --- Server Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    if (db) {
        console.log(`🚀 Server running at http://localhost:${PORT} or https://birdpics.pics/`);
    } else {
        console.error("❌ Server starting but database connection FAILED.");
    }
});

// Optional: Graceful shutdown
process.on('SIGINT', () => {
    console.log("\n⏳ Shutting down server...");
    if (db) {
        db.close((err) => {
            if (err) { console.error("❌ Error closing database:", err.message); }
            else { console.log("✅ Database connection closed."); }
            process.exit(0);
        });
    } else { process.exit(0); }
});