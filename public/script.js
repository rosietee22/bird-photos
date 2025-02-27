const API_BASE_URL = "https://birdpics.pics";

document.addEventListener("DOMContentLoaded", fetchPhotos);

function populateSpeciesFilter(photos) {
    const filterDropdown = document.getElementById("species-filter");
    filterDropdown.innerHTML = `<option value="all">All Species</option>`;

    const uniqueSpecies = new Set();
    photos.forEach(photo => {
        if (photo.species_names) {
            photo.species_names.split(", ").forEach(species => uniqueSpecies.add(species));
        }
    });

    // Convert Set to Array and sort alphabetically
    Array.from(uniqueSpecies).sort().forEach(species => {
        const option = document.createElement("option");
        option.value = species;
        option.textContent = species;
        filterDropdown.appendChild(option);
    });
}

function displayPhotos(photos) {
    const gallery = document.getElementById("photo-gallery");
    gallery.innerHTML = "";

    const isAdminPage = window.location.pathname.includes("admin"); // Detect if in admin mode

    photos.forEach(photo => {
        const photoCard = document.createElement("div");
        photoCard.className = "photo-card";
        photoCard.id = `bird-card-${photo.id}`;

        let formattedDate = "Unknown date";
        if (photo.date_taken) {
            const dateObj = new Date(photo.date_taken);
            formattedDate = dateObj.toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "long",
                year: "numeric",
            });
        }

        let formattedLocation = photo.location && photo.location.toLowerCase() !== "unknown" ? photo.location : "Unknown";
        const dateLocation = `${formattedDate}, ${formattedLocation}`;

        // Use species_names string and split it into an array of common names.
        let speciesArray = (photo.species_names && photo.species_names !== "Unknown")
            ? photo.species_names.split(", ")
            : ["Unknown"];

        // For admin pages, show remove buttons for each species.
        // For home pages, just display the species as paragraph text.
        let speciesText;
        if (isAdminPage) {
            speciesText = `<div id="species-container-${photo.id}"><strong>Species:</strong> ${
                speciesArray.map(species => `
                    <span class="species-tag">
                        ${species} 
                        ${species !== "Unknown" ? `<span class="remove-species" onclick="removeSpecies(${photo.id}, '${species}')">✖</span>` : ""}
                    </span>
                `).join(" ")
            }</div>`;
        } else {
            speciesText = `<p><strong>Species:</strong> ${speciesArray.join(", ")}</p>`;
        }

        let photographerName = photo.photographer && photo.photographer !== "Unknown" ? photo.photographer : "Unknown";

        // Default display content for all pages
        let cardContent = `
            <div class="photo-info">${dateLocation}</div>
            <img src="${photo.image_filename}" alt="Bird Photo" loading="lazy">
            ${speciesText}
        `;

        // If on admin page, append editing controls.
        if (isAdminPage) {
            cardContent += `
                <div class="species-edit">
                    <input type="text" id="species-${photo.id}" placeholder="Add Species" onkeyup="fetchSpeciesSuggestions(${photo.id})">
                    <div id="species-dropdown-${photo.id}" class="species-dropdown"></div>
                    <button onclick="updateSpecies(${photo.id})">Add Species</button>
                </div>

                <div id="location-container-${photo.id}">
                    <p id="location-text-${photo.id}" class="location-text">
                        <strong>Location:</strong> ${formattedLocation} 
                        <button onclick="editLocation(${photo.id})">Edit</button>
                    </p>
                    <input type="text" id="location-input-${photo.id}" placeholder="Edit Location" style="display:none;">
                    <button id="update-location-${photo.id}" onclick="updateLocation(${photo.id})" style="display:none;">Update Location</button>
                </div>

                <div id="photographer-container-${photo.id}">
                    <p id="photographer-text-${photo.id}" class="photographer-text">
                        <strong>Photographer:</strong> <span id="photographer-name-${photo.id}">${photographerName}</span>
                        <button onclick="editPhotographer(${photo.id})">Edit</button>
                    </p>
                    <input type="text" id="photographer-input-${photo.id}" placeholder="Enter Photographer" style="display:none;">
                    <button id="update-photographer-${photo.id}" onclick="updatePhotographer(${photo.id})" style="display:none;">Update Photographer</button>
                </div>
            `;
        }

        photoCard.innerHTML = cardContent;
        gallery.appendChild(photoCard);
    });
}



