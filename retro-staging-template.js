// ============================================
// GAME CONFIGURATION - EDIT THIS SECTION ONLY
// ============================================
const GAME_TIMER_SECONDS = (() => {
	const urlParams = new URLSearchParams(window.location.search);
	const timeout = urlParams.get("timeout");
	return timeout && !isNaN(timeout) && parseInt(timeout) > 0
		? parseInt(timeout)
		: null;
})();
const WARNING_THRESHOLD = 30; // Show warning when timer reaches this value

// Minimal death flag (opt-in by ?deaths=1|true|yes). Game pages (e.g. MegaMan X3) read this
// and run their own memory-based detection, then call inGameTrx() when limit reached.
const DEATHS_ENABLED = (() => {
	try {
		const p = new URLSearchParams(window.location.search);
		const v = (p.get('deaths') || '').toLowerCase();
		return v === '1' || v === 'true' || v === 'yes';
	} catch { return false; }
})();
window.DEATHS_ENABLED = DEATHS_ENABLED;

// EmulatorJS Configuration
EJS_player = "#game";
EJS_core = "{{CORE}}"; // Game console: gba, nes, snes, psx, n64, nds, etc.
EJS_gameName = "{{GAME_NAME}}"; // Game identifier (display name)
EJS_gameID = "{{GAME_ID}}"; // Actual database UUID for API calls
EJS_color = "#0064ff"; // Theme color
EJS_startOnLoaded = true;
EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
EJS_gameUrl = "{{GAME_FILE}}"; // ROM/ISO filename
{ { LOAD_STATE_URL } }
EJS_language = "en-US";

// Performance Optimizations
EJS_threads = typeof SharedArrayBuffer !== "undefined"; // Enable threading if supported

// ============================================
// AUTO-SAVE CONFIGURATION
// ============================================
const AUTO_SAVE_CONFIG = {
	enabled: false,
	saveIntervalSeconds: 30,
	serverUrl: window.location.origin,
	enableDebugLogs: true,
	showNotifications: false,
};

let autoSaveTimer = null;
let saveInProgress = false;
let lastSaveTimestamp = null;

// ============================================
// END CONFIGURATION
// ============================================
(function initLoadProgressReporter() {
	// Only initialize if running in Electron with electronAPI
	if (!window.electronAPI || !window.electronAPI.send) {
		console.log('[PROGRESS] Not in Electron, skipping progress reporter');
		return;
	}

	const gameId = '{{GAME_NAME}}'; // Uses template variable
	const startTime = Date.now();
	let lastReportedPercent = 0;

	// Helper to report progress
	function reportProgress(percent, message) {
		// Only report if progress increased by at least 5% to avoid spam
		if (percent - lastReportedPercent >= 5 || percent >= 100) {
			try {
				window.electronAPI.send('game-load-progress', {
					gameId: gameId,
					percent: percent,
					message: message,
					timestamp: Date.now()
				});
				lastReportedPercent = percent;
				console.log(`[PROGRESS] ${percent.toFixed(0)}% - ${message}`);
			} catch (e) {
				console.warn('[PROGRESS] Failed to send progress:', e);
			}
		}
	}

	// Report initial load
	reportProgress(0, 'Initializing EmulatorJS');

	// Report on DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () {
			reportProgress(20, 'DOM loaded');
		});
	} else {
		reportProgress(20, 'DOM already loaded');
	}

	// Report on window load
	window.addEventListener('load', function () {
		reportProgress(50, 'Window loaded');
	});

	// Hook into EmulatorJS lifecycle
	// Note: We'll wrap EJS_onGameStart after initGame is defined (see below)

	// Heartbeat - periodically report progress to prevent timeout
	// This is crucial for slow machines or large ROMs
	let heartbeatPercent = 50;
	const heartbeatInterval = setInterval(function () {
		const elapsed = Date.now() - startTime;

		// Stop heartbeat after 2 minutes or when game loaded
		if (elapsed > 120000 || gameLoaded) {
			clearInterval(heartbeatInterval);
			return;
		}

		// If we haven't reported completion yet, send heartbeat
		if (lastReportedPercent < 90) {
			const elapsedSeconds = Math.floor(elapsed / 1000);
			reportProgress(
				Math.min(heartbeatPercent, 85),
				`Loading ROM... (${elapsedSeconds}s elapsed)`
			);
			heartbeatPercent = Math.min(heartbeatPercent + 2, 85);
		}
	}, 5000); // Every 5 seconds

	// Fallback: Use the existing checkGameReady function as a progress indicator
	const checkInterval = setInterval(function () {
		if (gameLoaded) {
			clearInterval(checkInterval);
			reportProgress(100, 'Game confirmed ready');
		} else if (checkGameReady && checkGameReady()) {
			clearInterval(checkInterval);
			reportProgress(95, 'Game canvas detected');
		}
	}, 1000);

	console.log('[PROGRESS] Load progress reporter initialized for game:', gameId);
})();
// ============================================
// END LOAD PROGRESS REPORTER
// ============================================
// Timer variables
let gameTimer = GAME_TIMER_SECONDS;
let timerInterval;
// Initialize gameToken from window.gameToken if available (set by launcher generator)
let gameToken = (typeof window !== 'undefined' && window.gameToken) ? window.gameToken : undefined;
let timerStarted = false;
let gameLoaded = false;



