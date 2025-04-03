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
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'SUPER_SECRET_KEY',
        resave: false,
        saveUninitialized: true,
        cookie: {
            maxAge: 1000 * 60 * 60 // 1 hour session
        }
    })
);

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


// Firebase Admin SDK (Ensure initialized properly if needed server-side, otherwise remove)
// Note: It seems storage interaction is primarily in Cloud Function and frontend.
// Consider if admin SDK is truly needed in this Express server.
// If not, remove this initialization.
/*
const admin = require('firebase-admin');
try {
    // Make sure you have GOOGLE_APPLICATION_CREDENTIALS set in your Render environment
    admin.initializeApp({
        // If using credentials file: credential: admin.credential.applicationDefault(),
        storageBucket: 'bird-pictures-953b0.appspot.com' // Bucket name needed for storage actions
    });
    console.log("✅ Firebase Admin SDK initialized.");
} catch(e) {
    console.error("❌ Firebase Admin SDK initialization failed:", e.message);
    // Decide if this is critical. Maybe just log the error.
    // process.exit(1);
}
// const storage = admin.storage().bucket(); // Only if using storage here
*/


// Middleware
app.use(cors()); // Enable CORS
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies


// Serve static files
app.use(express.static(FRONTEND_DIR));


// Authentication Middleware
function requireLogin(req, res, next) {
    if (req.session && req.session.loggedIn) {
        return next();
    }
    return res.redirect('/login');
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
        return res.redirect('/upload'); // Redirect if already logged in
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
        res.redirect('/approval'); // Redirect to approval page after login
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
        // Consider fallback or just logging the error
    }
}
preloadSpecies(); // Load species on server start


// Get Approved Photos
app.get('/api/photos', (req, res) => {
    console.log("🔍 Received request for /api/photos");
    if (!db) return res.status(503).json({ error: "Database connection not ready" });

    // Updated query to include species_suggestions
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
            if (row.date_taken) {
                 try {
                      // Ensure it's treated as UTC before formatting
                      const utcDate = new Date(row.date_taken);
                      if (!isNaN(utcDate)) {
                           row.date_taken_formatted = format(utcDate, "d MMMM yyyy"); // Keep original for potential JS use
                      } else {
                           row.date_taken_formatted = "Invalid date";
                      }
                 } catch (formatError) {
                      console.warn(`⚠️ Invalid date format for photo ${row.id}:`, row.date_taken, formatError.message);
                      row.date_taken_formatted = "Unknown date";
                 }
            } else {
                 row.date_taken_formatted = "Unknown date";
            }
            // Keep original date_taken as well if needed
        });
        console.log(`✅ Fetched ${rows.length} approved photos.`);
        res.json(rows);
    });
});

// Get Pending Photos
app.get('/api/pending-photos', requireLogin, (req, res) => { // Added requireLogin
    console.log("🔍 Received request for /api/pending-photos");
     if (!db) return res.status(503).json({ error: "Database connection not ready" });

    // Updated query to include species_suggestions
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
      WHERE bp.approved != 1 OR bp.approved IS NULL -- Include null approval status
      GROUP BY bp.id
      ORDER BY bp.id DESC; -- Order by ID or date added perhaps
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching pending photos:", err.message);
            return res.status(500).json({ error: "Error fetching pending photos" });
        }
         // Format dates before sending
         rows.forEach(row => {
            if (row.date_taken) {
                 try {
                      const utcDate = new Date(row.date_taken);
                      if (!isNaN(utcDate)) {
                            row.date_taken_formatted = format(utcDate, "d MMMM yyyy");
                      } else {
                           row.date_taken_formatted = "Invalid date";
                      }
                 } catch (formatError) {
                      console.warn(`⚠️ Invalid date format for photo ${row.id}:`, row.date_taken, formatError.message);
                      row.date_taken_formatted = "Unknown date";
                 }
            } else {
                 row.date_taken_formatted = "Unknown date";
            }
        });
        console.log(`✅ Fetched ${rows.length} pending photos.`);
        res.json(rows);
    });
});

