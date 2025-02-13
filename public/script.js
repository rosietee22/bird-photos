document.addEventListener("DOMContentLoaded", fetchPhotos);

function fetchPhotos() {
    fetch("http://localhost:3000/api/photos")
        .then(response => response.json())
        .then(photos => {
            allPhotos = photos;
            populateSpeciesFilter(photos); // ✅ Add this line
            displayPhotos(photos);
        })
        .catch(error => console.error("Error fetching photos:", error));
}

function fetchSpeciesSuggestions(photoId) {
    const inputField = document.getElementById(`species-${photoId}`);
    const query = inputField.value.trim();

    if (query.length < 2) {
        document.getElementById(`species-dropdown-${photoId}`).innerHTML = "";
        return;
    }

    fetch(`http://localhost:3000/api/species-suggestions?query=${query}`)
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

function updateSpecies(photoId) {
    const inputField = document.getElementById(`species-${photoId}`);
    const speciesName = inputField.value.trim();

    if (speciesName) {
        fetch("http://localhost:3000/api/update-species", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
        })
            .then(response => response.json())
            .then(data => {
                console.log("Server Response:", data); // ✅ Debugging log
                updateBirdCard(photoId);
            })
            .catch(error => console.error("❌ Error updating species:", error));
    }
}

function updateBirdCard(photoId) {
    fetch("http://localhost:3000/api/photos")
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
    const card = document.getElementById(`bird-card-${photoId}`);
    const locationElement = card.querySelector("p.location-text");

    if (locationElement) {
        const existingLocation = locationElement.textContent.replace("Location:", "").trim();
        locationElement.innerHTML = `
            <input type="text" id="location-${photoId}" value="${existingLocation}">
            <button onclick="updateLocation(${photoId})">Save</button>
        `;
    }
}


function updateLocation(photoId) {
    const locationInput = document.getElementById(`location-${photoId}`);
    const location = locationInput.value.trim();

    if (location) {
        fetch("http://localhost:3000/api/update-location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photo_id: photoId, location })
        })
            .then(response => response.json())
            .then(() => {
                fetch("http://localhost:3000/api/photos")
                    .then(response => response.json())
                    .then(photos => {
                        const photo = photos.find(p => p.id === photoId);
                        if (!photo) return;

                        const card = document.getElementById(`bird-card-${photoId}`);
                        if (card) {
                            const locationContainer = card.querySelector("p.location-text");
                            if (locationContainer) {
                                locationContainer.innerHTML = `<strong>Location:</strong> ${photo.location} <button onclick="editLocation(${photo.id})">Edit</button>`;
                            }
                        }
                    });
            })
            .catch(error => console.error("❌ Error updating location:", error));
    }
}

function populateSpeciesFilter(photos) {
    const filterDropdown = document.getElementById("species-filter");
    filterDropdown.innerHTML = `<option value="all">All Species</option>`;

    const uniqueSpecies = new Set();
    photos.forEach(photo => {
        if (photo.species_names) {
            photo.species_names.split(", ").forEach(species => uniqueSpecies.add(species));
        }
    });

    uniqueSpecies.forEach(species => {
        const option = document.createElement("option");
        option.value = species;
        option.textContent = species;
        filterDropdown.appendChild(option);
    });
}

function filterPhotos() {
    const selectedSpecies = document.getElementById("species-filter").value;
    if (selectedSpecies === "all") {
        displayPhotos(allPhotos);
    } else {
        const filteredPhotos = allPhotos.filter(photo =>
            photo.species_names && photo.species_names.includes(selectedSpecies)
        );
        displayPhotos(filteredPhotos);
    }
}


function displayPhotos(photos) {
    const gallery = document.getElementById("photo-gallery");
    gallery.innerHTML = "";

    photos.forEach(photo => {
        const photoCard = document.createElement("div");
        photoCard.className = "photo-card";
        photoCard.id = `bird-card-${photo.id}`;

        // ✅ Format Date
        let formattedDate = "Unknown date";
        if (photo.date_taken) {
            const dateObj = new Date(photo.date_taken);
            formattedDate = dateObj.toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "long",
                year: "numeric",
            });
        }

        // ✅ Format Location
        let formattedLocation = photo.location && photo.location.toLowerCase() !== "unknown" ? `, ${photo.location}` : "";
        const dateLocation = `${formattedDate}${formattedLocation}`;

        let speciesArray = photo.species_names ? photo.species_names.split(", ") : [];
        let speciesList = speciesArray.length > 0
            ? speciesArray.map(species => `
                <span class="species-tag">
                    ${species} <span class="remove-species" onclick="removeSpecies('${photo.id}', '${species}')">✖</span>
                </span>
            `).join(" ") : "<span class='species-tag unknown'>Unknown</span>";

        let isLocationEditable = !photo.location || photo.location.toLowerCase() === "unknown";
        let locationText = isLocationEditable
            ? `<p class="location-text"><strong>Location:</strong> 
                <input type="text" id="location-${photo.id}" placeholder="Enter location">
                <button onclick="updateLocation(${photo.id})">Save</button>
            </p>`
            : `<p class="location-text"><strong>Location:</strong> ${photo.location} <button onclick="editLocation(${photo.id})">Edit</button></p>`;

        const speciesInput = `
            <div class="autocomplete-container">
                <input type="text" id="species-${photo.id}" placeholder="Enter species name" oninput="fetchSpeciesSuggestions(${photo.id})">
                <div id="species-dropdown-${photo.id}" class="species-dropdown"></div>
                <button onclick="updateSpecies(${photo.id})">Save</button>
            </div>
        `;

        // ✅ Updated HTML structure with Date + Location at the top-left
        photoCard.innerHTML = `
            <div class="photo-info">${dateLocation}</div>  <!-- ✅ New formatted Date & Location -->
            <img src="http://localhost:3000${photo.image_filename}" alt="Bird Photo">
            <p><strong>Species:</strong> <span id="species-container-${photo.id}">${speciesList}</span></p>
            ${speciesInput}
        `;

        gallery.appendChild(photoCard);
    });
}



function removeSpecies(photoId, speciesName) {
    console.log(`Removing species: ${speciesName} from photo ID: ${photoId}`); // Debugging log

    fetch("http://localhost:3000/api/remove-species", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
        .then(response => response.json())
        .then(data => {
            console.log("Server Response:", data); // Debugging response
            updateBirdCard(photoId); // Refresh only this bird's card
        })
        .catch(error => console.error("❌ Error removing species:", error));
}