// WebSocket and health check variables
let websocket;
let healthCheckInterval;
let healthCheckFailures = 0;
const maxHealthCheckFailures = 3;
let isGameActive = true;

// Cache DOM elements
const timerOverlay = document.getElementById("timer-overlay");
const gameContainer = document.querySelector("#game");

// Helper: Get emulator instance
const getEmulator = () => window.EJS_emulator || gameContainer?.ej;

// Helper: Store emulator instance
const storeEmulator = () => {
	if (typeof EmulatorJS !== "undefined" && gameContainer?.ej) {
		window.EJS_emulator = gameContainer.ej;
	}
};

// ============================================
// AUTO-SAVE HELPER FUNCTIONS
// ============================================
const log = (...args) => {
	if (AUTO_SAVE_CONFIG.enableDebugLogs) {
		console.log("[AutoSave]", ...args);
	}
};

const getGameId = () => {
	// 1. Use the actual database UUID if provided via template
	if (typeof EJS_gameID !== "undefined" && EJS_gameID) {
		return EJS_gameID;
	}

	// 2. Try to extract UUID from current URL path (e.g., /proxy/{uuid}/index.html)
	try {
		const urlPath = window.location.pathname;
		// Match UUID pattern in URL: /proxy/{uuid}/ or /{uuid}/
		const uuidRegex =
			/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
		const match = urlPath.match(uuidRegex);
		if (match && match[1]) {
			log(`Extracted gameID from URL: ${match[1]}`);
			return match[1];
		}
	} catch (error) {
		log("Error extracting gameID from URL:", error);
	}

	// 3. Fallback to sanitized name for backwards compatibility
	if (!EJS_gameName) return null;
	const sanitized = EJS_gameName.toLowerCase().replace(/[^a-z0-9]/g, "-");
	log(`Using fallback gameID (sanitized name): ${sanitized}`);
	return sanitized;
};

const getAuthToken = () => {
	// Check window.gameToken first (set by launcher generator)
	if (typeof window !== 'undefined' && window.gameToken) {
		return window.gameToken;
	}
	// Fallback to gameToken variable
	return gameToken;
};

// Helper: Convert Uint8Array to base64 (handles large arrays)
const uint8ArrayToBase64 = (uint8Array) => {
	// For large arrays, process in chunks to avoid stack overflow
	const chunkSize = 32768; // 32KB chunks
	let binary = "";

	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(
			i,
			Math.min(i + chunkSize, uint8Array.length)
		);
		binary += String.fromCharCode.apply(null, chunk);
	}

	return "data:application/octet-stream;base64," + btoa(binary);
};

// Helper: Convert base64 to Uint8Array
const base64ToUint8Array = (base64) => {
	// Remove data URL prefix if present
	const base64Data = base64.replace(
		/^data:application\/octet-stream;base64,/,
		""
	);
	const binaryString = atob(base64Data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
};

// Save current game state to backend (MODIFIED - supports manual saves)
const saveStateToBackend = async (forceSave = false) => {
	// Allow manual saves even if auto-save is disabled
	if (!AUTO_SAVE_CONFIG.enabled && !forceSave) return;

	if (saveInProgress) {
		log("Save already in progress, skipping");
		return;
	}

	const token = getAuthToken();
	const gameId = getGameId();
	const emulator = getEmulator();

	if (!token || !gameId || !emulator || !emulator.gameManager) {
		console.warn("[AutoSave] Cannot save: missing token, gameId, or emulator");
		return;
	}

	saveInProgress = true;
	log(`Saving state for game: ${gameId}`);

	try {
		const stateData = emulator.gameManager.getState();

		if (!stateData || stateData.length === 0) {
			log("Empty state data, skipping save");
			saveInProgress = false;
			return;
		}

		const base64Data = uint8ArrayToBase64(stateData);

		const response = await fetch(
			`${AUTO_SAVE_CONFIG.serverUrl
			}/api/v1/game-state/save?gameID=${encodeURIComponent(gameId)}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					stateData: base64Data,
					compression: "none",
				}),
			}
		);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Save failed: ${response.status} - ${errorText}`);
		}

		const result = await response.json();
		lastSaveTimestamp = Date.now();
		log("State saved successfully:", result);
	} catch (error) {
		console.error("[AutoSave] Error:", error);
		throw error; // Re-throw so caller can handle it
	} finally {
		saveInProgress = false;
	}
};