// Add Photo (called by Cloud Function)
app.post('/api/add-photo', (req, res) => {
    // Basic security: Consider adding a secret header check if needed
    // const secret = req.headers['x-cloud-function-secret'];
    // if (secret !== process.env.CLOUD_FUNCTION_SECRET) {
    //     console.warn("⚠️ Unauthorized attempt to call /api/add-photo");
    //     return res.status(403).json({ error: "Forbidden" });
    // }

     if (!db) return res.status(503).json({ error: "Database connection not ready" });

    // Destructure expected fields, including the new species_suggestions
    const { image_url, date_taken, location, latitude, longitude, photographer, species_suggestions } = req.body;

    if (!image_url) {
        return res.status(400).json({ error: "Missing image_url" });
    }

    // Updated query to include species_suggestions
    const query = `
      INSERT INTO bird_photos
        (image_filename, date_taken, location, latitude, longitude, approved, photographer_name, species_suggestions)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `; // Using photographer_name assuming you might add that column or adjust

    // Parameters including species_suggestions (use null if undefined)
    const params = [
        image_url,
        date_taken || null,
        location || "Unknown",
        latitude || null,
        longitude || null,
        photographer || "Unknown", // Save photographer name directly for now
        species_suggestions || null // Add species_suggestions here
    ];

    db.run(query, params, function (err) {
        if (err) {
            console.error("❌ Error adding photo to DB:", err.message);
            return res.status(500).json({ error: "Failed to add photo record" });
        }
        console.log(`✅ Photo record added successfully. ID: ${this.lastID}, AI Suggestion: ${species_suggestions}`);
        // Return details including the new ID
        res.status(201).json({ // Use 201 Created status
            photo_id: this.lastID,
            image_url,
            date_taken,
            location,
            latitude,
            longitude,
            photographer,
            species_suggestions
        });
    });
});

// Text-based Species Suggestions (uses cached eBird list)
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
            return aStartsWith - bStartsWith || a.localeCompare(b); // Secondary sort alphabetically
        })
        .slice(0, 7); // Show slightly more suggestions

    res.json(speciesList);
});


