const API_BASE_URL = "https://birdpics.pics";

// Global variable to hold all photos for filtering
let allPhotos = [];

document.addEventListener("DOMContentLoaded", () => {
    // If the user is on /home or /admin, fetch all photos:
    const pathname = window.location.pathname;
    if (pathname.includes("/home") || pathname.includes("/admin")) {
        fetchPhotos(); // => Calls /api/photos
    }
    // Note: Assumes approval page fetches its own data via fetchPendingPhotos in approval.html
});


function populateSpeciesFilter(photos) {
    const filterDropdown = document.getElementById("species-filter");
    if (!filterDropdown) return; // Exit if the element isn't found

    filterDropdown.innerHTML = `<option value="all">All Species</option>`;

    const uniqueSpecies = new Set();
    photos.forEach(photo => {
        // Use the potentially updated species_names field
        if (photo.species_names && photo.species_names !== "Unknown") {
            photo.species_names.split(", ").forEach(species => {
                 if (species) uniqueSpecies.add(species.trim()); // Ensure trimmed
            });
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
    if (!gallery) {
        console.error("Photo gallery element not found!");
        return;
    }
    gallery.innerHTML = ""; // Clear previous photos

    const isAdminPage = window.location.pathname.includes("/admin"); // Detect if in admin mode

    photos.forEach(photo => {
        const photoCard = document.createElement("div");
        photoCard.className = "photo-card";
        photoCard.id = `bird-card-${photo.id}`; // Use this ID for updates

        // Use the formatted date from the API response if available, otherwise format
        let displayDate = photo.date_taken_formatted || "Unknown date";

        let formattedLocation = photo.location && photo.location.toLowerCase() !== "unknown" ? photo.location : "Unknown Location"; // More descriptive default
        const dateLocation = `${displayDate}, ${formattedLocation}`;

        // Use species_names string and split it into an array of common names.
        let speciesArray = (photo.species_names && photo.species_names !== "Unknown")
            ? photo.species_names.split(", ").map(s => s.trim()).filter(s => s) // Trim and filter empty
            : []; // Default to empty array if Unknown or null

        // Build species display HTML
        let speciesHtml;
        if (isAdminPage) {
            // Admin: Show tags with remove buttons
            speciesHtml = `<div id="species-container-${photo.id}"><strong>Species:</strong> ${
                speciesArray.length > 0
                    ? speciesArray.map(species => `
                        <span class="species-tag">
                            ${species}
                            <span class="remove-species" title="Remove ${species}" onclick="removeSpecies(${photo.id}, '${species.replace(/'/g, "\\'")}')">✖</span>
                        </span>`).join(" ")
                    : '<span class="species-tag unknown">None Added</span>' // Show if no species linked
                }</div>`;
        } else {
            // Home page: Just display text
            speciesHtml = `<p><strong>Species:</strong> ${speciesArray.length > 0 ? speciesArray.join(", ") : 'Unknown'}</p>`;
        }

        let photographerName = photo.photographer && photo.photographer !== "Unknown" ? photo.photographer : "Unknown Photographer"; // More descriptive default

        // Default display content for all pages
        let cardContent = `
            <div class="photo-info">${dateLocation}</div>
            <img src="${photo.image_filename}" alt="Bird Photo" loading="lazy">
            ${speciesHtml}
        `;

        // If on admin page, append editing controls.
        if (isAdminPage) {
            // --- AI Suggestion Display ---
            if (photo.species_suggestions && !speciesArray.includes(photo.species_suggestions)) { // Only show if suggestion exists AND isn't already added
                cardContent += `
                    <div class="ai-suggestion" style="margin-top: 10px; padding: 5px; background-color: #eee;">
                        <strong>AI Suggestion:</strong> ${photo.species_suggestions}
                        <button onclick="confirmAISpecies(${photo.id}, '${photo.species_suggestions.replace(/'/g, "\\'")}')" title="Add this species">Confirm</button>
                    </div>
                `;
            }
             // --- Add Species Input ---
             cardContent += `
                <div class="species-edit" style="margin-top: 10px;">
                    <input type="text" id="species-input-${photo.id}" placeholder="Add Species Manually" onkeyup="fetchSpeciesSuggestions(${photo.id})">
                    <div id="species-dropdown-${photo.id}" class="species-dropdown"></div>
                    <button onclick="updateSpecies(${photo.id})" title="Add species from input">Add Species</button>
                </div>
             `;

            // --- Location Edit ---
            cardContent += `
                <div id="location-container-${photo.id}" style="margin-top: 5px;">
                    <span id="location-text-${photo.id}" class="location-text">
                        <strong>Location:</strong> ${formattedLocation}
                        <button onclick="editLocation(${photo.id})" title="Edit location">Edit</button>
                    </span>
                    <span id="location-edit-controls-${photo.id}" style="display:none;">
                         <input type="text" id="location-input-${photo.id}" placeholder="Edit Location">
                         <button id="update-location-${photo.id}" onclick="updateLocation(${photo.id})" title="Save location">Update</button>
                         <button onclick="cancelEditLocation(${photo.id})" title="Cancel edit">Cancel</button>
                    </span>
                </div>
                `;

            // --- Photographer Edit ---
            cardContent += `
                <div id="photographer-container-${photo.id}" style="margin-top: 5px;">
                    <span id="photographer-text-${photo.id}" class="photographer-text">
                        <strong>User:</strong> <span id="photographer-name-${photo.id}">${photographerName}</span>
                        <button onclick="editPhotographer(${photo.id})" title="Edit photographer">Edit</button>
                    </span>
                     <span id="photographer-edit-controls-${photo.id}" style="display:none;">
                        <input type="text" id="photographer-input-${photo.id}" placeholder="Enter Photographer">
                        <button id="update-photographer-${photo.id}" onclick="updatePhotographer(${photo.id})" title="Save photographer">Update</button>
                        <button onclick="cancelEditPhotographer(${photo.id})" title="Cancel edit">Cancel</button>
                    </span>
                </div>
                `;

            // --- Delete Button ---
            cardContent += `
                <button onclick="deletePhoto(${photo.id})" style="margin-top: 15px; color: red; border-color: red;" title="Delete this photo permanently">Delete Photo</button>
            `;
        }

        photoCard.innerHTML = cardContent;
        gallery.appendChild(photoCard);
    });
}

// --- Delete Photo ---
function deletePhoto(photoId) {
    if (confirm("Are you sure you want to delete this photo? This cannot be undone.")) {
        fetch(`${API_BASE_URL}/api/delete-photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo_id: photoId })
        })
            .then(response => {
                if (!response.ok) {
                    return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) });
                }
                return response.json();
            })
            .then(data => {
                console.log("Photo deleted response:", data);
                // Remove the photo card from the DOM
                const photoCard = document.getElementById(`bird-card-${photoId}`) || document.getElementById(`photo-${photoId}`); // Check both possible IDs
                if (photoCard) {
                    photoCard.remove();
                    alert("Photo deleted successfully."); // Alert after removal
                } else {
                    console.warn("Could not find photo card to remove:", photoId);
                    alert("Photo deleted from database, but card not found on page.");
                }
                 // Optionally, refresh the filter counts or the whole list if needed
                 // fetchPhotos(); // Uncomment if you want to refresh the whole view
            })
            .catch(error => {
                console.error("Error deleting photo:", error);
                alert(`Error deleting photo: ${error.message}`);
            });
    }
}


// --- Edit/Update Photographer ---
function editPhotographer(photoId) {
    // Hide text span, show edit span
    document.getElementById(`photographer-text-${photoId}`).style.display = "none";
    document.getElementById(`photographer-edit-controls-${photoId}`).style.display = "inline";
    // Pre-fill input
    const currentName = document.getElementById(`photographer-name-${photoId}`).textContent;
    document.getElementById(`photographer-input-${photoId}`).value = (currentName !== "Unknown Photographer" ? currentName : "");
    document.getElementById(`photographer-input-${photoId}`).focus();
}

function cancelEditPhotographer(photoId) {
     // Show text span, hide edit span
     document.getElementById(`photographer-text-${photoId}`).style.display = "inline";
     document.getElementById(`photographer-edit-controls-${photoId}`).style.display = "none";
}

function updatePhotographer(photoId) {
    const photographerInput = document.getElementById(`photographer-input-${photoId}`);
    const newPhotographer = photographerInput.value.trim(); // Use trimmed value

    // Use the consolidated endpoint
    fetch(`${API_BASE_URL}/api/update-photo-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
             photo_id: photoId,
             photographer: newPhotographer // Send only the photographer field
             // Server side should handle finding/creating user ID
        })
    })
    .then(response => {
         if (!response.ok) { return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) }); }
         return response.json();
     })
    .then(() => {
        console.log(`Photographer updated for photo ${photoId}`);
        // Update UI directly
        const nameSpan = document.getElementById(`photographer-name-${photoId}`);
        nameSpan.textContent = newPhotographer || "Unknown Photographer"; // Update displayed name
        cancelEditPhotographer(photoId); // Hide edit controls
    })
    .catch(error => {
         console.error("❌ Error updating photographer:", error);
         alert(`Failed to update photographer: ${error.message}`);
         // Optionally revert UI or keep edit open
     });
}