// 🔹 Function to Edit Photographer Name
function editPhotographer(photoId) {
    const photographerText = document.getElementById(`photographer-text-${photoId}`);
    const photographerInput = document.getElementById(`photographer-input-${photoId}`);
    const updateButton = document.getElementById(`update-photographer-${photoId}`);

    // Show input and update button, hide current photographer text
    photographerText.style.display = "none";
    photographerInput.style.display = "inline-block";
    updateButton.style.display = "inline-block";

    // Pre-fill input with existing photographer name
    photographerInput.value = photographerText.querySelector("span").textContent;
}

// 🔹 Function to Update Photographer in Database
function updatePhotographer(photoId) {
    const photographerInput = document.getElementById(`photographer-input-${photoId}`);
    const newPhotographer = photographerInput.value.trim();

    if (newPhotographer) {
        fetch(`${API_BASE_URL}/api/update-photographer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photo_id: photoId, photographer: newPhotographer })
        })
        .then(response => response.json())
        .then(() => {
            fetch(`${API_BASE_URL}/api/photos`)
                .then(response => response.json())
                .then(photos => {
                    const photo = photos.find(p => p.id === photoId);
                    if (!photo) return;

                    const photographerText = document.getElementById(`photographer-text-${photoId}`);
                    const photographerInput = document.getElementById(`photographer-input-${photoId}`);
                    const updateButton = document.getElementById(`update-photographer-${photoId}`);

                    // Update UI with new photographer name
                    document.getElementById(`photographer-name-${photoId}`).textContent = photo.photographer;

                    // Hide input and show text
                    photographerText.style.display = "inline";
                    photographerInput.style.display = "none";
                    updateButton.style.display = "none";
                });
        })
        .catch(error => console.error("❌ Error updating photographer:", error));
    }
}


function fetchPhotos() {
    fetch(`${API_BASE_URL}/api/photos`)
        .then(response => response.json())
        .then(photos => {
            allPhotos = photos;
            populateSpeciesFilter(photos);
            displayPhotos(photos);
        })
        .catch(error => console.error("❌ Error fetching photos:", error)); // Improved error message
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


function fetchSpeciesSuggestions(photoId) {
    const inputField = document.getElementById(`species-${photoId}`);
    const query = inputField.value.trim();

    if (query.length < 2) {
        document.getElementById(`species-dropdown-${photoId}`).innerHTML = "";
        return;
    }

    fetch(`${API_BASE_URL}/api/species-suggestions?query=${query}`)
        .then(response => response.json())
        .then(suggestions => {
            const dropdown = document.getElementById(`species-dropdown-${photoId}`);
            dropdown.innerHTML = "";

            suggestions.forEach(species => {
                const suggestionItem = document.createElement("div");
                suggestionItem.className = "suggestion-item";
                suggestionItem.textContent = species;
                suggestionItem.onclick = () => {
                    inputField.value = species;
                    dropdown.innerHTML = ""; // Clear dropdown after selection
                };
                dropdown.appendChild(suggestionItem);
            });
        })
        .catch(error => console.error("❌ Error fetching species suggestions:", error));
}

app.post('/api/update-species', async (req, res) => {
    const { photo_id, common_name } = req.body;

    if (!photo_id || !common_name) {
        return res.status(400).json({ error: "Missing photo_id or common_name" });
    }

    try {
        // Step 1: Check if species exists by common name only
        const findSpeciesQuery = `SELECT id FROM bird_species WHERE common_name = ?`;
        db.get(findSpeciesQuery, [common_name], async (err, species) => {
            if (err) {
                console.error("❌ Error finding species:", err.message);
                return res.status(500).json({ error: "Failed to find species" });
            }

            if (!species) {
                // Step 2: If species doesn't exist, insert new species with only common name.
                const insertSpeciesQuery = `
                    INSERT INTO bird_species (common_name, scientific_name, family, order_name, status) 
                    VALUES (?, '', '', '', '')
                `;
                db.run(insertSpeciesQuery, [common_name], function (err) {
                    if (err) {
                        console.error("❌ Error inserting species:", err.message);
                        return res.status(500).json({ error: "Failed to insert species" });
                    }
                    console.log(`✅ Inserted new species: ${common_name}`);
                    linkSpeciesToPhoto(photo_id, this.lastID, res);
                });
            } else {
                // Step 3: If species exists, update its extra information from eBird.
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
                            speciesMatch.sciName || '',
                            speciesMatch.familyComName || '',
                            speciesMatch.order || '',
                            speciesMatch.extinct ? "Extinct" : "Not Extinct",
                            species.id
                        ], (updateErr) => {
                            if (updateErr) {
                                console.error("❌ Error updating species info:", updateErr.message);
                            } else {
                                console.log(`✅ Updated species info for: ${common_name}`);
                            }
                        });
                    } else {
                        console.warn(`⚠️ No eBird data found for ${common_name}`);
                    }
                } catch (apiError) {
                    console.error("❌ Error fetching eBird data:", apiError);
                }
                // Finally, link the (updated) species to the photo.
                linkSpeciesToPhoto(photo_id, species.id, res);
            }
        });
    } catch (error) {
        console.error("❌ Server error updating species:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

function updateBirdCard(photoId) {
    fetch(`${API_BASE_URL}/api/photos`)
        .then(response => response.json())
        .then(photos => {
            const photo = photos.find(p => p.id === photoId);
            if (!photo) return;

            const card = document.getElementById(`bird-card-${photoId}`);
            if (card) {
                const speciesContainer = card.querySelector(`#species-container-${photoId}`);
                if (speciesContainer) {
                    speciesContainer.innerHTML = photo.species_names
                        .split(", ")
                        .map(species => `
                            <span class="species-tag">
                                ${species} <span class="remove-species" onclick="removeSpecies('${photo.id}', '${species}')">✖</span>
                            </span>
                        `).join(" ");
                }
            }
        })
        .catch(error => console.error("❌ Error updating bird card:", error));
}