// Update species link (manual add)
app.post('/api/update-species', requireLogin, async (req, res) => { // Added requireLogin
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    try {
        // Step 1: Find or create species ID
        let speciesId = null;
        const findSpeciesQuery = `SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`; // Case-insensitive search
        db.get(findSpeciesQuery, [common_name], async (err, species) => {
            if (err) {
                console.error("❌ Error finding species:", err.message);
                return res.status(500).json({ error: "Failed to find species" });
            }

            if (species) {
                speciesId = species.id;
                 // Species exists, link it directly
                linkSpeciesToPhoto(photo_id, speciesId, res, common_name);
            } else {
                // Step 2: Species doesn't exist, fetch details from eBird and insert
                console.log(`ℹ️ Species "${common_name}" not found locally, fetching from eBird...`);
                let scientificName = null, family = null, orderName = null, status = "LC"; // Default status code

                try {
                    // Consider adding a User-Agent header to eBird requests
                    const response = await axios.get(`https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`);
                    const speciesData = response.data; // Assuming response.data is the array
                    const speciesMatch = speciesData.find(s => s.comName.toLowerCase() === common_name.toLowerCase());

                    if (speciesMatch) {
                        scientificName = speciesMatch.sciName;
                        family = speciesMatch.familyComName;
                        orderName = speciesMatch.order;
                        status = speciesMatch.taxonOrder; // Example: use taxonOrder or another field if needed
                        console.log(`✅ Found eBird details for "${common_name}".`);
                    } else {
                        console.warn(`⚠️ No eBird match found for: ${common_name}`);
                    }
                } catch (apiError) {
                    console.error("❌ Error fetching eBird data:", apiError.message);
                     // Continue without eBird data, or return error? Let's continue.
                }

                // Step 3: Insert new species
                const insertSpeciesQuery = `
                    INSERT INTO bird_species (common_name, scientific_name, family, order_name, conservation_status)
                    VALUES (?, ?, ?, ?, ?)
                `; // Assuming conservation_status column exists
                db.run(insertSpeciesQuery, [common_name, scientificName, family, orderName, status], function (err) {
                    if (err) {
                        console.error("❌ Error inserting species:", err.message);
                        return res.status(500).json({ error: "Failed to insert species" });
                    }
                    speciesId = this.lastID;
                    console.log(`✅ Inserted new species: ${common_name} (ID: ${speciesId})`);
                    // Species inserted, now link it
                    linkSpeciesToPhoto(photo_id, speciesId, res, common_name);
                });
            }
        });
    } catch (error) {
        console.error("❌ Server error updating species:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Helper function to link species to photo
function linkSpeciesToPhoto(photo_id, species_id, res, common_name) {
     if (!db) {
         console.error("❌ Database not ready in linkSpeciesToPhoto");
         // Avoid sending response if already sent, check if res is writable
         if (res && !res.headersSent) {
              return res.status(503).json({ error: "Database connection not ready" });
         }
         return;
     }
    const checkExistingQuery = `SELECT 1 FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
    db.get(checkExistingQuery, [photo_id, species_id], (err, row) => {
        if (err) {
            console.error("❌ Error checking existing species link:", err.message);
             if (res && !res.headersSent) return res.status(500).json({ error: "Failed to check existing species link" });
             return;
        }
        if (row) {
            console.log(`ℹ️ Species ${species_id} (${common_name}) already linked to photo ${photo_id}.`);
             if (res && !res.headersSent) return res.json({ message: "Species already linked", photo_id, species_id });
             return;
        }
        // Link doesn't exist, insert it
        const insertRelationQuery = `INSERT INTO bird_photo_species (photo_id, species_id) VALUES (?, ?)`;
        db.run(insertRelationQuery, [photo_id, species_id], function (err) {
            if (err) {
                console.error("❌ Error linking species to photo:", err.message);
                 if (res && !res.headersSent) return res.status(500).json({ error: "Failed to link species to photo" });
                 return;
            }
            console.log(`✅ Linked species ${species_id} (${common_name}) to photo ${photo_id}`);
             if (res && !res.headersSent) return res.json({ message: "Species linked successfully", photo_id, species_id });
        });
    });
}


// Remove species link
app.post('/api/remove-species', requireLogin, (req, res) => { // Added requireLogin
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    // Find species_id first
    db.get(`SELECT id FROM bird_species WHERE common_name = ? COLLATE NOCASE`, [common_name], (err, species) => {
        if (err) {
            console.error("❌ Error finding species ID for removal:", err.message);
            return res.status(500).json({ error: "Database error finding species" });
        }
        if (!species) {
            return res.status(404).json({ error: "Species not found" });
        }

        // Now delete the link using IDs
        const query = `DELETE FROM bird_photo_species WHERE photo_id = ? AND species_id = ?`;
        db.run(query, [photo_id, species.id], function (err) {
            if (err) {
                console.error("❌ Error removing species link:", err.message);
                return res.status(500).json({ error: "Failed to remove species link" });
            }
            if (this.changes === 0) {
                 console.warn(`⚠️ No species link found to remove for photo ${photo_id}, species ${common_name}`);
                 return res.status(404).json({ message: "Species link not found for this photo" });
            }
            console.log(`✅ Species removed from photo ${photo_id}: ${common_name}`);
            res.json({ message: "Species removed successfully", photo_id, common_name });
        });
    });
});


// Update Photo Details (manual edit)
app.post('/api/update-photo-details', requireLogin, (req, res) => { // Added requireLogin
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, date_taken, location, photographer } = req.body; // Expecting photographer name

    if (!photo_id) {
        return res.status(400).json({ error: "Missing photo_id" });
    }

    // First, find or create the user ID for the photographer
    let photographerId = null;
    const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
    const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
    const updatePhotoQuery = `
        UPDATE bird_photos SET
            date_taken = ?,
            location = ?,
            photographer_id = ?
        WHERE id = ?
    `;

    // Handle photographer lookup/insert
    const photographerName = photographer || 'Unknown'; // Default if empty
    db.get(findUserQuery, [photographerName], (err, user) => {
         if (err) {
              console.error("❌ Error finding photographer:", err.message);
              return res.status(500).json({ error: "Database error finding photographer" });
         }

         if (user) { // User exists
              photographerId = user.id;
              // Update photo details with existing user ID
              db.run(updatePhotoQuery, [date_taken || null, location || 'Unknown', photographerId, photo_id], function (err) {
                   if (err) {
                        console.error("❌ Error updating photo details (existing user):", err.message);
                        return res.status(500).json({ error: "Failed to update photo details" });
                   }
                   console.log(`✅ Photo ${photo_id} details updated (Existing User ID: ${photographerId}).`);
                   res.json({ message: "Details updated successfully", photo_id });
              });
         } else if (photographerName !== 'Unknown') { // User doesn't exist, insert them (unless name is 'Unknown')
              db.run(insertUserQuery, [photographerName], function(insertErr) {
                   if (insertErr) {
                        console.error("❌ Error inserting new photographer:", insertErr.message);
                        return res.status(500).json({ error: "Failed to add photographer" });
                   }
                   photographerId = this.lastID;
                   console.log(`✅ Inserted new photographer: ${photographerName} (ID: ${photographerId})`);
                   // Update photo details with new user ID
                   db.run(updatePhotoQuery, [date_taken || null, location || 'Unknown', photographerId, photo_id], function (err) {
                        if (err) {
                             console.error("❌ Error updating photo details (new user):", err.message);
                             return res.status(500).json({ error: "Failed to update photo details" });
                        }
                        console.log(`✅ Photo ${photo_id} details updated (New User ID: ${photographerId}).`);
                        res.json({ message: "Details updated successfully", photo_id });
                   });
              });
         } else { // Photographer is 'Unknown', update photo with null photographer_id
              db.run(updatePhotoQuery, [date_taken || null, location || 'Unknown', null, photo_id], function (err) {
                   if (err) {
                        console.error("❌ Error updating photo details (unknown user):", err.message);
                        return res.status(500).json({ error: "Failed to update photo details" });
                   }
                   console.log(`✅ Photo ${photo_id} details updated (User: Unknown).`);
                   res.json({ message: "Details updated successfully", photo_id });
              });
         }
    });
});

// Update Photographer Only (Alternative) - Kept for reference, but update-photo-details handles it now
app.post('/api/update-photographer', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, photographer } = req.body;

    if (!photo_id || !photographer) {
        return res.status(400).json({ error: "Missing photo_id or photographer name" });
    }

     // Refactored logic similar to update-photo-details for finding/inserting user
     const findUserQuery = `SELECT id FROM users WHERE name = ? COLLATE NOCASE`;
     const insertUserQuery = `INSERT INTO users (name) VALUES (?)`;
     const updatePhotoPhotographerQuery = `UPDATE bird_photos SET photographer_id = ? WHERE id = ?`;

     db.get(findUserQuery, [photographer], (err, user) => {
          if (err) { /* ... error handling ... */ return res.status(500).json({ error: "DB error finding user" }); }

          if (user) { // User exists
               db.run(updatePhotoPhotographerQuery, [user.id, photo_id], function(err) {
                    if (err) { /* ... error handling ... */ return res.status(500).json({ error: "DB error updating photo" }); }
                    console.log(`✅ Photographer updated for photo ${photo_id}: ${photographer} (Existing User ID: ${user.id})`);
                    res.json({ message: "Photographer updated successfully", photo_id, photographer });
               });
          } else { // User doesn't exist, insert
               db.run(insertUserQuery, [photographer], function(insertErr) {
                    if (insertErr) { /* ... error handling ... */ return res.status(500).json({ error: "DB error inserting user" }); }
                    const newUserId = this.lastID;
                    db.run(updatePhotoPhotographerQuery, [newUserId, photo_id], function(err) {
                         if (err) { /* ... error handling ... */ return res.status(500).json({ error: "DB error updating photo" }); }
                         console.log(`✅ Photographer updated for photo ${photo_id}: ${photographer} (New User ID: ${newUserId})`);
                         res.json({ message: "Photographer updated successfully", photo_id, photographer });
                    });
               });
          }
     });
});


// Update Location Only (Alternative) - Kept for reference, but update-photo-details handles it now
app.post('/api/update-location', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id, location } = req.body;

    if (!photo_id || location === undefined) { // Check if location is present, even if empty string
        return res.status(400).json({ error: "Missing photo_id or location" });
    }

    const query = `UPDATE bird_photos SET location = ? WHERE id = ?`;
    db.run(query, [location || 'Unknown', photo_id], function (err) { // Default to 'Unknown' if empty
        if (err) {
            console.error("❌ Error updating location:", err.message);
            return res.status(500).json({ error: "Failed to update location" });
        }
        console.log(`✅ Location updated for photo ${photo_id}: ${location || 'Unknown'}`);
        res.json({ message: "Location updated successfully", photo_id, location: location || 'Unknown' });
    });
});


// Approve Photo
app.post('/api/approve-photo', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id } = req.body;
    if (!photo_id) {
        return res.status(400).json({ error: "Missing photo_id" });
    }
    const query = `UPDATE bird_photos SET approved = 1 WHERE id = ? AND (approved != 1 OR approved IS NULL)`; // Only update if not already approved
    db.run(query, [photo_id], function (err) {
        if (err) {
            console.error("❌ Error approving photo:", err.message);
            return res.status(500).json({ error: "Error approving photo" });
        }
        if (this.changes === 0) {
            console.warn(`⚠️ Photo ${photo_id} already approved or not found.`);
            // Decide on response: maybe 200 OK but indicate no change? Or 404?
             return res.status(200).json({ message: "Photo already approved or not found", photo_id });
        }
        console.log(`✅ Photo ${photo_id} approved.`);
        res.json({ message: "Photo approved successfully", photo_id });
    });
});

// Delete Photo
app.post('/api/delete-photo', requireLogin, (req, res) => {
     if (!db) return res.status(503).json({ error: "Database connection not ready" });
    const { photo_id } = req.body;
    if (!photo_id) {
        return res.status(400).json({ error: "Missing photo_id" });
    }

    // Get filename BEFORE deleting DB record
    const selectQuery = `SELECT image_filename FROM bird_photos WHERE id = ?`;
    db.get(selectQuery, [photo_id], (err, row) => {
        if (err) {
            console.error("❌ Error fetching photo record for deletion:", err.message);
            return res.status(500).json({ error: "Database error fetching photo record" });
        }
        if (!row) {
            // Photo not found in DB, maybe already deleted?
            console.warn(`⚠️ Photo record ${photo_id} not found for deletion.`);
            return res.status(404).json({ error: "Photo record not found" });
        }

        const fileUrl = row.image_filename;

        // Begin transaction
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");

            // Delete related species links first
            const deleteLinksQuery = `DELETE FROM bird_photo_species WHERE photo_id = ?`;
            db.run(deleteLinksQuery, [photo_id], function(linkErr) {
                if (linkErr) {
                     console.error("❌ Error deleting species links for photo:", linkErr.message);
                     db.run("ROLLBACK;");
                     return res.status(500).json({ error: "Failed to delete associated species" });
                }
                console.log(`✅ Deleted ${this.changes} species links for photo ${photo_id}.`);

                // Now delete the photo record
                const deletePhotoQuery = `DELETE FROM bird_photos WHERE id = ?`;
                db.run(deletePhotoQuery, [photo_id], async function (photoErr) {
                    if (photoErr) {
                         console.error("❌ Error deleting photo record from DB:", photoErr.message);
                         db.run("ROLLBACK;");
                         return res.status(500).json({ error: "Failed to delete photo record" });
                    }
                    if (this.changes === 0) {
                         // Should not happen if we found the record earlier, but handle anyway
                         console.warn(`⚠️ Photo record ${photo_id} disappeared before deletion?`);
                         db.run("ROLLBACK;");
                         return res.status(404).json({ error: "Photo record not found during delete" });
                    }

                    console.log(`✅ Photo record ${photo_id} deleted from database.`);

                     // Commit DB changes BEFORE attempting file deletion
                     db.run("COMMIT;", async (commitErr) => {
                          if (commitErr) {
                               console.error("❌ Error committing transaction:", commitErr.message);
                               // DB changes might be rolled back automatically depending on error
                               return res.status(500).json({ error: "Failed to commit photo deletion" });
                          }

                          // DB changes successful, now try deleting file from Firebase
                          let decodedPath = null;
                          if (fileUrl && fileUrl.includes('/o/')) {
                               try {
                                    // Extract path more robustly
                                    const urlParts = new URL(fileUrl);
                                    // Pathname is like /v0/b/bucket-name/o/folder%2Ffile.jpg
                                    const objPath = urlParts.pathname.split('/o/')[1];
                                    if (objPath) {
                                         decodedPath = decodeURIComponent(objPath);
                                    }
                               } catch(urlParseError) {
                                   console.warn("⚠️ Could not parse file URL for deletion:", fileUrl, urlParseError.message);
                               }
                          }

                          if (decodedPath) {
                               try {
                                    // Ensure Firebase Admin SDK was initialized if using it here
                                    // await storage.file(decodedPath).delete();
                                    console.warn(`⚠️ Firebase file deletion skipped (Admin SDK likely not needed/initialized here). File path: "${decodedPath}"`);
                                    // Assuming deletion handled elsewhere or not required from server
                               } catch (storageErr) {
                                    // Log error but don't fail the request, DB entry is gone.
                                    console.error(`❌ Error deleting file "${decodedPath}" from Firebase:`, storageErr.message);
                               }
                          } else {
                               console.warn(`⚠️ Could not determine file path from URL for deletion:`, fileUrl);
                          }

                          // Respond success after DB commit and file deletion attempt
                          res.json({ message: "Photo deleted successfully", photo_id });
                     }); // End commit
                }); // End delete photo record
            }); // End delete links
        }); // End serialize (transaction)
    }); // End get filename
});

// Fallback route for non-API calls (serves index.html for frontend routing)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) { // Ensure API routes are not caught
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    } else {
        // Handle non-existent API routes
        res.status(404).json({ error: "API endpoint not found" });
    }
});


// --- Server Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    // Ensure DB connection is established before logging server start
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
            if (err) {
                console.error("❌ Error closing database:", err.message);
            } else {
                console.log("✅ Database connection closed.");
            }
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

// Removed misplaced client-side function: filterPhotos()