// --- Edit/Update Location ---
function editLocation(photoId) {
     // Hide text span, show edit span
     document.getElementById(`location-text-${photoId}`).style.display = "none";
     document.getElementById(`location-edit-controls-${photoId}`).style.display = "inline";
     // Pre-fill input
     const currentLoc = document.getElementById(`location-text-${photoId}`).textContent.replace('Location:', '').trim();
     document.getElementById(`location-input-${photoId}`).value = (currentLoc !== "Unknown Location" ? currentLoc : "");
     document.getElementById(`location-input-${photoId}`).focus();
}

function cancelEditLocation(photoId) {
      // Show text span, hide edit span
      document.getElementById(`location-text-${photoId}`).style.display = "inline";
      document.getElementById(`location-edit-controls-${photoId}`).style.display = "none";
}


function updateLocation(photoId) {
    const inputField = document.getElementById(`location-input-${photoId}`);
    const newLocation = inputField.value.trim(); // Use trimmed value

     // Use the consolidated endpoint
     fetch(`${API_BASE_URL}/api/update-photo-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
             photo_id: photoId,
             location: newLocation // Send only the location field
        })
    })
    .then(response => {
          if (!response.ok) { return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) }); }
          return response.json();
      })
    .then(() => {
        console.log(`Location updated for photo ${photoId}`);
         // Update UI directly
         const locationSpan = document.getElementById(`location-text-${photoId}`);
         locationSpan.innerHTML = `<strong>Location:</strong> ${newLocation || 'Unknown Location'}`; // Update display
         cancelEditLocation(photoId); // Hide edit controls
    })
    .catch(error => {
          console.error("❌ Error updating location:", error);
          alert(`Failed to update location: ${error.message}`);
      });
}


// --- Fetch All Photos (Approved) ---
function fetchPhotos() {
    fetch(`${API_BASE_URL}/api/photos`) // Fetches approved photos
        .then(response => {
             if (!response.ok) { return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) }); }
             return response.json();
         })
        .then(photos => {
            allPhotos = photos; // Store for filtering
            if (document.getElementById("species-filter")) {
                 populateSpeciesFilter(photos); // Populate filter only if element exists
            }
            displayPhotos(photos); // Display the photos
        })
        .catch(error => {
            console.error("❌ Error fetching photos:", error);
            const gallery = document.getElementById("photo-gallery");
            if(gallery) gallery.innerHTML = `<p style="color: red;">Could not load photos. ${error.message}</p>`;
        });
}

// --- Filter Photos (Client-side) ---
function filterPhotos() {
    const selectedSpecies = document.getElementById("species-filter").value;
    if (!allPhotos) { // Ensure allPhotos is loaded
        console.warn("Attempted to filter before photos loaded.");
        return;
    }

    if (selectedSpecies === "all") {
        displayPhotos(allPhotos); // Show all photos if "All Species" is selected
    } else {
        const filteredPhotos = allPhotos.filter(photo =>
            photo.species_names && photo.species_names.split(', ').map(s=>s.trim()).includes(selectedSpecies)
        );
        displayPhotos(filteredPhotos); // Show only matching species
    }
}

// --- Species Suggestions (Text Input) ---
function fetchSpeciesSuggestions(photoId) {
    const inputField = document.getElementById(`species-input-${photoId}`);
    const query = inputField.value.trim();
    const dropdown = document.getElementById(`species-dropdown-${photoId}`);

    if (!dropdown) return; // Should not happen, but safe check

    if (query.length < 2) {
        dropdown.innerHTML = "";
        dropdown.style.display = "none"; // Hide dropdown
        return;
    }

    fetch(`${API_BASE_URL}/api/species-suggestions?query=${encodeURIComponent(query)}`)
        .then(response => {
             if (!response.ok) { return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) }); }
             return response.json();
         })
        .then(suggestions => {
            dropdown.innerHTML = ""; // Clear previous suggestions
            if (suggestions.length === 0) {
                 dropdown.style.display = "none"; // Hide if no suggestions
                 return;
            }

            suggestions.forEach(species => {
                const suggestionItem = document.createElement("div");
                suggestionItem.className = "autocomplete-item"; // Use class from styles.css
                suggestionItem.textContent = species;
                suggestionItem.onclick = (e) => {
                    e.stopPropagation(); // Prevent card click or other events
                    inputField.value = species;
                    dropdown.innerHTML = ""; // Clear dropdown
                    dropdown.style.display = "none"; // Hide dropdown
                    // Optionally call updateSpecies directly after selection?
                    // updateSpecies(photoId);
                };
                dropdown.appendChild(suggestionItem);
            });
            dropdown.style.display = "block"; // Show dropdown
        })
        .catch(error => {
             console.error("❌ Error fetching species suggestions:", error);
             dropdown.innerHTML = ""; // Clear on error
             dropdown.style.display = "none";
         });
}

// Close dropdown if clicking outside
document.addEventListener('click', function(event) {
    const dropdowns = document.querySelectorAll('.species-dropdown');
    dropdowns.forEach(dropdown => {
        // Check if the click was outside the dropdown and its corresponding input
        const inputId = dropdown.id.replace('species-dropdown-', 'species-input-');
        const inputElement = document.getElementById(inputId);
        if (!dropdown.contains(event.target) && event.target !== inputElement) {
            dropdown.innerHTML = "";
            dropdown.style.display = 'none';
        }
    });
});


// --- Update/Add Species (Manual or Confirming AI) ---
// Called by the manual "Add Species" button
function updateSpecies(photoId) {
    const inputField = document.getElementById(`species-input-${photoId}`);
    if (!inputField) return;
    const speciesName = inputField.value.trim();
    if (!speciesName) {
        alert("Please enter or select a species name.");
        return;
    }
    // Call the common function to handle the API call
    addSpeciesToPhotoAPI(photoId, speciesName);
    inputField.value = ""; // Clear input after attempting add
    const dropdown = document.getElementById(`species-dropdown-${photoId}`);
    if(dropdown) {
         dropdown.innerHTML = ""; // Clear dropdown
         dropdown.style.display = "none";
    }
}

// Called by the "Confirm" button next to AI suggestion
function confirmAISpecies(photoId, speciesName) {
    console.log(`Confirming AI species: ${speciesName} for photo ID: ${photoId}`);
     // Call the common function to handle the API call
    addSpeciesToPhotoAPI(photoId, speciesName);
     // Optionally hide the AI suggestion div after confirming
     const aiSuggestionDiv = document.querySelector(`#bird-card-${photoId} .ai-suggestion`);
     if (aiSuggestionDiv) {
          aiSuggestionDiv.style.display = 'none';
     }
}

// Common function to call the update-species API
function addSpeciesToPhotoAPI(photoId, speciesName) {
     if (!speciesName) {
          console.error("Attempted to add empty species name.");
          return; // Don't proceed if species name is empty
     }
     fetch(`${API_BASE_URL}/api/update-species`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
    .then(response => {
         // Handle cases where species might already be linked (server might return specific message/status)
         if (!response.ok && response.status !== 409) { // Allow 409 Conflict (already linked) potentially
              return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) });
         }
         return response.json();
     })
    .then(data => {
        console.log("Add/Confirm species response:", data);
        // Update the specific card instead of refetching everything
        updateBirdCardSpecies(photoId, speciesName, 'add');
    })
    .catch(error => {
         console.error("Error adding/confirming species:", error);
         alert(`Failed to add species: ${error.message}`);
     });
}