// Load saved game state from backend (MODIFIED - always loads if available)
const loadStateFromBackend = async () => {
	// Always try to load saved state, regardless of AUTO_SAVE_CONFIG.enabled
	// This allows users to resume from their last save even if auto-save was disabled

	const token = getAuthToken();
	const gameId = getGameId();

	if (!gameId) {
		return null;
	}

	log(`Loading state for game: ${gameId}`);

	try {
		const url = new URL(`${AUTO_SAVE_CONFIG.serverUrl}/api/v1/game-state/load`);
		url.searchParams.set("gameID", gameId);

		const headers = {};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		const response = await fetch(url.toString(), {
			method: "GET",
			headers: headers,
		});

		if (response.status === 404) {
			log("No saved state found on backend, trying local state file...");
			try {
				// Try to fetch local state file (e.g., ./MegaManX3.state)
				const localStateUrl = `./${EJS_gameName}.state`;
				const localResp = await fetch(localStateUrl);
				if (localResp.ok) {
					const arrayBuffer = await localResp.arrayBuffer();
					const stateData = new Uint8Array(arrayBuffer);
					log("Loaded local state file:", localStateUrl, "size:", stateData.length);
					return stateData;
				} else {
					log("No local state file found:", localStateUrl);
				}
			} catch (e) {
				log("Error loading local state file:", e);
			}
			return null;
		}

		if (!response.ok) {
			throw new Error(`Load failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		const stateData = new Uint8Array(arrayBuffer);

		log("State loaded, size:", stateData.length);
		return stateData;
	} catch (error) {
		console.error("[AutoSave] Load error:", error);
		return null;
	}
};

// Start periodic auto-save
const startAutoSave = () => {
	if (!AUTO_SAVE_CONFIG.enabled) return;

	if (autoSaveTimer) {
		clearInterval(autoSaveTimer);
	}

	log(`Starting auto-save (every ${AUTO_SAVE_CONFIG.saveIntervalSeconds}s)`);

	autoSaveTimer = setInterval(() => {
		saveStateToBackend();
	}, AUTO_SAVE_CONFIG.saveIntervalSeconds * 1000);
};

const stopAutoSave = () => {
	if (autoSaveTimer) {
		clearInterval(autoSaveTimer);
		autoSaveTimer = null;
		log("Auto-save stopped");
	}
};

// ============================================
// SAVE PROMPT FUNCTIONALITY
// Note: The save prompt modal HTML is self-injected below for browser compatibility
// ============================================

// Self-inject save prompt modal HTML (works in both Electron and browser)
(function injectSavePromptModal() {
	const existingModal = document.getElementById('savePromptModal');
	if (existingModal) {
		return;
	}

	// Create modal container
	const modal = document.createElement('div');
	modal.id = 'savePromptModal';
	modal.style.cssText = 'display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 999999; justify-content: center; align-items: center; font-family: Arial, sans-serif;';

	// Create modal content
	const content = document.createElement('div');
	content.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center; max-width: 500px; position: relative;';

	// Create close button (X) in upper left
	const closeBtn = document.createElement('button');
	closeBtn.id = 'saveCloseBtn';
	closeBtn.innerHTML = '&times;';
	closeBtn.setAttribute('aria-label', 'Close and resume playing');
	closeBtn.setAttribute('tabindex', '0');
	closeBtn.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(255,255,255,0.2); color: white; border: 2px solid rgba(255,255,255,0.3); width: 40px; height: 40px; border-radius: 50%; font-size: 28px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; transition: all 0.2s; outline: none;';
	closeBtn.onmouseenter = function () { this.style.background = 'rgba(255,255,255,0.3)'; this.style.transform = 'scale(1.1)'; };
	closeBtn.onmouseleave = function () { this.style.background = 'rgba(255,255,255,0.2)'; this.style.transform = 'scale(1)'; };
	closeBtn.onfocus = function () { this.style.background = 'rgba(255,255,255,0.3)'; this.style.borderColor = 'rgba(255,255,255,0.6)'; this.style.boxShadow = '0 0 10px rgba(255,255,255,0.5)'; };
	closeBtn.onblur = function () { this.style.background = 'rgba(255,255,255,0.2)'; this.style.borderColor = 'rgba(255,255,255,0.3)'; this.style.boxShadow = 'none'; };

	// Create title
	const title = document.createElement('h2');
	title.textContent = 'Save Your Progress?';
	title.style.cssText = 'color: white; font-size: 32px; margin: 0 0 20px 0; text-shadow: 0 2px 10px rgba(0,0,0,0.3);';

	// Create description
	const desc = document.createElement('p');
	desc.textContent = "Your progress will be lost if you don't save.";
	desc.style.cssText = 'color: #f0f0f0; font-size: 18px; margin: 0 0 10px 0;';

	// Create countdown
	const countdown = document.createElement('p');
	countdown.id = 'saveCountdown';
	countdown.textContent = '10';
	countdown.style.cssText = 'color: #ffd700; font-size: 24px; font-weight: bold; margin: 0 0 30px 0;';

	// Create button container
	const buttonContainer = document.createElement('div');
	buttonContainer.style.cssText = 'display: flex; gap: 20px; justify-content: center;';

	// Create Yes button
	const yesBtn = document.createElement('button');
	yesBtn.id = 'saveYesBtn';
	yesBtn.textContent = 'Yes, Save';
	yesBtn.setAttribute('tabindex', '0');
	yesBtn.setAttribute('aria-label', 'Yes, Save');
	yesBtn.style.cssText = 'background: #4CAF50; color: white; border: 2px solid transparent; padding: 15px 30px; font-size: 18px; border-radius: 10px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 15px rgba(76, 175, 80, 0.4); transition: all 0.2s; outline: none; min-width: 150px;';
	yesBtn.onmouseenter = function () { this.style.transform = 'scale(1.05)'; this.style.boxShadow = '0 6px 20px rgba(76, 175, 80, 0.6)'; };
	yesBtn.onmouseleave = function () { this.style.transform = 'scale(1)'; this.style.boxShadow = '0 4px 15px rgba(76, 175, 80, 0.4)'; };
	yesBtn.onfocus = function () { this.style.borderColor = 'rgba(255,255,255,0.8)'; this.style.boxShadow = '0 0 20px rgba(76, 175, 80, 0.8), 0 4px 15px rgba(76, 175, 80, 0.4)'; };
	yesBtn.onblur = function () { this.style.borderColor = 'transparent'; this.style.boxShadow = '0 4px 15px rgba(76, 175, 80, 0.4)'; };

	// Create No button
	const noBtn = document.createElement('button');
	noBtn.id = 'saveNoBtn';
	noBtn.textContent = 'No, Discard';
	noBtn.setAttribute('tabindex', '0');
	noBtn.setAttribute('aria-label', 'No, Discard');
	noBtn.style.cssText = 'background: #f44336; color: white; border: 2px solid transparent; padding: 15px 30px; font-size: 18px; border-radius: 10px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 15px rgba(244, 67, 54, 0.4); transition: all 0.2s; outline: none; min-width: 150px;';
	noBtn.onmouseenter = function () { this.style.transform = 'scale(1.05)'; this.style.boxShadow = '0 6px 20px rgba(244, 67, 54, 0.6)'; };
	noBtn.onmouseleave = function () { this.style.transform = 'scale(1)'; this.style.boxShadow = '0 4px 15px rgba(244, 67, 54, 0.4)'; };
	noBtn.onfocus = function () { this.style.borderColor = 'rgba(255,255,255,0.8)'; this.style.boxShadow = '0 0 20px rgba(244, 67, 54, 0.8), 0 4px 15px rgba(244, 67, 54, 0.4)'; };
	noBtn.onblur = function () { this.style.borderColor = 'transparent'; this.style.boxShadow = '0 4px 15px rgba(244, 67, 54, 0.4)'; };

	// Assemble DOM structure
	content.appendChild(closeBtn);
	buttonContainer.appendChild(yesBtn);
	buttonContainer.appendChild(noBtn);
	content.appendChild(title);
	content.appendChild(desc);
	content.appendChild(countdown);
	content.appendChild(buttonContainer);
	modal.appendChild(content);

	// Inject into body
	if (document.body) {
		document.body.appendChild(modal);
	} else {
		// Wait for DOM if body doesn't exist yet
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', function () {
				document.body.appendChild(modal);
			});
		} else {
			// Fallback: create body if it doesn't exist
			const body = document.body || document.createElement('body');
			body.appendChild(modal);
			if (!document.body) {
				document.appendChild(body);
			}
		}
	}
})();

let savePromptCountdown = null;
let savePromptTimeout = null;
let savePromptKeyboardHandler = null; // Store keyboard handler reference

/**
 * Show save prompt modal with countdown
 */
const showSavePrompt = () => {
	console.log('[Template] Showing save prompt');

	pauseGame();

	const modal = document.getElementById('savePromptModal');
	if (!modal) {
		console.warn('[Template] Save prompt modal not found');
		endSession("User ended session");
		return;
	}

	modal.style.display = 'flex';
	const countdownEl = document.getElementById('saveCountdown');
	let countdown = 10;

	// Update countdown display
	function updateCountdown() {
		if (countdownEl) {
			countdownEl.textContent = countdown.toString();
		}

		if (countdown <= 0) {
			// Timeout - discard progress
			console.log('[Template] Save prompt timeout - discarding progress');
			hideSavePrompt();
			endSession("User ended session");
			return;
		}

		countdown--;
		savePromptCountdown = setTimeout(updateCountdown, 1000);
	}

	// Start countdown
	updateCountdown();

	// Set timeout for auto-dismiss
	savePromptTimeout = setTimeout(() => {
		if (modal.style.display === 'flex') {
			console.log('[Template] Save prompt auto-dismissed after timeout');
			hideSavePrompt();
			endSession("User ended session");
		}
	}, 10000);

	// Set up button handlers
	const closeBtn = document.getElementById('saveCloseBtn');
	const yesBtn = document.getElementById('saveYesBtn');
	const noBtn = document.getElementById('saveNoBtn');

	// Function to resume game and close modal
	const resumeAndClose = function () {
		console.log('[Template] User closed save prompt - resuming game');
		hideSavePrompt();
		resumeGame();
		// Reset savePromptShown flag so ESC can be used again
		if (typeof window.savePromptShown !== 'undefined') {
			window.savePromptShown = false;
		}
	};

	// Close button handler (resume game)
	if (closeBtn) {
		closeBtn.setAttribute('tabindex', '0');
		closeBtn.onclick = resumeAndClose;
		// Also handle Enter/Space keys for accessibility
		closeBtn.onkeydown = function (e) {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				resumeAndClose();
			}
		};
	}

	// Keyboard navigation handler for joystick/arrow keys
	savePromptKeyboardHandler = function (e) {
		// Only handle if modal is visible
		if (modal.style.display !== 'flex') return;

		const focusableElements = [closeBtn, yesBtn, noBtn].filter(el => el !== null);
		const currentIndex = focusableElements.indexOf(document.activeElement);

		// Arrow key navigation (for joystick)
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			let nextIndex;
			if (e.key === 'ArrowLeft') {
				nextIndex = currentIndex > 0 ? currentIndex - 1 : focusableElements.length - 1;
			} else {
				nextIndex = currentIndex < focusableElements.length - 1 ? currentIndex + 1 : 0;
			}
			focusableElements[nextIndex].focus();
		}
		// Tab navigation (standard keyboard)
		else if (e.key === 'Tab') {
			// Let default Tab behavior work, but ensure focus stays within modal
			const lastElement = focusableElements[focusableElements.length - 1];
			const firstElement = focusableElements[0];

			if (e.shiftKey && document.activeElement === firstElement) {
				e.preventDefault();
				lastElement.focus();
			} else if (!e.shiftKey && document.activeElement === lastElement) {
				e.preventDefault();
				firstElement.focus();
			}
		}
		// Enter/Space to activate focused button
		else if (e.key === 'Enter' || e.key === ' ') {
			if (document.activeElement === closeBtn) {
				e.preventDefault();
				resumeAndClose();
			} else if (document.activeElement === yesBtn) {
				e.preventDefault();
				yesBtn.click();
			} else if (document.activeElement === noBtn) {
				e.preventDefault();
				noBtn.click();
			}
		}
		// ESC to close (same as X button)
		else if (e.key === 'Escape') {
			e.preventDefault();
			resumeAndClose();
		}
	};

	// Add keyboard event listener to modal
	modal.addEventListener('keydown', savePromptKeyboardHandler);

	// Focus first button when modal opens
	setTimeout(() => {
		if (closeBtn) {
			closeBtn.focus();
		} else if (yesBtn) {
			yesBtn.focus();
		}
	}, 100);

	if (yesBtn) {
		yesBtn.onclick = function () {
			console.log('[Template] User chose to save');
			hideSavePrompt();

			// Save and then end session (force save even if auto-save is disabled)
			saveStateToBackend(true)
				.then(() => {
					console.log('[Template] Game state saved successfully');
					endSession("User ended session");
				})
				.catch((error) => {
					console.error('[Template] Error saving game state:', error);
					// Still end session even if save failed
					endSession("User ended session");
				});
		};
		// Also handle Enter/Space keys for accessibility
		yesBtn.onkeydown = function (e) {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				yesBtn.click();
			}
		};
	}

	if (noBtn) {
		noBtn.onclick = function () {
			console.log('[Template] User chose to discard');
			hideSavePrompt();
			endSession("User ended session");
		};
		// Also handle Enter/Space keys for accessibility
		noBtn.onkeydown = function (e) {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				noBtn.click();
			}
		};
	}
};

/**
 * Hide save prompt modal
 */
const hideSavePrompt = () => {
	const modal = document.getElementById('savePromptModal');
	if (modal) {
		modal.style.display = 'none';
		// Remove keyboard event listener if it exists
		if (savePromptKeyboardHandler) {
			modal.removeEventListener('keydown', savePromptKeyboardHandler);
			savePromptKeyboardHandler = null;
		}
	}

	// Clear countdown and timeout
	if (savePromptCountdown) {
		clearTimeout(savePromptCountdown);
		savePromptCountdown = null;
	}
	if (savePromptTimeout) {
		clearTimeout(savePromptTimeout);
		savePromptTimeout = null;
	}

	// Reset savePromptShown flag when save prompt is hidden (user made a choice)
	if (typeof window.savePromptShown !== 'undefined') {
		window.savePromptShown = false;
	}
};

// Make showSavePrompt and saveStateToBackend available globally for Electron app integration
window.showSavePrompt = showSavePrompt;
window.saveStateToBackend = saveStateToBackend;
window.endSession = endSession;

// ============================================
// GAME INITIALIZATION (MODIFIED)
// ============================================

// EmulatorJS callbacks
const initGame = async () => {
	gameLoaded = true;
	storeEmulator();

	// Wait for token to be available (with timeout) before loading state
	// This ensures authenticated requests can be made if token arrives via message
	const maxWaitTime = 2000; // Wait up to 2 seconds for token
	const checkInterval = 100; // Check every 100ms
	let waited = 0;

	while (!gameToken && waited < maxWaitTime) {
		await new Promise(resolve => setTimeout(resolve, checkInterval));
		waited += checkInterval;
	}

	// Try to load saved state before starting timer
	const savedState = await loadStateFromBackend();
	if (savedState) {
		try {
			const emulator = getEmulator();
			if (emulator && emulator.gameManager) {
				log("Restoring saved state...");
				// Use loadState() with Uint8Array
				emulator.gameManager.loadState(savedState);
				log("State restored!");
			}
		} catch (error) {
			console.error("[AutoSave] Failed to restore state:", error);
			log("Starting fresh game instead");
		}
	}

	startGameTimer();
	//startAutoSave(); //Disabled because user can choose to save at end.
};

EJS_onGameStart = initGame;
EJS_onLoadState = initGame;

// Hook into manual saves - when user presses save button in emulator
//EJS_onSaveUpdate = function (event) {
//	if (AUTO_SAVE_CONFIG.enabled) {
//		saveStateToBackend();
//	}
//};

// Fallback function to detect when game is ready
const checkGameReady = () => {
	// Look for canvas element and check if it has content
	const canvas = document.querySelector("#game canvas");
	if (canvas && canvas.width > 0 && canvas.height > 0) {
		if (!gameLoaded) {
			gameLoaded = true;
			storeEmulator();
			startGameTimer();
		}
		return true;
	}
	return false;
};

// Timer functions
const updateTimerDisplay = () => {
	if (!GAME_TIMER_SECONDS) {
		timerOverlay.style.display = "none";
		return;
	}
	timerOverlay.style.display = "block";
	const minutes = Math.floor(gameTimer / 60);
	const seconds = gameTimer % 60;
	timerOverlay.textContent = `Time Remaining: ${minutes}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

// Universal end trigger (timer expiry & game-specific death logic)
const inGameTrx = () => {
	pauseGame();
	if (typeof showSavePrompt === 'function') {
		showSavePrompt();
	} else {
		// Fallback if showSavePrompt is not available
		if (window.parent !== window) {
			window.parent.postMessage({ type: 'session_options' }, '*');
		}
	}
};
window.inGameTrx = inGameTrx;

// Backwards compatibility: timer path previously used handleTimerExpired
const handleTimerExpired = inGameTrx;

const startGameTimer = () => {
	if (!GAME_TIMER_SECONDS || timerStarted) return;

	timerStarted = true;
	timerInterval = setInterval(() => {
		gameTimer--;
		updateTimerDisplay();

		if (gameTimer <= WARNING_THRESHOLD) {
			timerOverlay.classList.add("warning");
		}

		if (gameTimer <= 0) {
			clearInterval(timerInterval);
			timerInterval = null;
			timerStarted = false;
			inGameTrx();
		}
	}, 1000);
};

const resetTimer = () => {
	if (!GAME_TIMER_SECONDS) return;

	// Clear any existing timer interval to prevent multiple intervals
	if (timerInterval) {
		clearInterval(timerInterval);
		timerInterval = null;
	}

	// Reset all timer state
	gameTimer = GAME_TIMER_SECONDS;
	timerStarted = false;

	// Remove warning styling
	if (timerOverlay) {
		timerOverlay.classList.remove("warning");
	}

	// Update display and restart timer
	updateTimerDisplay();
	startGameTimer();
};

// Game control functions
const pauseGame = () => {
	const emulator = getEmulator();
	if (emulator?.pause) {
		emulator.pause();
		return true;
	}
	storeEmulator();
	const retryEmulator = getEmulator();
	if (retryEmulator?.pause) {
		retryEmulator.pause();
		return true;
	}
	return false;
};

const resumeGame = () => {
	const emulator = getEmulator();

	if (!emulator) {
		storeEmulator();
		const retryEmulator = getEmulator();
		if (!retryEmulator) {
			console.error("Failed to get emulator for resume");
			return false;
		}
		return resumeGame();
	}

	if (typeof emulator.play === "function") {
		emulator.play();
		return true;
	}

	if (typeof emulator.start === "function") {
		emulator.start();
		return true;
	}

	if ("paused" in emulator) {
		emulator.paused = false;
		return true;
	}

	if (typeof emulator.resume === "function") {
		emulator.resume();
		return true;
	}

	console.error("No resume method found on emulator");
	return false;
};

const restartGame = () => window.location.reload();

// Token management
const getGameToken = () => {
	const urlParams = new URLSearchParams(window.location.search);
	let token = urlParams.get("token");

	if (!token) {
		// Try to get token from parent window message
		window.addEventListener("message", function (event) {
			if (event.data && event.data.jwt) {
				token = event.data.jwt;
				gameToken = token;
				initializeWebSocket();
			}
		});
	} else {
		gameToken = token;
		initializeWebSocket();
	}

	return token;
};

// WebSocket initialization
const initializeWebSocket = () => {
	if (!gameToken) {
		console.error("No game token available");
		return;
	}

	// Get the parent window's origin for WebSocket connection
	let serverHost;
	try {
		serverHost = window.parent.location.host;
	} catch (e) {
		// Fallback: extract from referrer or use default
		if (document.referrer) {
			const referrerUrl = new URL(document.referrer);
			serverHost = referrerUrl.host;
		} else {
			serverHost = window.location.hostname + ":8080";
		}
	}

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${protocol}//${serverHost}/ws?token=${gameToken}`;

	websocket = new WebSocket(wsUrl);

	websocket.onopen = function (event) {
		startHealthCheck();
	};

	websocket.onmessage = function (event) {
		const message = JSON.parse(event.data);
		handleWebSocketMessage(message);
	};

	websocket.onclose = function (event) {
		// Only count failures after game has loaded
		if (gameLoaded) {
			healthCheckFailures++;

			if (healthCheckFailures >= maxHealthCheckFailures) {
				endSession("Connection lost");
				return;
			}
		}

		if (isGameActive) {
			// Try to reconnect after 5 seconds
			setTimeout(initializeWebSocket, 5000);
		}
	};

	websocket.onerror = function (error) {
		// Only count failures after game has loaded
		if (gameLoaded) {
			healthCheckFailures++;

			if (healthCheckFailures >= maxHealthCheckFailures) {
				endSession("Connection error");
			}
		}
	};
};

// Handle WebSocket messages
const handleWebSocketMessage = (message) => {
	switch (message.type) {
		case "health_status_check_response":
			// Reset health check failures on successful response
			healthCheckFailures = 0;
			break;
	}
};

// Send WebSocket message
const sendWebSocketMessage = (type, payload = null) => {
	if (websocket && websocket.readyState === WebSocket.OPEN) {
		const message = {
			msgver: "1",
			type: type,
			ts: new Date().toISOString(),
			status: 200,
		};

		// Only include payload if it's not null
		if (payload !== null) {
			message.payload = payload;
		}

		websocket.send(JSON.stringify(message));
	}
};

// Start health check
const startHealthCheck = () => {
	healthCheckInterval = setInterval(function () {
		if (isGameActive) {
			sendWebSocketMessage("health_status_check", {});
		}
	}, 30000); // Send health check every 30 seconds
};

// End session with reason (MODIFIED - removed auto-save, user chooses to save)
async function endSession(reason) {
	console.trace('[endSession] Called with reason:', reason);
	isGameActive = false;

	// REMOVED: await saveStateToBackend();
	// User will have already chosen to save or not via the save prompt

	clearInterval(timerInterval);
	clearInterval(healthCheckInterval);
	stopAutoSave();

	if (websocket) {
		websocket.close();
	}

	// Send message to parent window to redirect
	if (window.parent !== window) {
		window.parent.postMessage({ type: "session_end", reason: reason }, "*");
	} else if (window.electronAPI && window.electronAPI.returnToArcade) {
		// Electron app - use returnToArcade
		window.electronAPI.returnToArcade();
	} else {
		// Fallback for web browser
		window.location.href = "/selectGame";
	}
}

// Message handlers
const handleMessage = (event) => {
	if (!event.data) return;

	// Handle JWT token
	if (event.data.jwt) {
		gameToken = event.data.jwt;
		if (!websocket || websocket.readyState !== WebSocket.OPEN) {
			initializeWebSocket();
		}
	}

	// Handle action messages
	const { action } = event.data;
	if (!action) return;

	const actions = {
		end: () => {
			// Show save prompt before ending
			if (typeof showSavePrompt === 'function') {
				showSavePrompt();
			} else {
				endSession("User ended session");
			}
		},
		continue: () => {
			// Hide save prompt if it's showing (after successful payment)
			if (typeof hideSavePrompt === 'function') {
				hideSavePrompt();
			}
			resetTimer();
			resumeGame();
		},
		restart: restartGame,
	};

	const handler = actions[action];
	if (handler) {
		handler();
	}
};

// Initialize
window.addEventListener("message", handleMessage);

// Intercept Escape key / physical back button (via navigate-back message or history.back())
// Use window property so it's accessible from wrapped hideSavePrompt
window.savePromptShown = false;

// Intercept window.history.back() calls (triggered by Escape/physical back button)
const originalHistoryBack = window.history.back;
window.history.back = function () {
	if (isGameActive && gameLoaded && !window.savePromptShown) {
		console.log('[Template] Back navigation intercepted - showing save prompt');
		// Show save prompt instead of navigating
		if (typeof showSavePrompt === 'function') {
			window.savePromptShown = true;
			showSavePrompt();
			// Don't call originalHistoryBack() - user will navigate after making choice
			return;
		}
	}
	// If save prompt not available or game not loaded, proceed with normal navigation
	originalHistoryBack.call(window.history);
};

// Intercept page unload to show save prompt (fallback for browser scenarios)
// Note: beforeunload is less reliable in Electron, but useful as a fallback
window.addEventListener("beforeunload", (event) => {
	// Only intercept if game is active and has been loaded, and save prompt hasn't been shown
	if (isGameActive && gameLoaded && !window.savePromptShown) {
		// In Electron, window.history.back() interception handles most cases
		// This is mainly a fallback for browser-based scenarios
		if (typeof showSavePrompt === 'function' && !window.electronAPI) {
			// Only use beforeunload in non-Electron environments
			event.preventDefault();
			event.returnValue = ''; // Required for Chrome
			window.savePromptShown = true;
			showSavePrompt();
			return '';
		}
	}
	// Always stop auto-save on unload
	stopAutoSave();
});

// Listen for navigate-back messages from parent window (Escape key / physical back button)
// Note: This is a fallback - the preload script typically calls window.history.back() directly,
// which is intercepted above. This listener handles cases where a message is sent instead.
window.addEventListener("message", (event) => {
	// Check if this is a navigate-back message (could come from parent window)
	if (event.data && (event.data === 'navigate-back' || event.data.type === 'navigate-back')) {
		if (isGameActive && gameLoaded && !window.savePromptShown) {
			console.log('[Template] Navigate-back message received - showing save prompt');
			if (typeof showSavePrompt === 'function') {
				window.savePromptShown = true;
				showSavePrompt();
			}
		}
	}
});

// Direct ESC key handler for save prompt (more reliable than history.back interception)
document.addEventListener('keydown', function (e) {
	// Only handle ESC key
	if (e.key !== 'Escape' || e.defaultPrevented) {
		return;
	}

	// Check if modal is currently visible - if so, let the modal handle ESC
	const saveModal = document.getElementById('savePromptModal');
	if (saveModal && saveModal.style.display === 'flex') {
		// Modal is open - let its keyboard handler deal with ESC
		return;
	}

	// Check if we're in a game context and save prompt isn't already shown
	if (isGameActive && gameLoaded && !window.savePromptShown) {
		// Check if we're not already in a modal
		const paymentModal = document.getElementById('paymentModal');

		if (!paymentModal || paymentModal.style.display === 'none') {
			console.log('[Template] ESC key pressed - showing save prompt');
			e.preventDefault();
			e.stopPropagation();
			window.savePromptShown = true;
			showSavePrompt();
		}
	}
}, true); // Use capture phase to catch before other handlers

// Initialize
const initialize = () => {
	updateTimerDisplay();
	getGameToken();
};

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", initialize);
} else {
	initialize();
}