function editLocation(photoId) {
    const currentLocation = document.getElementById(`location-text-${photoId}`);
    const inputField = document.getElementById(`location-input-${photoId}`);
    const updateButton = document.getElementById(`update-location-${photoId}`);

    // Show input and update button, hide current location text
    currentLocation.style.display = "none";
    inputField.style.display = "inline-block";
    updateButton.style.display = "inline-block";

    // Pre-fill input with existing location
    inputField.value = currentLocation.textContent.replace("Location:", "").trim();
}

function updateLocation(photoId) {
    const inputField = document.getElementById(`location-input-${photoId}`);
    const newLocation = inputField.value.trim();

    if (newLocation) {
        fetch(`${API_BASE_URL}/api/update-location`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photo_id: photoId, location: newLocation })
        })
        .then(response => response.json())
        .then(() => {
            fetch(`${API_BASE_URL}/api/photos`)
                .then(response => response.json())
                .then(photos => {
                    const photo = photos.find(p => p.id === photoId);
                    if (!photo) return;

                    const currentLocation = document.getElementById(`location-text-${photoId}`);
                    const inputField = document.getElementById(`location-input-${photoId}`);
                    const updateButton = document.getElementById(`update-location-${photoId}`);

                    // Update UI with new location
                    currentLocation.innerHTML = `<strong>Location:</strong> ${photo.location}`;
                    currentLocation.style.display = "inline";
                    inputField.style.display = "none";
                    updateButton.style.display = "none";
                });
        })
        .catch(error => console.error("❌ Error updating location:", error));
    }
}


function confirmAISpecies(photoId, speciesName) {
    fetch(`${API_BASE_URL}/api/update-species`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
        .then(response => response.json())
        .then(data => {
            console.log("Server Response:", data);
            updateBirdCard(photoId);
        })
        .catch(error => console.error("❌ Error confirming AI species:", error));
}

function removeSpecies(photoId, speciesName) {
    console.log(`Removing species: ${speciesName} from photo ID: ${photoId}`);

    fetch(`${API_BASE_URL}/api/remove-species`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
        .then(response => response.json())
        .then(data => {
            console.log("Server Response:", data);
            updateBirdCard(photoId);
        })
        .catch(error => console.error("❌ Error removing species:", error));
}
