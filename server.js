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
// --- SESSION CONFIGURATION END ---

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
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) { // More robust check for Accept header
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


// --- API Routes ---

// Preload species (eBird cache)
const speciesCache = {}; // For text suggestions
let allSpecies = []; // Full list from cache file

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
            allSpecies = response.data.map(species => species.comName);
            fs.writeFileSync(cacheFile, JSON.stringify(allSpecies));
            console.log(`✅ Cached ${allSpecies.length} species.`);
        }
    } catch (error) {
        console.error("❌ Failed to load or fetch eBird species list:", error.message);
    }
}
preloadSpecies();


// Get Approved Photos (Public - No Login Required)
app.get('/api/photos', (req, res) => {
    console.log("🔍 Received request for /api/photos");
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    // --- MODIFIED GROUP_CONCAT SEPARATOR ---
    const query = `
        SELECT
            bp.id, bp.image_filename, bp.date_taken, bp.location,
            bp.latitude, bp.longitude, bp.species_suggestions,
            COALESCE(u.name, 'Unknown') AS photographer,
            COALESCE(GROUP_CONCAT(DISTINCT bs.common_name, ', '), 'Unknown') AS species_names
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
        if (err) { /* ... error handling ... */ return res.status(500).json({ error: "Error fetching photos" }); }
        rows.forEach(row => { /* ... date formatting ... */
             row.date_taken_formatted = "Unknown date"; if (row.date_taken) { try { const utcDate = new Date(row.date_taken); if (!isNaN(utcDate)) { row.date_taken_formatted = format(utcDate, "d MMMM yy"); } else { row.date_taken_formatted = "Invalid date"; } } catch (formatError) { console.warn(`⚠️ Invalid date format:`, formatError.message); } }
         });
        console.log(`✅ Fetched ${rows.length} approved photos.`);
        res.json(rows);
    });
});

// Get Pending Photos (Login Required)
app.get('/api/pending-photos', requireLogin, (req, res) => {
    // --- ADDED LOGGING ---
    console.log(`🔍 DEBUG: Request received for /api/pending-photos.`);
    console.log(`🔍 DEBUG: Session ID: ${req.sessionID}`);
    console.log(`🔍 DEBUG: Session exists: ${!!req.session}`);
    console.log(`🔍 DEBUG: Session loggedIn status: ${req.session ? req.session.loggedIn : 'N/A'}`);
    // --- END LOGGING ---

    console.log("🔍 Processing request for /api/pending-photos by logged-in user.");
     if (!db) return res.status(503).json({ error: "Database connection not ready" });

    // --- MODIFIED GROUP_CONCAT SEPARATOR ---
    const query = `
      SELECT
          bp.id, bp.image_filename, bp.date_taken, bp.location,
          bp.latitude, bp.longitude, bp.species_suggestions,
          COALESCE(u.name, 'Unknown') AS photographer,
          COALESCE(GROUP_CONCAT(DISTINCT bs.common_name, ', '), 'Unknown') AS species_names
      FROM bird_photos bp
      LEFT JOIN bird_photo_species bps ON bp.id = bps.photo_id
      LEFT JOIN bird_species bs ON bps.species_id = bs.id
      LEFT JOIN users u ON bp.photographer_id = u.id
      WHERE bp.approved != 1 OR bp.approved IS NULL
      GROUP BY bp.id
      ORDER BY bp.id DESC;
    `;
    db.all(query, [], (err, rows) => {
        if (err) { /* ... error handling ... */ return res.status(500).json({ error: "Error fetching pending photos" }); }
        rows.forEach(row => { /* ... date formatting ... */
             row.date_taken_formatted = "Unknown date"; if (row.date_taken) { try { const utcDate = new Date(row.date_taken); if (!isNaN(utcDate)) { row.date_taken_formatted = format(utcDate, "d MMMM yy"); } else { row.date_taken_formatted = "Invalid date"; } } catch (formatError) { console.warn(`⚠️ Invalid date format:`, formatError.message); } }
         });
        console.log(`✅ Fetched ${rows.length} pending photos.`);
        res.json(rows);
    });
});

// Add Photo (Called by Cloud Function - Needs some form of auth)
app.post('/api/add-photo', (req, res) => {
    const cloudFunctionSecret = req.headers['x-cloud-function-secret'];
     if (process.env.CLOUD_FUNCTION_SECRET && cloudFunctionSecret !== process.env.CLOUD_FUNCTION_SECRET) {
         console.warn("⚠️ Unauthorized attempt to call /api/add-photo (Secret Mismatch)");
         return res.status(403).json({ error: "Forbidden" });
     }
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { image_url, date_taken, location, latitude, longitude, photographer, species_suggestions } = req.body;
    if (!image_url) { return res.status(400).json({ error: "Missing image_url" }); }

     const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
     const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
     const photographerName = photographer || "Unknown";
     db.get(findUserQuery, [photographerName], (err, user) => {
          if (err) { /* handle error */ return res.status(500).json({ error: "DB error finding user" }); }
          const insertPhoto = (p_id) => {
               const query = `
                 INSERT INTO bird_photos
                   (image_filename, date_taken, location, latitude, longitude, approved, photographer_id, species_suggestions)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
               `;
               const params = [ image_url, date_taken || null, location || "Unknown", latitude || null, longitude || null, p_id, species_suggestions || null ];
               db.run(query, params, function (err) {
                   if (err) { /* handle error */ return res.status(500).json({ error: "Failed to add photo record" }); }
                   console.log(`✅ Photo record added. ID: ${this.lastID}, Suggestion: ${species_suggestions}`);
                   res.status(201).json({ photo_id: this.lastID });
               });
          };
          if (user) { insertPhoto(user.id); }
          else if (photographerName !== "Unknown") {
               db.run(insertUserQuery, [photographerName], function(insertErr) {
                   if (insertErr) { /* handle error */ return res.status(500).json({ error: "Failed to add photographer" }); }
                   insertPhoto(this.lastID);
               });
          } else { insertPhoto(null); }
     });
});

// Text-based Species Suggestions (Public)
app.get('/api/species-suggestions', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) { return res.json([]); }
    const lowerQuery = query.toLowerCase();
    const speciesList = allSpecies
        .filter(name => name.toLowerCase().includes(lowerQuery))
        .sort((a, b) => { /* ... sorting logic ... */
             const aStartsWith = a.toLowerCase().startsWith(lowerQuery) ? 0 : 1; const bStartsWith = b.toLowerCase().startsWith(lowerQuery) ? 0 : 1; return aStartsWith - bStartsWith || a.localeCompare(b);
        })
        .slice(0, 7);
    res.json(speciesList);
});


// Update species link (Login Required)
app.post('/api/update-species', requireLogin, async (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;
    if (!photo_id || !common_name) { return res.status(400).json({ error: "Missing photo_id or common_name" }); }
    try {
        const findSpeciesQuery = `SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`;
        db.get(findSpeciesQuery, [common_name], async (err, species) => {
            if (err) { /* handle error */ return res.status(500).json({ error: "Failed to find species" }); }
            if (species) { linkSpeciesToPhoto(photo_id, species.id, res, common_name); }
            else { /* ... fetch/insert logic ... */
                let scientificName = null, family = null, orderName = null, status = "LC"; try { const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`, { headers: { "User-Agent": "BirdPhotosApp/1.0" } }); const speciesMatch = response.data.find(s => s.comName.toLowerCase() === common_name.toLowerCase()); if (speciesMatch) { scientificName = speciesMatch.sciName; family = speciesMatch.familyComName; orderName = speciesMatch.order; status = speciesMatch.reportAs || 'LC'; } else { console.warn(`⚠️ No eBird match for: ${common_name}`); } } catch (apiError) { console.error("❌ Error eBird:", apiError.message); } const insertSpeciesQuery = ` INSERT INTO bird_species (common_name, scientific_name, family, order_name, status) VALUES (?, ?, ?, ?, ?)`; db.run(insertSpeciesQuery, [common_name, scientificName, family, orderName, status], function (err) { if (err) { /* handle error */ return res.status(500).json({ error: "Failed insert species" }); } linkSpeciesToPhoto(photo_id, this.lastID, res, common_name); });
             }
        });
    } catch (error) { /* handle error */ res.status(500).json({ error: "Internal server error" }); }
});

