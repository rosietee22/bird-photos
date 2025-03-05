const API_BASE_URL = "https://birdpics.pics";

document.addEventListener("DOMContentLoaded", () => {
    // If the user is on /home or /admin, fetch all photos:
    if (window.location.pathname.includes("home") || window.location.pathname.includes("admin")) {
      fetchPhotos(); // => Calls /api/photos
    }
  });  

function populateSpeciesFilter(photos) {
    const filterDropdown = document.getElementById("species-filter");
    if (!filterDropdown) return; // Exit if the element isn't found

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
                        <strong>User:</strong> <span id="photographer-name-${photo.id}">${photographerName}</span>
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

function updateSpecies(photoId) {
    const inputField = document.getElementById(`species-${photoId}`);
    const speciesName = inputField.value.trim();
    if (!speciesName) {
        alert("Please enter a species name.");
        return;
    }
    fetch(`${API_BASE_URL}/api/update-species`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
    .then(response => response.json())
    .then(data => {
        console.log("Species updated successfully:", data);
        updateBirdCard(photoId);
        inputField.value = "";
    })
    .catch(error => console.error("Error updating species:", error));
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