// --- Remove Species Tag ---
function removeSpecies(photoId, speciesName) {
    console.log(`Removing species: ${speciesName} from photo ID: ${photoId}`);
    if (!speciesName || speciesName === "Unknown") return; // Don't remove "Unknown" tag

    fetch(`${API_BASE_URL}/api/remove-species`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, common_name: speciesName })
    })
    .then(response => {
         if (!response.ok) { return response.json().then(err => { throw new Error(err.error || `HTTP error ${response.status}`) }); }
         return response.json();
     })
    .then(data => {
        console.log("Remove species response:", data);
         // Update the specific card instead of refetching everything
         updateBirdCardSpecies(photoId, speciesName, 'remove');
    })
    .catch(error => {
         console.error("❌ Error removing species:", error);
         alert(`Failed to remove species: ${error.message}`);
     });
}


// --- Update Card Species Directly (More Efficient) ---
function updateBirdCardSpecies(photoId, speciesName, action = 'add') {
     const card = document.getElementById(`bird-card-${photoId}`);
     if (!card) return;
     const speciesContainer = card.querySelector(`#species-container-${photoId}`);
     if (!speciesContainer) return;

     // Get current species from tags (excluding the remove '✖' span)
     let currentSpecies = Array.from(speciesContainer.querySelectorAll('.species-tag'))
                                .map(tag => tag.textContent.replace(/✖$/, '').trim()) // Get text, remove trailing X
                                .filter(s => s && s !== 'None Added'); // Filter out empty/placeholder

     if (action === 'add') {
          // Add species if not already present
          if (!currentSpecies.includes(speciesName)) {
               currentSpecies.push(speciesName);
          }
     } else if (action === 'remove') {
          // Remove species
          currentSpecies = currentSpecies.filter(s => s !== speciesName);
     }

     // Rebuild the HTML for species tags
     let newSpeciesHtml = '<strong>Species:</strong> ';
     if (currentSpecies.length > 0) {
          newSpeciesHtml += currentSpecies.map(species => `
               <span class="species-tag">
                    ${species}
                    <span class="remove-species" title="Remove ${species}" onclick="removeSpecies(${photoId}, '${species.replace(/'/g, "\\'")}')">✖</span>
               </span>`).join(" ");
     } else {
          newSpeciesHtml += '<span class="species-tag unknown">None Added</span>';
     }
     speciesContainer.innerHTML = newSpeciesHtml;

     // Also, potentially re-show the AI suggestion if the species removed was the AI suggestion
     const aiSuggestionDiv = card.querySelector(`.ai-suggestion`);
     if (aiSuggestionDiv) {
         const aiSuggestionText = aiSuggestionDiv.textContent.replace('AI Suggestion:', '').replace('Confirm','').trim();
         if (!currentSpecies.includes(aiSuggestionText)) {
              aiSuggestionDiv.style.display = 'block'; // Or 'flex' depending on your CSS
         } else {
             aiSuggestionDiv.style.display = 'none'; // Hide if it was added manually now
         }
     }
}

