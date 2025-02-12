const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const db = new sqlite3.Database('./birds.db');

async function getBirdDetails(commonName) {
    try {
        const response = await axios.get('https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en');
        const speciesList = response.data;
        const bird = speciesList.find(species => species.comName.toLowerCase() === commonName.toLowerCase());

        return bird ? bird.sciName : null;
    } catch (error) {
        console.error("Error fetching bird details:", error);
        return null;
    }
}

async function updateScientificNames() {
    db.all("SELECT id, common_name FROM bird_species WHERE scientific_name IS NULL OR scientific_name = ''", async (err, rows) => {
        if (err) {
            console.error("Database Error:", err);
            return;
        }

        for (const row of rows) {
            const scientificName = await getBirdDetails(row.common_name);
            if (scientificName) {
                db.run("UPDATE bird_species SET scientific_name = ? WHERE id = ?", [scientificName, row.id], (err) => {
                    if (err) {
                        console.error(`Error updating ${row.common_name}:`, err);
                    } else {
                        console.log(`Updated ${row.common_name} → ${scientificName}`);
                    }
                });
            } else {
                console.log(`No match found for ${row.common_name}`);
            }
        }
    });
}

updateScientificNames();
