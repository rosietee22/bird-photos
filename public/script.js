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

    uniqueSpecies.forEach(species => {
        const option = document.createElement("option");
        option.value = species;
        option.textContent = species;
        filterDropdown.appendChild(option);
    });
}

function displayPhotos(photos) {
    const gallery = document.getElementById("photo-gallery");
    gallery.innerHTML = "";

    const isAdminPage = window.location.pathname.includes("admin.html"); // Detect if in admin mode

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

        let formattedLocation = photo.location && photo.location.toLowerCase() !== "unknown" ? `, ${photo.location}` : "";
        const dateLocation = `${formattedDate}${formattedLocation}`;

        let speciesText = photo.species_names !== "Unknown"
            ? `<p><strong>Species:</strong> ${photo.species_names}</p>`
            : "<p><strong>Species:</strong> Unknown</p>";

        // 🟢 Default Home Page Display (No Editing)
        let cardContent = `
            <div class="photo-info">${dateLocation}</div>
            <img src="${photo.image_filename}" alt="Bird Photo">
            ${speciesText}
        `;

        // 🔴 Add Admin Features (Edit, Delete) if on Admin Page
        if (isAdminPage) {
            cardContent += `
                <div id="species-container-${photo.id}">
                    <strong>Species:</strong> 
                    ${photo.species_names.split(", ").map(species => `
                        <span class="species-tag">
                            ${species} <span class="remove-species" onclick="removeSpecies(${photo.id}, '${species}')">✖</span>
                        </span>
                    `).join(" ")}
                </div>

                <input type="text" id="species-${photo.id}" placeholder="Add or Edit Species" onkeyup="fetchSpeciesSuggestions(${photo.id})">
                <div id="species-dropdown-${photo.id}" class="species-dropdown"></div>
                <button onclick="updateSpecies(${photo.id})">Update Species</button>

                <p class="location-text"><strong>Location:</strong> ${photo.location || "Unknown"} 
                    <button onclick="editLocation(${photo.id})">Edit</button>
                </p>
                <input type="text" id="location-${photo.id}" placeholder="Edit Location">
                <button onclick="updateLocation(${photo.id})">Update Location</button>

                <button onclick="deletePhoto(${photo.id})" class="delete-btn">Delete Photo</button>
            `;
        }

        photoCard.innerHTML = cardContent;
        gallery.appendChild(photoCard);
    });
}


function fetchPhotos() {
    fetch(`${API_BASE_URL}/api/photos`)
        .then(response => response.json())
        .then(photos => {
            allPhotos = photos;
            populateSpeciesFilter(photos);
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




function updateSpecies(photoId) {
    const inputField = document.getElementById(`species-${photoId}`);
    const speciesName = inputField.value.trim();

    if (speciesName) {
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
            .catch(error => console.error("❌ Error updating species:", error));
    }
}

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

function updateLocation(photoId) {
    const locationInput = document.getElementById(`location-${photoId}`);
    const location = locationInput.value.trim();

    if (location) {
        fetch(`${API_BASE_URL}/api/update-location`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photo_id: photoId, location })
        })
            .then(response => response.json())
            .then(() => {
                fetch(`${API_BASE_URL}/api/photos`)
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