// Helper function to link species to photo
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
    if (!photo_id) { return res.status(400).json({ error: "Missing photo_id" }); }
    let fieldsToUpdate = []; let params = []; let photographerIdToSet = undefined;
    const updateDb = () => { /* ... update logic ... */
        if (photographerIdToSet !== undefined) { fieldsToUpdate.push("photographer_id = ?"); params.push(photographerIdToSet); } if (date_taken !== undefined) { fieldsToUpdate.push("date_taken = ?"); params.push(date_taken || null); } if (location !== undefined) { fieldsToUpdate.push("location = ?"); params.push(location || 'Unknown'); } if (fieldsToUpdate.length === 0) { return res.status(400).json({ error: "No update fields provided" }); } params.push(photo_id); const query = `UPDATE bird_photos SET ${fieldsToUpdate.join(', ')} WHERE id = ?`; db.run(query, params, function(err) { if (err) { return res.status(500).json({ error: "Failed update photo details" }); } if (this.changes === 0) { return res.status(404).json({ error: "Photo not found" }); } console.log(`✅ Photo ${photo_id} details updated.`); res.json({ message: "Details updated successfully" }); });
     };
    if (photographer !== undefined) { /* ... photographer lookup/insert ... */
         const photographerName = photographer || 'Unknown'; const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`; const insertUserQuery = `INSERT INTO users (name) VALUES (?)`; db.get(findUserQuery, [photographerName], (err, user) => { if (err) { /* handle error */ return res.status(500).json({ error: "DB error finding user" }); } if (user) { photographerIdToSet = user.id; updateDb(); } else if (photographerName !== 'Unknown') { db.run(insertUserQuery, [photographerName], function(insertErr) { if (insertErr) { /* handle error */ return res.status(500).json({ error: "DB error adding user" }); } photographerIdToSet = this.lastID; updateDb(); }); } else { photographerIdToSet = null; updateDb(); } });
     } else { updateDb(); }
});

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
        db.serialize(() => { db.run("BEGIN TRANSACTION;"); let success = true;
            db.run(`DELETE FROM bird_photo_species WHERE photo_id = ?`, [photo_id], function(linkErr) { if (linkErr) { success = false; console.error("❌ Error deleting links:", linkErr.message); } else { console.log(`✅ Deleted ${this.changes} links for photo ${photo_id}.`); } });
            db.run(`DELETE FROM bird_photos WHERE id = ?`, [photo_id], function (photoErr) { if (photoErr) { success = false; console.error("❌ Error deleting photo:", photoErr.message); } else if (this.changes === 0) { success = false; console.warn(`⚠️ Photo ${photo_id} not found during delete.`); } else { console.log(`✅ Photo ${photo_id} deleted from DB.`); } });
            db.run(success ? "COMMIT;" : "ROLLBACK;", async (commitErr) => { if (commitErr || !success) { console.error(commitErr ? `❌ Txn Error: ${commitErr.message}`: `❌ Txn rolled back.`); if (!res.headersSent) res.status(500).json({ error: "DB delete failed" }); return; } console.log("✅ DB Deletion Txn successful."); let decodedPath = null; if (fileUrl && fileUrl.includes('/o/')) { try { const urlParts = new URL(fileUrl); const objPath = urlParts.pathname.split('/o/')[1]; if (objPath) { decodedPath = decodeURIComponent(objPath); } } catch(urlParseError) { console.warn("⚠️ URL parse error:", urlParseError.message); } } if (decodedPath) { try { console.warn(`⚠️ Firebase file deletion skipped. Path: "${decodedPath}"`); } catch (storageErr) { console.error(`❌ File delete error:`, storageErr.message); } } else { console.warn(`⚠️ No file path for deletion:`, fileUrl); } if (!res.headersSent) res.json({ message: "Photo deleted successfully" }); }); }); }); });

// Fallback route
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
process.on('SIGINT', () => { /* ... shutdown logic ... */
     console.log("\n⏳ Shutting down server..."); if (db) { db.close((err) => { if (err) { console.error("❌ Error closing database:", err.message); } else { console.log("✅ Database connection closed."); } process.exit(0); }); } else { process.exit(0); }
});