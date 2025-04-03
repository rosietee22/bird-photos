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

    // Use a SQLite-friendly approach to produce "Species A, Species B" with spaces
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

// --- /api/pending-photos (Login Required) ---
app.get('/api/pending-photos', (req, res) => {
    console.log("🔍 Request for /api/pending-photos by logged-in user.");
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

// ... rest of your routes remain unchanged (add-photo, update-species, etc.) ...

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
