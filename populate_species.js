const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Connect to DB
const db = new sqlite3.Database('/persistent/birds.db');

(async function run() {
  try {
    // 1) Get all species rows
    const speciesList = await getAllSpecies();
    console.log(`Found ${speciesList.length} species.`);

    // 2) For each species, if missing scientific_name or family, fetch from eBird
    const eBirdData = await fetchFullEBirdTaxonomy();
    for (const row of speciesList) {
      if (!row.scientific_name || !row.family) {
        const match = eBirdData.find(s => s.comName.toLowerCase() === row.common_name.toLowerCase());
        if (match) {
          console.log(`Updating ${row.common_name} with sciName=${match.sciName}, family=${match.familyComName}`);
          await updateSpeciesInDB(row.id, match.sciName, match.familyComName, match.order, match.extinct ? 'Extinct' : 'Not Extinct');
        }
      }
    }

    console.log('All done!');
  } catch (err) {
    console.error('Error in populate_species.js:', err);
  } finally {
    db.close();
  }
})();

// Helper to retrieve all species from local DB
function getAllSpecies() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM bird_species`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Helper to fetch entire eBird taxonomy
async function fetchFullEBirdTaxonomy() {
  const url = `https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json`;
  // Might need an API key or better approach for large fetch
  const { data } = await axios.get(url);
  return data;
}

// Helper to update local DB
function updateSpeciesInDB(id, sciName, family, orderName, status) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE bird_species 
      SET scientific_name = ?, family = ?, order_name = ?, status = ? 
      WHERE id = ?
    `;
    db.run(sql, [sciName, family, orderName, status, id], function(err) {
      if (err) return reject(err);
      resolve();
    });
  });
}
